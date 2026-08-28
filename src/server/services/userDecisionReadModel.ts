import {
  attachRuntime,
  createUserDecision,
  detachRuntime,
  markDecisionAnswered,
  type UserDecision,
  type UserDecisionResponse,
} from '../userDecision.js'
import { normalizeAskUserQuestionToolResult } from '../askUserQuestionResult.js'
import {
  ASK_USER_QUESTION_CLARIFY_MESSAGE,
  ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX,
} from '../../constants/messages.js'
import { isDeepStrictEqual } from 'node:util'
import type { PendingPermissionRequest } from './conversationService.js'
import type { MessageEntry } from './sessionService.js'

const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export type UserDecisionInputSource = 'transcript' | 'live'

export type UserDecisionReadEntry = {
  decision: UserDecision
  input: Record<string, unknown>
  inputSource: UserDecisionInputSource
  conflicted: boolean
  description?: string
}

export type SessionUserDecisionSnapshot = {
  sessionId: string
  transcriptEvidenceComplete: boolean
  decisions: UserDecisionReadEntry[]
}

export type ProjectUserDecisionsInput = {
  sessionId: string
  messages: readonly MessageEntry[]
  pendingRequests: readonly PendingPermissionRequest[]
  transcriptEvidenceComplete: boolean
}

type MutableReadEntry = {
  decision: UserDecision
  input: Record<string, unknown>
  inputSource: UserDecisionInputSource
  conflicted: boolean
  description?: string
}

type PendingCandidateGroup = {
  pendingRequests: PendingPermissionRequest[]
  candidateIds: Set<string>
}

