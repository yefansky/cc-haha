import { describe, expect, it } from 'vitest'
import { solveWorkspaceAlignment } from './workspaceAlignmentSolver'
import { prepareWorkspaceComparisonInputs } from './workspaceComparisonLanguage'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'

const lines = (values: string[]) => values.map((text, index) => ({
  text,
  ending: index === values.length - 1 ? '' : '\n',
  comparisonEnding: index === values.length - 1 ? '' : '\n',
  lineNumber: index + 1,
  equivalenceKey: text,
  tokens: [],
}))

describe('workspaceAlignmentSolver', () => {
  it.each(['balanced', 'precise'] as const)('keeps a similar function together across repeated blank lines (%s)', (profile) => {
    const body = Array.from({ length: 18 }, (_, i) => `    validate_argument_${i}(value, label)`)
    const left = lines(['before', '', 'def validate_path(value):', ...body, '', '', 'after'])
    const right = lines(['before', 'def validate_path(value, label):', ...body.map((line) => `${line} # checked`), '', '', 'after'])
    const result = solveWorkspaceAlignment(left, right, [], profile)
    expect(result.pairs.find((pair) => pair.leftIndex === 2)?.rightIndex).toBe(1)
    for (let i = 0; i < body.length; i += 1) {
      expect(result.pairs.find((pair) => pair.leftIndex === i + 3)?.rightIndex).toBe(i + 2)
    }
  })

  it.each(['balanced', 'precise'] as const)('does not anchor a changed code block to a repeated closing brace (%s)', (profile) => {
    const left = lines(['header', '}', 'function validate(value) {', '  return check(value);', '}', 'tail'])
    const right = lines(['header', 'function validate(value, label) {', '  return check(value, label);', '}', 'tail'])
    const result = solveWorkspaceAlignment(left, right, [], profile)
    expect(result.pairs.find((pair) => pair.leftIndex === 2)?.rightIndex).toBe(1)
    expect(result.pairs.find((pair) => pair.leftIndex === 3)?.rightIndex).toBe(2)
    expect(result.pairs.filter((pair) => pair.leftIndex !== null).map((pair) => pair.leftIndex)).toEqual(left.map((_, i) => i))
    expect(result.pairs.filter((pair) => pair.rightIndex !== null).map((pair) => pair.rightIndex)).toEqual(right.map((_, i) => i))
  })

  it.each(['balanced', 'precise'] as const)('keeps identical function text aligned when line endings change (%s)', (profile) => {
    const body = ['def validate_path(value, label):', '    if invalid(value):', '        raise ValueError(label)',
      '    try:', '        encoded = value.encode("gbk")', '    except UnicodeEncodeError:',
      '        raise ValueError(label)', '    if encoded.decode("gbk") != value:', '        raise ValueError(label)']
    const left = lines(['header', '', ...body, '', '', 'tail'])
    const right = lines(['header', 'inserted', ...body, '', '', 'tail'])
    left.forEach((line) => { if (line.ending) { line.ending = '\r\n'; line.comparisonEnding = '\r\n' } })
    const result = solveWorkspaceAlignment(left, right, [], profile)
    for (let i = 0; i < body.length; i += 1) {
      expect(result.pairs.find((pair) => pair.leftIndex === i + 2)?.rightIndex).toBe(i + 2)
    }
  })

  it('uses genuinely different fast and balanced candidate strategies', () => {
    const left = lines(['header', 'const answer = 41;', 'tail'])
    const right = lines(['header', 'inserted', 'const answer = 42;', 'tail'])
    const fast = solveWorkspaceAlignment(left, right, [], 'fast')
    const balanced = solveWorkspaceAlignment(left, right, [], 'balanced')
    expect(fast.pairs).not.toEqual(balanced.pairs)
    expect(balanced.pairs).toContainEqual(expect.objectContaining({ leftIndex: 1, rightIndex: 2, soft: true }))
  })

  it('keeps hard anchors paired and prevents candidates from crossing them for every profile', () => {
    for (const profile of ['fast', 'balanced', 'precise'] as const) {
      const result = solveWorkspaceAlignment(
        lines(['a', 'left anchor', 'same']),
        lines(['same', 'right anchor', 'a']),
        [{ id: 'hard', leftIndex: 1, rightIndex: 1 }],
        profile,
      )
      expect(result.pairs).toContainEqual({ leftIndex: 1, rightIndex: 1, soft: false, hardAnchorId: 'hard' })
      const before = result.pairs.filter((pair) => pair.leftIndex !== null && pair.leftIndex < 1)
      const after = result.pairs.filter((pair) => pair.leftIndex !== null && pair.leftIndex > 1)
      expect(before.every((pair) => pair.rightIndex === null || pair.rightIndex < 1)).toBe(true)
      expect(after.every((pair) => pair.rightIndex === null || pair.rightIndex > 1)).toBe(true)
    }
  })

  it('falls back the whole hard-anchor interval to fast when work units overflow', () => {
    const left = lines(Array.from({ length: 20 }, (_, index) => `left ${index}`))
    const right = lines(Array.from({ length: 20 }, (_, index) => `right ${index}`))
    const result = solveWorkspaceAlignment(left, right, [], 'precise', { maxWorkUnits: 4 })
    const fast = solveWorkspaceAlignment(left, right, [], 'fast')
    expect(result.pairs).toEqual(fast.pairs)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedProfile: 'precise', effectiveProfile: 'fast', reason: 'work_unit_budget' }),
    ]))

    const boundedFast = solveWorkspaceAlignment(left, right, [], 'fast', { maxWorkUnits: 4 })
    expect(boundedFast.workUnits).toBe(4)
    expect(boundedFast.diagnostics).toContainEqual(expect.objectContaining({
      requestedProfile: 'fast', effectiveProfile: 'fast', reason: 'work_unit_budget', workUnits: 4,
    }))
  })

  it('uses token-weighted bounded DP in precise instead of balanced raw-text beam scoring', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.cpp')
    const prepared = prepareWorkspaceComparisonInputs(
      'int calculate(int value);',
      '// int calculate(int value);\nint compute(int value);',
      settings,
    )
    const balanced = solveWorkspaceAlignment(prepared.left, prepared.right, [], 'balanced')
    const precise = solveWorkspaceAlignment(prepared.left, prepared.right, [], 'precise')
    expect(balanced.pairs.find((pair) => pair.leftIndex === 0)?.rightIndex).toBe(0)
    expect(precise.pairs.find((pair) => pair.leftIndex === 0)?.rightIndex).toBe(1)
  })

  it('keeps the 20k repeated-block move in balanced without fallback or ordinal-only output', () => {
    const leftValues = Array.from(
      { length: 20_000 },
      (_, index) => `template ${index % 50} block ${Math.floor(index / 50)}`,
    )
    const rightValues = [
      ...leftValues.slice(0, 5_000),
      ...leftValues.slice(5_400, 5_800).map((value) => `${value} light`),
      ...leftValues.slice(5_000, 5_400),
      ...leftValues.slice(5_800),
    ]
    const result = solveWorkspaceAlignment(lines(leftValues), lines(rightValues), [], 'balanced')
    const paired = result.pairs.filter((pair): pair is typeof pair & { leftIndex: number; rightIndex: number } => (
      pair.leftIndex !== null && pair.rightIndex !== null
    ))

    expect(result.workUnits).toBeLessThanOrEqual(4_000_000)
    expect(result.diagnostics).toEqual([expect.objectContaining({
      requestedProfile: 'balanced', effectiveProfile: 'balanced',
    })])
    expect(result.diagnostics[0]!.reason).toBeUndefined()
    expect(result.pairs.some((pair) => pair.soft && pair.leftIndex !== pair.rightIndex)).toBe(true)
    expect(paired.every((pair, index) => index === 0 || (
      pair.leftIndex > paired[index - 1]!.leftIndex
      && pair.rightIndex > paired[index - 1]!.rightIndex
    ))).toBe(true)
  })
})
