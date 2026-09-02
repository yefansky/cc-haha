import type { PreparedWorkspaceComparisonLine } from './workspaceComparisonLanguage'
import type { WorkspaceComparisonProfile } from './workspaceComparisonSettings'

export interface WorkspaceAlignmentHardAnchor {
  id: string
  leftIndex: number
  rightIndex: number
}

export interface WorkspaceAlignmentPair {
  leftIndex: number | null
  rightIndex: number | null
  soft: boolean
  hardAnchorId?: string
}

export interface WorkspaceAlignmentDiagnostic {
  interval: number
  requestedProfile: WorkspaceComparisonProfile
  effectiveProfile: WorkspaceComparisonProfile
  reason?: 'work_unit_budget'
  workUnits: number
}

export interface WorkspaceAlignmentResult {
  pairs: WorkspaceAlignmentPair[]
  diagnostics: WorkspaceAlignmentDiagnostic[]
  workUnits: number
}

const PROFILE_LIMITS = {
  fast: { skew: 64, top: 1, threshold: 1, maxWorkUnits: 500_000 },
  balanced: { skew: 512, top: 8, threshold: 0.72, maxWorkUnits: 4_000_000 },
  precise: { skew: 2048, top: 32, threshold: 0.55, maxWorkUnits: 16_000_000 },
} as const

function exact(left: PreparedWorkspaceComparisonLine, right: PreparedWorkspaceComparisonLine) {
  return left.equivalenceKey === right.equivalenceKey && left.comparisonEnding === right.comparisonEnding
}

function trigrams(value: string) {
  const normalized = `  ${value}  `
  const values = new Set<string>()
  for (let index = 0; index + 3 <= normalized.length; index += 1) values.add(normalized.slice(index, index + 3))
  return values
}

function trigramSetSimilarity(left: Set<string>, right: Set<string>) {
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection += 1
  return (2 * intersection) / Math.max(1, left.size + right.size)
}

function trigramSimilarity(left: string, right: string) {
  if (left === right) return 1
  const leftSet = trigrams(left)
  const rightSet = trigrams(right)
  return trigramSetSimilarity(leftSet, rightSet)
}

function tokenSimilarity(
  left: PreparedWorkspaceComparisonLine,
  right: PreparedWorkspaceComparisonLine,
  textSimilarity: (left: string, right: string) => number = trigramSimilarity,
) {
  if (left.tokens.length === 0 || right.tokens.length === 0) return textSimilarity(left.text, right.text)
  const leftKinds = left.tokens.map((token) => `${token.scope}:${left.text.slice(token.start, token.end)}`)
  const rightKinds = new Set(right.tokens.map((token) => `${token.scope}:${right.text.slice(token.start, token.end)}`))
  const shared = leftKinds.filter((value) => rightKinds.has(value)).length
  return (2 * shared) / Math.max(1, leftKinds.length + rightKinds.size)
}

