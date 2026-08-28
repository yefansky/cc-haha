import { useEffect, useMemo, useRef, useState } from 'react'
import {
  selectAskUserDecisionInteraction,
  selectAskUserDecisionProjection,
  useChatStore,
} from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'

type QuestionOption = {
  label: string
  description?: string
}

type Question = {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

type AskUserInput = {
  questions?: Question[]
  question?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

type Props = {
  sessionId?: string | null
  toolUseId: string
  input: unknown
  result?: unknown
  hasResult?: boolean
}

/**
 * Parse the AskUserQuestion input which may come in different shapes.
 */
function parseInput(input: unknown): Question[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as AskUserInput

  // Shape 1: { questions: [...] }
  if (Array.isArray(obj.questions)) {
    return obj.questions
  }

  // Shape 2: { question: "...", options: [...] }
  if (typeof obj.question === 'string') {
    return [{
      question: obj.question,
      header: obj.header,
      options: obj.options,
      multiSelect: obj.multiSelect,
    }]
  }

  return []
}

type QuestionSelections = Record<number, string[]>
type QuestionFreeTexts = Record<number, string>

function getSelectedAnswer(question: Question, selected: string[] | undefined) {
  if (!selected || selected.length === 0) return ''
  return question.multiSelect ? selected.join(', ') : selected[0] ?? ''
}

export function AskUserQuestion({ sessionId, toolUseId, input, result, hasResult = false }: Props) {
  const {
    respondToPermission,
    respondToUserDecision,
    resyncUserDecision,
  } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  const sessionState = useChatStore((s) => targetSessionId
    ? s.sessions[targetSessionId]
    : undefined)
  const decisionProjection = useMemo(
    () => selectAskUserDecisionProjection(sessionState),
    [sessionState],
  )
  const decisionView = decisionProjection.views.find((view) => view.toolUseId === toolUseId)
  const decision = decisionView?.source === 'server' ? decisionView.decision : null
  const effectiveInput = decision?.input ?? input
  const connectionSnapshotReady = sessionState?.connectionSnapshotReady === true
  const t = useTranslation()
  const questions = parseInput(effectiveInput)
  const inputObject = (effectiveInput && typeof effectiveInput === 'object')
    ? effectiveInput as Record<string, unknown>
    : {}
  const [activeTab, setActiveTab] = useState(0)
  const [selections, setSelections] = useState<QuestionSelections>({})
  const [freeTexts, setFreeTexts] = useState<QuestionFreeTexts>({})
  const [hasRequestedChat, setHasRequestedChat] = useState(false)
  const composingRef = useRef(false)
  const usesSemanticDecisionState = sessionState?.userDecisionSnapshot !== undefined
  const terminalDecision = decision?.semanticState.status !== undefined &&
    decision.semanticState.status !== 'open'
  const decisionResponse = terminalDecision ? decision.response : null
  const acceptRawResult = !usesSemanticDecisionState

  const resultAnswers = useMemo(() => {
    if (decisionResponse?.kind === 'answer') return decisionResponse.answers
    if (!acceptRawResult || !result || typeof result !== 'object') return {}
    const answers = (result as { answers?: unknown }).answers
    return answers && typeof answers === 'object'
      ? answers as Record<string, string>
      : {}
  }, [acceptRawResult, decisionResponse, result])
  const resultText = decisionResponse?.kind === 'clarify'
    ? decisionResponse.message
    : acceptRawResult && typeof result === 'string' && result.trim().length > 0
      ? result.trim()
      : ''
  const hasStructuredAnswers = Object.keys(resultAnswers).length > 0
  const hasTerminalResult = hasResult || hasStructuredAnswers || resultText.length > 0
  const pendingRequest = terminalDecision || hasResult || decision?.conflicted
    ? null
    : decisionView?.pendingRequest ?? null
  const localAttempt = sessionState?.userDecisionResponseAttempts?.[toolUseId]
  const deliveryState = decisionView?.deliveryState ?? localAttempt?.state
  const responseError = decisionView?.error ?? localAttempt?.error?.message
  const retryResponse = localAttempt?.response
  const projectedInteraction = selectAskUserDecisionInteraction(sessionState, toolUseId)
  const frozenResponseSummary = useMemo(() => {
    if (!retryResponse) return ''
    if (retryResponse.kind === 'clarify') return retryResponse.message.trim()
    return Object.values(retryResponse.answers)
      .map((answer) => answer.trim())
      .filter(Boolean)
      .join('; ')
  }, [retryResponse])

  useEffect(() => {
    if (hasRequestedChat && (
      projectedInteraction.mode === 'editing' ||
      projectedInteraction.mode === 'retryable'
    )) {
      setHasRequestedChat(false)
    }
  }, [hasRequestedChat, projectedInteraction.mode])

  const answeredText = useMemo(() => {
    if (hasStructuredAnswers) {
      return questions
        .map((question) => resultAnswers[question.question])
        .filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
        .join(', ')
    }
    if (resultText) return resultText
    return questions
      .map((question, index) => freeTexts[index]?.trim() || getSelectedAnswer(question, selections[index]))
      .filter(Boolean)
      .join('; ')
  }, [freeTexts, hasStructuredAnswers, questions, resultAnswers, resultText, selections])

  // Every hook above this line runs unconditionally, and it has to stay that way.
  // `input` is not fixed for the lifetime of the instance: chatStore rebuilds tool_use
  // messages from the transcript under a stable id (`${messageId}-block-${index}`), so
  // the same mounted component can see its question count cross zero in either
  // direction. With the early return above the useMemo calls, that transition threw
  // "Rendered fewer/more hooks than expected" and took the whole message list down.
  if (questions.length === 0) return null
  const safeActiveTab = Math.min(activeTab, questions.length - 1)
  const activeQuestion = questions[safeActiveTab]

  const submitted = hasTerminalResult && !pendingRequest
  const semanticallySubmitted = usesSemanticDecisionState
    ? projectedInteraction.mode === 'settled'
    : submitted
  const terminalWithoutAnswers = semanticallySubmitted &&
    !hasStructuredAnswers &&
    (resultText.length > 0 || hasResult || (terminalDecision && decisionResponse === null))
  const interaction = semanticallySubmitted
    ? { mode: 'settled' as const }
    : projectedInteraction
  const editing = interaction.mode === 'editing'
  const retryable = interaction.mode === 'retryable'
  const verifiable = interaction.mode === 'verifiable'
  const needsResync = interaction.mode === 'resync'
  const frozen = retryable || verifiable || needsResync || (
    interaction.mode === 'syncing' && interaction.frozen
  )
  const authoritativeHistory = decisionProjection.source === 'legacy' &&
    interaction.mode === 'blocked' &&
    connectionSnapshotReady
  const settled = semanticallySubmitted || interaction.mode === 'settled'
  const requestedChat = hasRequestedChat || decisionResponse?.kind === 'clarify'

  const handleSelect = (qIndex: number, label: string) => {
    if (!editing) return
    setSelections((prev) => {
      const question = questions[qIndex]
      const selected = prev[qIndex] ?? []
      if (question?.multiSelect) {
        const nextSelected = selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
        const next = { ...prev }
        if (nextSelected.length > 0) {
          next[qIndex] = nextSelected
        } else {
          delete next[qIndex]
        }
        return next
      }
      if (selected[0] === label) {
        const next = { ...prev }
        delete next[qIndex]
        return next
      }
      return { ...prev, [qIndex]: [label] }
    })
    setFreeTexts((prev) => {
      if (!prev[qIndex]) return prev
      const next = { ...prev }
      delete next[qIndex]
      return next
    })
  }

  const handleFreeTextChange = (qIndex: number, value: string) => {
    if (!editing) return
    setFreeTexts((prev) => {
      const next = { ...prev }
      if (value) {
        next[qIndex] = value
      } else {
        delete next[qIndex]
      }
      return next
    })
    if (value.trim()) {
      setSelections((prev) => {
        if (!prev[qIndex]) return prev
        const next = { ...prev }
        delete next[qIndex]
        return next
      })
    }
  }

  const handleSubmit = () => {
    if (semanticallySubmitted || !targetSessionId) return
    if (retryable && retryResponse) {
      respondToUserDecision(targetSessionId, toolUseId, retryResponse)
      return
    }
    if (verifiable && retryResponse) {
      respondToUserDecision(targetSessionId, toolUseId, retryResponse)
      return
    }
    if (needsResync) {
      resyncUserDecision(targetSessionId, toolUseId)
      return
    }
    if (!editing) return

    const parts: string[] = []
    for (let i = 0; i < questions.length; i++) {
      const answer = freeTexts[i]?.trim() || getSelectedAnswer(questions[i]!, selections[i])
      if (answer) parts.push(answer)
    }
    const response = parts.join('; ')
    if (!response) return

    const answers = questions.reduce<Record<string, string>>((acc, question, index) => {
      const freeText = freeTexts[index]?.trim()
      if (freeText) {
        acc[question.question] = freeText
      } else {
        const selected = getSelectedAnswer(question, selections[index])
        if (selected) acc[question.question] = selected
      }
      return acc
    }, {})

    const dispatchResult = interaction.channel === 'modern'
      ? respondToUserDecision(targetSessionId, toolUseId, { kind: 'answer', answers })
      : respondToPermission(targetSessionId, interaction.requestId, true, {
          updatedInput: {
            ...inputObject,
            answers,
          },
        })
    if (dispatchResult === 'dispatched') setHasRequestedChat(false)
  }

  /**
   * Hands the questions back to the model as a conversation instead of an
   * answer — the user doesn't think any option fits and wants to talk first.
   *
   * Travels as a denial because that's the only channel that carries free text
   * back to the model, but the server rewrites it (buildDenyMessage) into
   * "ask them what they'd like to clarify" rather than the usual "STOP and
   * wait". Deliberately not gated on `allAnswered`: not recognising your own
   * question in any of the options is exactly when nothing is filled in.
   */
  const handleChatAboutThis = () => {
    if (semanticallySubmitted || !targetSessionId || !editing) return

    // Carry whatever was already picked, so switching to a conversation isn't
    // punished by losing the partial answers.
    const questionsWithAnswers = questions
      .map((question, index) => {
        const answer = freeTexts[index]?.trim() || getSelectedAnswer(question, selections[index])
        return answer
          ? `- "${question.question}"\n  Answer: ${answer}`
          : `- "${question.question}"\n  (No answer provided)`
      })
      .join('\n')

    const dispatchResult = interaction.channel === 'modern'
      ? respondToUserDecision(targetSessionId, toolUseId, {
          kind: 'clarify',
          message: questionsWithAnswers,
        })
      : respondToPermission(targetSessionId, interaction.requestId, false, {
          denyMessage: questionsWithAnswers,
        })
    if (dispatchResult === 'dispatched') setHasRequestedChat(true)
  }

  // All questions must be answered (via selection or free text) to enable submit
  const allAnswered = questions.every((_, i) =>
    Boolean(freeTexts[i]?.trim()) || (selections[i]?.length ?? 0) > 0,
  )

  if (!activeQuestion) return null

  return (
    <div className={`mb-4 rounded-[var(--radius-lg)] border overflow-hidden ${
      settled
        ? 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] opacity-70'
        : 'border-[var(--color-secondary)] bg-[var(--color-surface-container-lowest)]'
    }`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${
        settled
          ? 'bg-[var(--color-surface-container-low)]'
          : 'bg-[var(--color-surface-container)]'
      }`}>
        <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-secondary-container)]">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-secondary)]">
            help
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('question.needsInput')}
          </span>
          {(semanticallySubmitted || authoritativeHistory) && (
            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]">
              {/* handing the question back is not an answer — saying "answered"
                  there misreports what the user did */}
              {t(requestedChat
                ? 'question.chatBadge'
                : terminalWithoutAnswers || authoritativeHistory
                  ? 'question.completed'
                  : 'question.answered')}
            </span>
          )}
        </div>
      </div>

      {/* Question tabs — horizontal tab bar (only show when multiple questions) */}
      {questions.length > 1 && (
        <div className="flex px-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-x-auto">
          {questions.map((q, i) => {
            const isActive = safeActiveTab === i
            const isAnswered = Boolean(freeTexts[i]?.trim()) || (selections[i]?.length ?? 0) > 0
            const tabLabel = q.header || `Q${i + 1}`
            return (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={`relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? 'text-[var(--color-secondary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {isAnswered && (
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]">check_circle</span>
                )}
                {tabLabel}
                {isActive && (
                  <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--color-secondary)] rounded-t" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Active question content */}
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[var(--color-text-primary)] mb-3">
          {activeQuestion.question}
        </p>

        {/* Option cards */}
        {activeQuestion.options && activeQuestion.options.length > 0 && (
          <div className="space-y-2 mb-3">
            {activeQuestion.options.map((opt, optIndex) => {
              const isSelected = selections[safeActiveTab]?.includes(opt.label) ?? false
              const isMultiSelect = activeQuestion.multiSelect === true
              return (
                <button
                  key={optIndex}
                  aria-pressed={isSelected}
                  onClick={() => handleSelect(safeActiveTab, opt.label)}
                  disabled={!editing}
                  className={`w-full text-left px-4 py-3 rounded-[var(--radius-md)] border transition-all duration-150 cursor-pointer ${
                    isSelected
                      ? 'border-[var(--color-secondary)] bg-[var(--color-secondary-container)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-container-low)]'
                  } ${!editing ? 'cursor-default' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Selection indicator */}
                    <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]'
                        : 'border-[var(--color-outline)]'
                    } ${isMultiSelect ? 'rounded-[var(--radius-xs)]' : 'rounded-full'}`}>
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className={`text-sm font-medium ${
                        isSelected
                          ? 'text-[var(--color-secondary)]'
                          : 'text-[var(--color-text-primary)]'
                      }`}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                          {opt.description}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Free text input */}
        {!settled && interaction.mode !== 'blocked' && interaction.mode !== 'syncing' && (
          <div>
            <label className="text-xs text-[var(--color-text-tertiary)] mb-1.5 block">
              {t('question.customResponse')}
            </label>
            <textarea
              value={freeTexts[safeActiveTab] ?? ''}
              disabled={!editing}
              onChange={(e) => handleFreeTextChange(safeActiveTab, e.target.value)}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={(e) => {
                if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && allAnswered && editing) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              placeholder={t('question.typePlaceholder')}
              rows={3}
              wrap="soft"
              className="max-h-48 min-h-[84px] w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:outline-none focus:shadow-[var(--shadow-focus-ring)]"
            />
          </div>
        )}

        {/* Submitted answer display — the chat handoff wins over any terminal
            result, whose text is the deny payload and not worth showing. */}
        {semanticallySubmitted && (requestedChat ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-secondary)]">forum</span>
            <span>{t('question.chatRequested')}</span>
          </div>
        ) : answeredText ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]">check_circle</span>
            <span>
              {t(terminalWithoutAnswers ? 'question.resultPrefix' : 'question.answeredPrefix')}<strong>{answeredText}</strong>
            </span>
          </div>
        ) : null)}
        {!semanticallySubmitted && responseError && (
          <p role="alert" className="mt-3 text-xs text-[var(--color-error)]">
            {responseError}
          </p>
        )}
        {!semanticallySubmitted && deliveryState && (
          <p role="status" className="mt-3 text-xs text-[var(--color-text-secondary)]">
            {interaction.mode === 'syncing' && frozen && (
              <span>{t('common.loading')} </span>
            )}
            {frozenResponseSummary && <strong>{frozenResponseSummary}</strong>}
          </p>
        )}
      </div>

      {/* Action bar. Wraps rather than overflows: two buttons plus a translated
          label (kr/jp run long) can outgrow a narrow side-by-side pane. */}
      {!settled && interaction.mode !== 'blocked' && interaction.mode !== 'syncing' && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <Button
            variant="primary"
            size="sm"
            disabled={editing && !allAnswered}
            onClick={handleSubmit}
            icon={
              <span className="material-symbols-outlined text-[14px]">send</span>
            }
          >
            {t(retryable
              ? 'common.retry'
              : verifiable
                ? 'question.verifyDelivery'
                : needsResync
                  ? 'question.resync'
                  : 'question.submit')}
          </Button>
          {editing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleChatAboutThis}
              title={t('question.chatAboutThisHint')}
              icon={
                <span className="material-symbols-outlined text-[14px]">forum</span>
              }
            >
              {t('question.chatAboutThis')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