export function projectUserDecisions(
  input: ProjectUserDecisionsInput,
): SessionUserDecisionSnapshot {
  const decisions = new Map<string, MutableReadEntry>()
  const transcriptDecisionIdsByOriginalId = new Map<string, Set<string>>()
  const originalAliasesByDecisionId = new Map<string, Set<string>>()

  for (const message of input.messages) {
    for (const block of contentBlocks(message.content)) {
      if (
        block.type !== 'tool_use' ||
        block.name !== ASK_USER_QUESTION_TOOL_NAME ||
        typeof block.id !== 'string' ||
        !block.id.trim()
      ) {
        continue
      }

      const decisionId = block.id
      const existing = decisions.get(decisionId)
      const transcriptInput = isRecord(block.input) ? block.input : {}
      const originalAlias = (
        typeof block.original_tool_use_id === 'string' &&
        block.original_tool_use_id.trim()
      ) ? block.original_tool_use_id.trim() : null
      if (originalAlias) {
        const candidates = transcriptDecisionIdsByOriginalId.get(originalAlias) ??
          new Set<string>()
        candidates.add(decisionId)
        transcriptDecisionIdsByOriginalId.set(originalAlias, candidates)

        const aliases = originalAliasesByDecisionId.get(decisionId) ?? new Set<string>()
        aliases.add(originalAlias)
        originalAliasesByDecisionId.set(decisionId, aliases)
      }
      if (existing) {
        if (!isDeepStrictEqual(existing.input, transcriptInput)) existing.conflicted = true
        if ((originalAliasesByDecisionId.get(decisionId)?.size ?? 0) > 1) {
          existing.conflicted = true
        }
        continue
      }
      decisions.set(decisionId, {
        decision: createUserDecision({ decisionId }),
        input: transcriptInput,
        inputSource: 'transcript',
        conflicted: (originalAliasesByDecisionId.get(decisionId)?.size ?? 0) > 1,
      })
    }
  }

  const pendingRequestsByToolUseId = new Map<string, PendingPermissionRequest[]>()
  for (const pending of input.pendingRequests) {
    if (
      pending.toolName !== ASK_USER_QUESTION_TOOL_NAME ||
      typeof pending.toolUseId !== 'string' ||
      !pending.toolUseId.trim()
    ) {
      continue
    }
    const requests = pendingRequestsByToolUseId.get(pending.toolUseId) ?? []
    requests.push(pending)
    pendingRequestsByToolUseId.set(pending.toolUseId, requests)
  }

  const candidateGroups: PendingCandidateGroup[] = []
  for (const [toolUseId, pendingRequests] of pendingRequestsByToolUseId) {
    const candidateIds = new Set<string>()
    if (decisions.has(toolUseId)) candidateIds.add(toolUseId)
    for (const candidateId of transcriptDecisionIdsByOriginalId.get(toolUseId) ?? []) {
      candidateIds.add(candidateId)
    }

    if (candidateIds.size === 0) {
      if (pendingRequests.length !== 1) continue
      const firstPending = pendingRequests[0]!
      decisions.set(toolUseId, {
        decision: createUserDecision({ decisionId: toolUseId }),
        input: firstPending.input,
        inputSource: 'live',
        conflicted: false,
        ...(firstPending.description ? { description: firstPending.description } : {}),
      })
      candidateIds.add(toolUseId)
    }
    candidateGroups.push({ pendingRequests, candidateIds })
  }

  const pendingGroupCountByDecisionId = new Map<string, number>()
  for (const { candidateIds } of candidateGroups) {
    for (const candidateId of candidateIds) {
      pendingGroupCountByDecisionId.set(
        candidateId,
        (pendingGroupCountByDecisionId.get(candidateId) ?? 0) + 1,
      )
    }
  }

  for (const { pendingRequests, candidateIds } of candidateGroups) {
    const onlyCandidateId = candidateIds.size === 1
      ? candidateIds.values().next().value
      : undefined
    const canAttach = Boolean(
      onlyCandidateId &&
      pendingRequests.length === 1 &&
      pendingGroupCountByDecisionId.get(onlyCandidateId) === 1 &&
      decisions.get(onlyCandidateId)?.conflicted === false,
    )
    for (const candidateId of candidateIds) {
      const existing = decisions.get(candidateId)!
      existing.decision = canAttach
        ? attachRuntime(existing.decision, pendingRequests[0]!.requestId)
        : detachRuntime(existing.decision)
      if (canAttach && pendingRequests[0]!.description) {
        existing.description = pendingRequests[0]!.description
      }
    }
  }

  for (const message of input.messages) {
    const resultBlocks = contentBlocks(message.content).filter(
      (block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string',
    )
    const messageToolUseResult = resultBlocks.length === 1
      ? message.toolUseResult
      : undefined
    for (const block of resultBlocks) {
      if (
        typeof block.tool_use_id !== 'string'
      ) {
        continue
      }

      const existing = decisions.get(block.tool_use_id)
      if (!existing) continue
      if (block.is_error === true) {
        existing.decision = detachRuntime(existing.decision)
        const clarifyResponse = clarificationResponse(toolResultText(block.content))
        if (clarifyResponse) {
          existing.decision = markDecisionAnswered(existing.decision, clarifyResponse)
        }
        continue
      }
      const response = responseFromSuccessfulToolResult(
        block.content,
        messageToolUseResult,
      )
      existing.decision = markDecisionAnswered(
        detachRuntime(existing.decision),
        response,
      )
    }
  }

  return {
    sessionId: input.sessionId,
    transcriptEvidenceComplete: input.transcriptEvidenceComplete,
    decisions: [...decisions.values()],
  }
}

function responseFromSuccessfulToolResult(
  content: unknown,
  toolUseResult: unknown,
): UserDecisionResponse | null {
  const normalized = normalizeAskUserQuestionToolResult(content, toolUseResult)
  if (isRecord(normalized) && isRecord(normalized.answers)) {
    const answers = Object.fromEntries(
      Object.entries(normalized.answers).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
    return { kind: 'answer', answers }
  }
  return clarificationResponse(toolResultText(content))
}

function clarificationResponse(text: string): UserDecisionResponse | null {
  if (
    text !== ASK_USER_QUESTION_CLARIFY_MESSAGE &&
    !text.startsWith(ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX)
  ) {
    return null
  }
  return { kind: 'clarify', message: text }
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      if (typeof part === 'string') return [part]
      if (!isRecord(part) || typeof part.text !== 'string') return []
      return [part.text]
    })
    .join('\n')
    .trim()
}
