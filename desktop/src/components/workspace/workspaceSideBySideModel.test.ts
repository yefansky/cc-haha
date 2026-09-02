import { describe, expect, it } from 'vitest'
import type { WorkspaceComparison, WorkspaceComparisonSide } from '@/api/sessions'
import {
  buildWorkspaceSideBySideModel,
  buildWorkspaceSideBySideTextPairModel,
  parseWorkspaceSideBySideDiff,
  projectWorkspaceSideBySideFile,
  summarizeWorkspaceSideBySideModel,
} from './workspaceSideBySideModel'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'

function side(
  content: string,
  overrides: Partial<WorkspaceComparisonSide> = {},
): WorkspaceComparisonSide {
  return {
    source: { kind: 'working_tree', path: 'src/a.ts', revision: 'working-tree' },
    exists: true,
    state: 'ok',
    content,
    requestedEncoding: 'auto',
    actualEncoding: 'utf8',
    bom: 'none',
    lineEnding: content.includes('\r\n') ? 'crlf' : content.includes('\n') ? 'lf' : 'none',
    writable: true,
    ...overrides,
  }
}

function comparison(left: WorkspaceComparisonSide, right: WorkspaceComparisonSide): WorkspaceComparison {
  return { schemaVersion: 1, left, right }
}

function changedRows(value: string) {
  return parseWorkspaceSideBySideDiff(value)[0]?.rows.filter((row) => row.kind === 'change') ?? []
}

describe('parseWorkspaceSideBySideDiff', () => {
  it('summarizes only non-context paired rows from the shared text-pair model', () => {
    const replacement = buildWorkspaceSideBySideTextPairModel({
      left: { content: 'a\nb', lineStart: 1 },
      right: { content: 'a\nc\nd', lineStart: 1 },
    }, 'src/a.ts')
    const newlineOnly = buildWorkspaceSideBySideTextPairModel({
      left: { content: 'a\n', lineStart: 1 },
      right: { content: 'a', lineStart: 1 },
    }, 'src/a.ts')
    const equal = buildWorkspaceSideBySideTextPairModel({
      left: { content: 'same\nlines', lineStart: 1 },
      right: { content: 'same\nlines', lineStart: 1 },
    }, 'src/a.ts')

    expect(summarizeWorkspaceSideBySideModel(replacement)).toEqual({ additions: 2, deletions: 1 })
    expect(summarizeWorkspaceSideBySideModel(newlineOnly)).toEqual({ additions: 1, deletions: 1 })
    expect(summarizeWorkspaceSideBySideModel(equal)).toEqual({ additions: 0, deletions: 0 })
  })

  it('pairs an ordinary replacement while preserving both real line numbers', () => {
    const files = parseWorkspaceSideBySideDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,2 +10,2 @@',
      ' const before = true',
      '-const answer = 41',
      '+const answer = 42',
    ].join('\n'))

    expect(files).toHaveLength(1)
    expect(changedRows([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,2 +10,2 @@',
      ' const before = true',
      '-const answer = 41',
      '+const answer = 42',
    ].join('\n'))).toMatchObject([{
      left: { text: 'const answer = 41', oldLine: 11 },
      right: { text: 'const answer = 42', newLine: 11 },
    }])
  })

  it('uses an explicit empty left cell for a pure insertion', () => {
    const rows = changedRows([
      '@@ -4,1 +4,3 @@',
      ' keep()',
      '+insertOne()',
      '+insertTwo()',
    ].join('\n'))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ left: null, right: { text: 'insertOne()', newLine: 5 } })
    expect(rows[1]).toMatchObject({ left: null, right: { text: 'insertTwo()', newLine: 6 } })
  })

  it('uses an explicit empty right cell for a pure deletion', () => {
    const rows = changedRows([
      '@@ -7,3 +7,1 @@',
      ' keep()',
      '-removeOne()',
      '-removeTwo()',
    ].join('\n'))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ left: { text: 'removeOne()', oldLine: 8 }, right: null })
    expect(rows[1]).toMatchObject({ left: { text: 'removeTwo()', oldLine: 9 }, right: null })
  })

  it('aligns unequal replacement runs by index and leaves only the unmatched side empty', () => {
    const rows = changedRows([
      '@@ -20,3 +20,2 @@',
      '-oldOne()',
      '-oldTwo()',
      '-oldThree()',
      '+newOne()',
      '+newTwo()',
    ].join('\n'))

    expect(rows).toMatchObject([
      { left: { text: 'oldOne()', oldLine: 20 }, right: { text: 'newOne()', newLine: 20 } },
      { left: { text: 'oldTwo()', oldLine: 21 }, right: { text: 'newTwo()', newLine: 21 } },
      { left: { text: 'oldThree()', oldLine: 22 }, right: null },
    ])
  })

  it('recognizes SVN Index headers as file boundaries and strips revision labels from paths', () => {
    const files = parseWorkspaceSideBySideDiff([
      'Index: src/one.ts',
      '===================================================================',
      '--- src/one.ts\t(revision 17)',
      '+++ src/one.ts\t(working copy)',
      '@@ -1 +1 @@',
      '-oldOne',
      '+newOne',
      'Index: src/two.ts',
      '===================================================================',
      '--- src/two.ts\t(revision 17)',
      '+++ src/two.ts\t(working copy)',
      '@@ -3 +3 @@',
      '-oldTwo',
      '+newTwo',
    ].join('\n'))

    expect(files).toHaveLength(2)
    expect(new Set(files.map((file) => file.id)).size).toBe(2)
    expect(new Set(files.flatMap((file) => file.source.rows.map((row) => row.id))).size).toBe(
      files.flatMap((file) => file.source.rows).length,
    )
    expect(files.map((file) => [file.oldPath, file.newPath])).toEqual([
      ['src/one.ts', 'src/one.ts'],
      ['src/two.ts', 'src/two.ts'],
    ])
    expect(files[1]?.rows.find((row) => row.kind === 'change')).toMatchObject({
      left: { text: 'oldTwo', oldLine: 3 },
      right: { text: 'newTwo', newLine: 3 },
    })
  })
})

