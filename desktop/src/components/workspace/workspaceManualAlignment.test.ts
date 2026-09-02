import { describe, expect, it } from 'vitest'
import {
  createManualAlignmentAnchor,
  rebaseManualAlignmentAnchors,
  validateManualAlignmentCandidate,
} from './workspaceManualAlignment'

describe('workspaceManualAlignment', () => {
  it('accepts strictly monotonic anchors and atomically rejects duplicate, crossing, stale, and invalid endpoints', () => {
    const left = 'a\nb\nc\nd\n'
    const right = 'a\nx\nc\ny\n'
    const first = createManualAlignmentAnchor('manual-anchor-1', left, right, 2, 2)
    const existing = [first]

    expect(validateManualAlignmentCandidate(existing, left, right, 3, 3, 7, 7)).toEqual({ state: 'ok' })
    expect(validateManualAlignmentCandidate(existing, left, right, 2, 3, 7, 7)).toMatchObject({ state: 'error', reason: 'duplicate' })
    expect(validateManualAlignmentCandidate(existing, left, right, 3, 1, 7, 7)).toMatchObject({ state: 'error', reason: 'crossing' })
    expect(validateManualAlignmentCandidate(existing, left, right, 5, 3, 7, 7)).toMatchObject({ state: 'error', reason: 'out_of_range' })
    expect(validateManualAlignmentCandidate(existing, left, right, 3, 3, 6, 7)).toMatchObject({ state: 'error', reason: 'stale_selection' })
  })

  it('relocates a uniquely preserved endpoint and fails closed for edits and duplicate signatures', () => {
    const left = 'head\nleft anchor\ntail\n'
    const right = 'head\nright anchor\ntail\n'
    const anchor = createManualAlignmentAnchor('manual-anchor-1', left, right, 2, 2)

    expect(rebaseManualAlignmentAnchors([anchor], 'left', left, `inserted\n${left}`)[0]).toMatchObject({
      id: 'manual-anchor-1',
      state: 'valid',
      left: { lineNumber: 3 },
      right: { lineNumber: 2 },
    })
    expect(rebaseManualAlignmentAnchors([anchor], 'left', left, 'head\nchanged\ntail\n')[0]).toMatchObject({
      state: 'stale',
      staleReason: 'line_changed',
    })

    const duplicate = createManualAlignmentAnchor(
      'manual-anchor-2',
      'p\ndup\nq\np\ndup\nq\n',
      right,
      2,
      2,
    )
    expect(rebaseManualAlignmentAnchors(
      [duplicate],
      'left',
      'p\ndup\nq\np\ndup\nq\n',
      'inserted\np\ndup\nq\np\ndup\nq\n',
    )[0]).toMatchObject({ state: 'stale', staleReason: 'ambiguous' })
  })
})