function fastInterval(
  left: PreparedWorkspaceComparisonLine[],
  right: PreparedWorkspaceComparisonLine[],
  leftOffset: number,
  rightOffset: number,
  maxWorkUnits: number = PROFILE_LIMITS.fast.maxWorkUnits,
): { pairs: WorkspaceAlignmentPair[]; workUnits: number; budgetExceeded: boolean } {
  const pairs: WorkspaceAlignmentPair[] = []
  let leftIndex = 0
  let rightIndex = 0
  let workUnits = 0
  const appendOrdinalRemainder = () => {
    const count = Math.max(left.length - leftIndex, right.length - rightIndex)
    for (let index = 0; index < count; index += 1) pairs.push({
      leftIndex: leftIndex + index < left.length ? leftOffset + leftIndex + index : null,
      rightIndex: rightIndex + index < right.length ? rightOffset + rightIndex + index : null,
      soft: false,
    })
  }
  while (leftIndex < left.length && rightIndex < right.length) {
    if (exact(left[leftIndex]!, right[rightIndex]!)) {
      pairs.push({ leftIndex: leftOffset + leftIndex++, rightIndex: rightOffset + rightIndex++, soft: false })
      continue
    }
    let rightMatch = -1
    let leftMatch = -1
    for (let offset = 1; offset <= PROFILE_LIMITS.fast.skew && rightIndex + offset < right.length; offset += 1) {
      workUnits += 1
      if (workUnits > maxWorkUnits) { appendOrdinalRemainder(); return { pairs, workUnits: maxWorkUnits, budgetExceeded: true } }
      if (exact(left[leftIndex]!, right[rightIndex + offset]!)) { rightMatch = offset; break }
    }
    for (let offset = 1; offset <= PROFILE_LIMITS.fast.skew && leftIndex + offset < left.length; offset += 1) {
      workUnits += 1
      if (workUnits > maxWorkUnits) { appendOrdinalRemainder(); return { pairs, workUnits: maxWorkUnits, budgetExceeded: true } }
      if (exact(left[leftIndex + offset]!, right[rightIndex]!)) { leftMatch = offset; break }
    }
    if (rightMatch >= 0 && (leftMatch < 0 || rightMatch <= leftMatch)) {
      for (let offset = 0; offset < rightMatch; offset += 1) {
        pairs.push({ leftIndex: null, rightIndex: rightOffset + rightIndex++, soft: false })
      }
    } else if (leftMatch >= 0) {
      for (let offset = 0; offset < leftMatch; offset += 1) {
        pairs.push({ leftIndex: leftOffset + leftIndex++, rightIndex: null, soft: false })
      }
    } else {
      pairs.push({ leftIndex: leftOffset + leftIndex++, rightIndex: rightOffset + rightIndex++, soft: false })
    }
  }
  while (leftIndex < left.length) pairs.push({ leftIndex: leftOffset + leftIndex++, rightIndex: null, soft: false })
  while (rightIndex < right.length) pairs.push({ leftIndex: null, rightIndex: rightOffset + rightIndex++, soft: false })
  return { pairs, workUnits, budgetExceeded: false }
}

interface Candidate { left: number; right: number; score: number }

function selectBalancedCandidates(candidates: Candidate[], leftLength: number, consumeWork: () => void) {
  let beam: Array<{ right: number; score: number; chain: Candidate[] }> = [{ right: -1, score: 0, chain: [] }]
  for (let leftIndex = 0; leftIndex < leftLength; leftIndex += 1) {
    const choices = candidates.filter((candidate) => candidate.left === leftIndex)
    const next = [...beam]
    for (const state of beam) {
      for (const candidate of choices) {
        consumeWork()
        if (candidate.right <= state.right) continue
        next.push({ right: candidate.right, score: state.score + candidate.score, chain: [...state.chain, candidate] })
      }
    }
    const bestByRight = new Map<number, { right: number; score: number; chain: Candidate[] }>()
    for (const state of next) {
      const previous = bestByRight.get(state.right)
      if (!previous || state.score > previous.score) bestByRight.set(state.right, state)
    }
    beam = [...bestByRight.values()]
      .sort((a, b) => b.score - a.score || a.right - b.right)
      .slice(0, 8)
  }
  return beam.sort((a, b) => b.score - a.score || a.right - b.right)[0]?.chain ?? []
}

function selectPreciseCandidates(candidates: Candidate[], consumeWork: () => void) {
  const ordered = [...candidates].sort((a, b) => a.left - b.left || a.right - b.right || b.score - a.score)
  const scores = ordered.map((candidate) => candidate.score)
  const previous = ordered.map(() => -1)
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index]!
    for (let before = index - 1; before >= 0; before -= 1) {
      const predecessor = ordered[before]!
      if (candidate.left - predecessor.left > 256) break
      consumeWork()
      if (predecessor.left >= candidate.left || predecessor.right >= candidate.right) continue
      const gapPenalty = Math.abs(
        (candidate.left - predecessor.left) - (candidate.right - predecessor.right),
      ) * 0.02
      const score = scores[before]! + candidate.score - gapPenalty
      if (score > scores[index]!) {
        scores[index] = score
        previous[index] = before
      }
    }
  }
  let cursor = scores.reduce((best, score, index) => score > scores[best]! ? index : best, 0)
  const selected: Candidate[] = []
  while (cursor >= 0 && ordered[cursor]) {
    selected.push(ordered[cursor]!)
    cursor = previous[cursor]!
  }
  return selected.reverse()
}