describe('buildWorkspaceSideBySideModel', () => {
  it('builds the whole file from comparison content with real line numbers and stable placeholders', () => {
    const input = comparison(
      side('same\nold one\nold two\ntail\n'),
      side('same\nnew one\ntail\nadded\n'),
    )
    const first = buildWorkspaceSideBySideModel('patch must not define the whole file', input, 'src/a.ts')
    const second = buildWorkspaceSideBySideModel('a different patch', input, 'src/a.ts')

    expect(first.kind).toBe('comparison')
    expect(first.fullViewUnavailableReason).toBeNull()
    expect(first.files[0]?.rows).toMatchObject([
      { kind: 'context', left: { oldLine: 1, text: 'same' }, right: { newLine: 1, text: 'same' } },
      { kind: 'change', left: { oldLine: 2, text: 'old one' }, right: { newLine: 2, text: 'new one' } },
      { kind: 'change', left: { oldLine: 3, text: 'old two' }, right: null },
      { kind: 'context', left: { oldLine: 4, text: 'tail' }, right: { newLine: 3, text: 'tail' } },
      { kind: 'change', left: null, right: { newLine: 4, text: 'added' } },
    ])
    expect(first.files[0]?.rows.map((row) => row.id)).toEqual(second.files[0]?.rows.map((row) => row.id))
    expect(new Set(first.files[0]?.rows.map((row) => row.id)).size).toBe(first.files[0]?.rows.length)
  })

  it('handles empty files and treats a terminal newline as content-significant without inventing a line', () => {
    const empty = buildWorkspaceSideBySideModel('', comparison(side(''), side('')), 'src/a.ts')
    const terminalNewline = buildWorkspaceSideBySideModel('', comparison(side('value\n'), side('value')), 'src/a.ts')

    expect(empty.files[0]?.rows).toEqual([])
    expect(terminalNewline.files[0]?.rows).toMatchObject([{
      kind: 'change',
      left: { oldLine: 1, text: 'value' },
      right: { newLine: 1, text: 'value' },
    }])
  })

  it('projects all, differences, same, and three-line context with adjacent windows merged', () => {
    const lines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`)
    const right = [...lines]
    right[4] = 'changed 5'
    right[10] = 'changed 11'
    const model = buildWorkspaceSideBySideModel('', comparison(side(`${lines.join('\n')}\n`), side(`${right.join('\n')}\n`)), 'src/a.ts')
    const file = model.files[0]!

    expect(projectWorkspaceSideBySideFile(file, 'all').filter((item) => item.kind === 'row')).toHaveLength(15)
    expect(projectWorkspaceSideBySideFile(file, 'differences').filter((item) => item.kind === 'row')).toHaveLength(2)
    expect(projectWorkspaceSideBySideFile(file, 'same').filter((item) => item.kind === 'row')).toHaveLength(13)
    const context = projectWorkspaceSideBySideFile(file, 'context')
    expect(context.filter((item) => item.kind === 'row')).toHaveLength(13)
    expect(context.filter((item) => item.kind === 'separator')).toHaveLength(2)
  })

  it('keeps differences and context available while disabling full modes for patch-only and blocked states', () => {
    const patch = ['@@ -1 +1 @@', '-old', '+new'].join('\n')
    const patchOnly = buildWorkspaceSideBySideModel(patch, undefined, 'src/a.ts')
    const binary = buildWorkspaceSideBySideModel(
      patch,
      comparison(side('', { state: 'binary', content: undefined }), side('new')),
      'src/a.ts',
    )
    const tooLarge = buildWorkspaceSideBySideModel(
      patch,
      comparison(side('old'), side('', { state: 'too_large', content: undefined })),
      'src/a.ts',
    )

    expect(patchOnly.fullViewUnavailableReason).toBe('patch_only')
    expect(projectWorkspaceSideBySideFile(patchOnly.files[0]!, 'differences')).not.toEqual([])
    expect(projectWorkspaceSideBySideFile(patchOnly.files[0]!, 'context')).not.toEqual([])
    expect(binary.fullViewUnavailableReason).toBe('binary')
    expect(tooLarge.fullViewUnavailableReason).toBe('too_large')
  })

  it('accepts a genuinely missing side as an empty full-file source', () => {
    const missing = side('', {
      source: { kind: 'empty', path: 'src/a.ts', revision: 'empty' },
      exists: false,
      state: 'missing',
      content: undefined,
      writable: false,
    })
    const model = buildWorkspaceSideBySideModel('', comparison(missing, side('created\n')), 'src/a.ts')

    expect(model.kind).toBe('comparison')
    expect(model.files[0]?.rows).toMatchObject([{
      left: null,
      right: { newLine: 1, text: 'created' },
    }])
  })

  it.each([
    ['left missing', false, true],
    ['right missing', true, false],
  ])('creates one stable existence-only whole-file section for %s vs an existing empty file', (_, leftExists, rightExists) => {
    const emptySide = (exists: boolean) => side('', exists ? {} : {
      source: { kind: 'working_tree', path: 'src/empty.ts', revision: 'missing' },
      exists: false,
      state: 'missing',
      content: undefined,
      contentFingerprint: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })
    const first = buildWorkspaceSideBySideModel('', comparison(emptySide(leftExists), emptySide(rightExists)), 'src/empty.ts')
    const second = buildWorkspaceSideBySideModel('', comparison(emptySide(leftExists), emptySide(rightExists)), 'src/empty.ts')

    expect(first.kind).toBe('comparison')
    expect(first.files[0]?.rows).toHaveLength(1)
    expect(first.files[0]?.rows[0]).toMatchObject({ kind: 'existence', left: null, right: null })
    expect(first.sections).toMatchObject([{
      existenceOnly: true,
      rowIds: [first.files[0]?.rows[0]?.id],
    }])
    expect(first.sections[0]?.id).toBe(second.sections[0]?.id)
    expect(projectWorkspaceSideBySideFile(first.files[0]!, 'differences')).toHaveLength(1)
    expect(projectWorkspaceSideBySideFile(first.files[0]!, 'same')).toEqual([])
  })

  it('does not add an existence-only section when both empty sides share the same existence state', () => {
    const missing = side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })
    const bothExisting = buildWorkspaceSideBySideModel('', comparison(side(''), side('')), 'src/empty.ts')
    const bothMissing = buildWorkspaceSideBySideModel('', comparison(missing, missing), 'src/empty.ts')

    expect(bothExisting.files[0]?.rows).toEqual([])
    expect(bothExisting.sections).toEqual([])
    expect(bothMissing.files[0]?.rows).toEqual([])
    expect(bothMissing.sections).toEqual([])
  })

  it('uses non-crossing manual anchors as hard interval boundaries without pretending different anchor lines are equal', () => {
    const input = comparison(
      side('header\nsame\nA\nsame\nB\nsame\ntail\n'),
      side('header\nsame\nB\nsame\nA changed\nsame\ntail\n'),
    )
    const anchors = [{
      id: 'manual-anchor-1',
      state: 'valid' as const,
      left: { lineNumber: 3, signature: { previous: 'same\n', current: 'A\n', next: 'same\n' } },
      right: { lineNumber: 5, signature: { previous: 'same\n', current: 'A changed\n', next: 'same\n' } },
    }]
    const model = buildWorkspaceSideBySideModel('', input, 'src/a.ts', anchors)
    const anchorRow = model.files[0]?.rows.find((row) => row.manualAnchorId === 'manual-anchor-1')

    expect(anchorRow).toMatchObject({
      id: 'comparison-file-0-anchor-manual-anchor-1',
      kind: 'change',
      left: { oldLine: 3, text: 'A' },
      right: { newLine: 5, text: 'A changed' },
    })
    expect(model.sections.find((section) => section.manualAnchorId === 'manual-anchor-1')).toMatchObject({
      rowIds: [anchorRow?.id],
    })
    expect(model.files[0]?.rows.some((row) => row.left?.oldLine === 5 && row.right?.newLine === 3)).toBe(false)
  })

  it('keeps unaffected interval identities stable when an anchor splits another interval', () => {
    const input = comparison(
      side('a\nold one\nmid\nold two\ntail\nold three\nz\n'),
      side('a\nnew one\nmid\nnew two\ntail\nnew three\nz\n'),
    )
    const anchor = (id: string, leftLine: number, rightLine: number) => ({
      id,
      state: 'valid' as const,
      left: { lineNumber: leftLine, signature: { previous: '', current: '', next: '' } },
      right: { lineNumber: rightLine, signature: { previous: '', current: '', next: '' } },
    })
    const first = buildWorkspaceSideBySideModel('', input, 'src/a.ts', [anchor('manual-anchor-1', 3, 3)])
    const split = buildWorkspaceSideBySideModel('', input, 'src/a.ts', [
      anchor('manual-anchor-1', 3, 3),
      anchor('manual-anchor-2', 5, 5),
    ])
    const beforeIds = first.files[0]!.rows.filter((row) => (row.left?.oldLine ?? 99) < 3).map((row) => row.id)
    const afterIds = first.files[0]!.rows.filter((row) => (row.left?.oldLine ?? 0) > 5).map((row) => row.id)

    expect(split.files[0]!.rows.filter((row) => (row.left?.oldLine ?? 99) < 3).map((row) => row.id)).toEqual(beforeIds)
    expect(split.files[0]!.rows.filter((row) => (row.left?.oldLine ?? 0) > 5).map((row) => row.id)).toEqual(afterIds)
  })

  it('uses comparison settings only for projection equivalence while preserving displayed source text', () => {
    const settings = createDefaultWorkspaceComparisonSettings('src/a.ts')
    settings.ignoreWhitespace = true
    settings.ignoreCase = true
    const model = buildWorkspaceSideBySideModel(
      '',
      comparison(side('const VALUE = 1;\n'), side(' const value=1; \n')),
      'src/a.ts',
      [],
      settings,
    )

    expect(model.files[0]!.rows).toMatchObject([{
      kind: 'context',
      equivalenceReason: 'settings',
      left: { text: 'const VALUE = 1;' },
      right: { text: ' const value=1; ' },
    }])
  })

  it('treats CRLF and LF as equivalent only when whitespace is ignored', () => {
    const settings = createDefaultWorkspaceComparisonSettings('src/a.ts')
    const input = comparison(side('same\r\n'), side('same\n'))

    expect(buildWorkspaceSideBySideModel('', input, 'src/a.ts', [], settings).sections).toHaveLength(1)
    settings.ignoreWhitespace = true
    const ignored = buildWorkspaceSideBySideModel('', input, 'src/a.ts', [], settings)
    expect(ignored.sections).toEqual([])
    expect(ignored.files[0]!.rows[0]).toMatchObject({
      kind: 'context',
      equivalenceReason: 'settings',
      left: { text: 'same' },
      right: { text: 'same' },
    })
  })

  it('reports requested/effective profile diagnostics and preserves hard-anchor boundaries under precise matching', () => {
    const settings = createDefaultWorkspaceComparisonSettings('src/a.cpp')
    settings.profile = 'precise'
    const anchors = [{
      id: 'manual-anchor-1',
      state: 'valid' as const,
      left: { lineNumber: 2, signature: { previous: 'a\n', current: 'left\n', next: 'tail\n' } },
      right: { lineNumber: 2, signature: { previous: 'a\n', current: 'right\n', next: 'tail\n' } },
    }]
    const model = buildWorkspaceSideBySideModel('', comparison(side('a\nleft\ntail\n'), side('a\nright\ntail\n')), 'src/a.cpp', anchors, settings)

    expect(model.diagnostics.alignment.every((entry) => entry.requestedProfile === 'precise')).toBe(true)
    expect(model.files[0]!.rows.find((row) => row.manualAnchorId)).toMatchObject({ kind: 'change' })
  })
})