function softInterval(
  left: PreparedWorkspaceComparisonLine[],
  right: PreparedWorkspaceComparisonLine[],
  leftOffset: number,
  rightOffset: number,
  profile: 'balanced' | 'precise',
  maxWorkUnits: number,
) {
  const limits = PROFILE_LIMITS[profile]
  let workUnits = 0
  const candidates: Candidate[] = []
  const trigramCache = new Map<string, Set<string>>()
  const cachedTrigrams = (value: string) => {
    const cached = trigramCache.get(value)
    if (cached) return cached
    // Candidate comparisons are the primary work unit. Count the materialized
    // characters as well because building trigram sets was previously the
    // dominant unreported cost on repeated-block inputs.
    workUnits += Math.max(1, value.length + 2)
    if (workUnits > maxWorkUnits) throw Object.assign(new Error('work_unit_budget'), { workUnits })
    const created = trigrams(value)
    trigramCache.set(value, created)
    return created
  }
  const cachedTrigramSimilarity = (leftValue: string, rightValue: string) => {
    if (leftValue === rightValue) return 1
    return trigramSetSimilarity(cachedTrigrams(leftValue), cachedTrigrams(rightValue))
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const ranked: Candidate[] = []
    const projected = left.length <= 1 ? 0 : Math.round((leftIndex / (left.length - 1)) * Math.max(0, right.length - 1))
    const start = Math.max(0, projected - limits.skew)
    const end = Math.min(right.length, projected + limits.skew + 1)
    for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
      workUnits += 1
      if (workUnits > maxWorkUnits) throw Object.assign(new Error('work_unit_budget'), { workUnits })
      if (exact(left[leftIndex]!, right[rightIndex]!)) continue
      const score = profile === 'precise'
        ? 0.45 * cachedTrigramSimilarity(left[leftIndex]!.text, right[rightIndex]!.text)
          + 0.55 * tokenSimilarity(left[leftIndex]!, right[rightIndex]!, cachedTrigramSimilarity)
        : cachedTrigramSimilarity(left[leftIndex]!.text, right[rightIndex]!.text)
      if (score >= limits.threshold) ranked.push({ left: leftIndex, right: rightIndex, score })
    }
    ranked.sort((a, b) => b.score - a.score || Math.abs(a.right - projected) - Math.abs(b.right - projected) || a.right - b.right)
    candidates.push(...ranked.slice(0, limits.top))
  }

  const consumeSelectionWork = () => {
    workUnits += 1
    if (workUnits > maxWorkUnits) throw Object.assign(new Error('work_unit_budget'), { workUnits })
  }
  const selected = profile === 'balanced'
    ? selectBalancedCandidates(candidates, left.length, consumeSelectionWork)
    : selectPreciseCandidates(candidates, consumeSelectionWork)

  const pairs: WorkspaceAlignmentPair[] = []
  let leftCursor = 0
  let localRightCursor = 0
  for (const landmark of selected) {
    pairs.push(...fastInterval(
      left.slice(leftCursor, landmark.left),
      right.slice(localRightCursor, landmark.right),
      leftOffset + leftCursor,
      rightOffset + localRightCursor,
    ).pairs)
    pairs.push({ leftIndex: leftOffset + landmark.left, rightIndex: rightOffset + landmark.right, soft: true })
    leftCursor = landmark.left + 1
    localRightCursor = landmark.right + 1
  }
  pairs.push(...fastInterval(left.slice(leftCursor), right.slice(localRightCursor), leftOffset + leftCursor, rightOffset + localRightCursor).pairs)
  return { pairs, workUnits }
}

function advancedInterval(
  left: PreparedWorkspaceComparisonLine[],
  right: PreparedWorkspaceComparisonLine[],
  leftOffset: number,
  rightOffset: number,
  profile: 'balanced' | 'precise',
  maxWorkUnits: number,
) {
  const exactPairs = fastInterval(left, right, 0, 0).pairs.filter((pair) => (
    pair.leftIndex !== null
    && pair.rightIndex !== null
    && exact(left[pair.leftIndex]!, right[pair.rightIndex]!)
  ))
  const pairs: WorkspaceAlignmentPair[] = []
  let leftCursor = 0
  let rightCursor = 0
  let workUnits = 0
  for (const landmark of [...exactPairs, { leftIndex: left.length, rightIndex: right.length, soft: false }]) {
    const leftIndex = landmark.leftIndex!
    const rightIndex = landmark.rightIndex!
    const result = softInterval(
      left.slice(leftCursor, leftIndex),
      right.slice(rightCursor, rightIndex),
      leftOffset + leftCursor,
      rightOffset + rightCursor,
      profile,
      maxWorkUnits - workUnits,
    )
    workUnits += result.workUnits
    pairs.push(...result.pairs)
    if (leftIndex < left.length && rightIndex < right.length) {
      pairs.push({ leftIndex: leftOffset + leftIndex, rightIndex: rightOffset + rightIndex, soft: false })
      leftCursor = leftIndex + 1
      rightCursor = rightIndex + 1
    }
  }
  return { pairs, workUnits }
}

export function solveWorkspaceAlignment(
  left: PreparedWorkspaceComparisonLine[],
  right: PreparedWorkspaceComparisonLine[],
  hardAnchors: WorkspaceAlignmentHardAnchor[],
  profile: WorkspaceComparisonProfile,
  overrides: { maxWorkUnits?: number } = {},
): WorkspaceAlignmentResult {
  const validAnchors = hardAnchors
    .filter((anchor) => anchor.leftIndex >= 0 && anchor.leftIndex < left.length && anchor.rightIndex >= 0 && anchor.rightIndex < right.length)
    .sort((a, b) => a.leftIndex - b.leftIndex)
    .filter((anchor, index, anchors) => index === 0 || (
      anchors[index - 1]!.leftIndex < anchor.leftIndex && anchors[index - 1]!.rightIndex < anchor.rightIndex
    ))
  const pairs: WorkspaceAlignmentPair[] = []
  const diagnostics: WorkspaceAlignmentDiagnostic[] = []
  let workUnits = 0
  let leftCursor = 0
  let rightCursor = 0
  const boundaries = [...validAnchors, { id: '', leftIndex: left.length, rightIndex: right.length }]
  boundaries.forEach((anchor, interval) => {
    const intervalLeft = left.slice(leftCursor, anchor.leftIndex)
    const intervalRight = right.slice(rightCursor, anchor.rightIndex)
    if (profile === 'fast') {
      const result = fastInterval(intervalLeft, intervalRight, leftCursor, rightCursor, overrides.maxWorkUnits)
      pairs.push(...result.pairs)
      workUnits += result.workUnits
      diagnostics.push({
        interval,
        requestedProfile: profile,
        effectiveProfile: 'fast',
        ...(result.budgetExceeded ? { reason: 'work_unit_budget' as const } : {}),
        workUnits: result.workUnits,
      })
    } else {
      const maxWorkUnits = overrides.maxWorkUnits ?? PROFILE_LIMITS[profile].maxWorkUnits
      try {
        const result = advancedInterval(intervalLeft, intervalRight, leftCursor, rightCursor, profile, maxWorkUnits)
        pairs.push(...result.pairs)
        workUnits += result.workUnits
        diagnostics.push({ interval, requestedProfile: profile, effectiveProfile: profile, workUnits: result.workUnits })
      } catch (error) {
        const used = typeof (error as { workUnits?: unknown }).workUnits === 'number' ? (error as { workUnits: number }).workUnits : maxWorkUnits + 1
        workUnits += used
        const fallback = fastInterval(intervalLeft, intervalRight, leftCursor, rightCursor)
        pairs.push(...fallback.pairs)
        diagnostics.push({ interval, requestedProfile: profile, effectiveProfile: 'fast', reason: 'work_unit_budget', workUnits: used })
      }
    }
    if (anchor.id) {
      pairs.push({ leftIndex: anchor.leftIndex, rightIndex: anchor.rightIndex, soft: false, hardAnchorId: anchor.id })
      leftCursor = anchor.leftIndex + 1
      rightCursor = anchor.rightIndex + 1
    }
  })
  return { pairs, diagnostics, workUnits }
}
