import { describe, expect, it } from 'vitest'
import type { WorkspaceComparison } from '@/api/sessions'
import {
  createFileFullComparisonInput,
  createPositionedPatchComparisonInput,
  createReplacementFragmentComparisonInput,
  createProposedContentComparisonInput,
} from './workspaceComparisonInput'
import { buildWorkspaceSideBySideTextPairModel } from './workspaceSideBySideModel'

function comparison(): WorkspaceComparison {
  return {
    schemaVersion: 1,
    left: {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'HEAD' },
      exists: true,
      state: 'ok',
      content: 'const value = 1\n',
      contentFingerprint: 'left-fingerprint',
      requestedEncoding: 'auto',
      actualEncoding: 'utf8',
      bom: 'none',
      lineEnding: 'lf',
      writable: false,
    },
    right: {
      source: { kind: 'working_tree', path: 'src/a.ts', revision: 'working' },
      exists: true,
      state: 'ok',
      content: 'const value = 2\n',
      contentFingerprint: 'right-fingerprint',
      requestedEncoding: 'auto',
      actualEncoding: 'utf8',
      bom: 'none',
      lineEnding: 'lf',
      writable: true,
    },
  }
}

describe('workspaceComparisonInput', () => {
  function replacementModel(oldString: string, newString: string) {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-model',
      path: 'src/fragment.ts',
      oldString,
      newString,
    })
    return buildWorkspaceSideBySideTextPairModel(input.textPair, input.path)
  }

  it('preserves a complete file comparison and exposes full-view host capabilities', () => {
    const result = createFileFullComparisonInput({
      originId: 'workspace:tab-1:src/a.ts',
      path: 'src/a.ts',
      value: '@@ -1 +1 @@\n-const value = 1\n+const value = 2',
      comparison: comparison(),
    })

    expect(result.state).toBe('ok')
    if (result.state !== 'ok') throw new Error('expected complete comparison')
    expect(result.input.scope).toBe('file-full')
    expect(result.input.origin).toEqual({
      id: 'workspace:tab-1:src/a.ts',
      host: 'workspace',
      path: 'src/a.ts',
      revision: null,
    })
    expect(result.input.capabilities).toMatchObject({
      all: true,
      same: true,
      navigation: true,
      swap: true,
      edit: true,
      merge: true,
      save: true,
      encoding: true,
      anchors: true,
      settings: true,
    })
  })

  it.each([
    ['binary', { state: 'binary', exists: true, content: undefined }],
    ['undecodable', { state: 'undecodable', exists: true, content: undefined }],
    ['too_large', { state: 'too_large', exists: true, content: undefined }],
    ['inconsistent missing', { state: 'missing', exists: true, content: undefined }],
  ] as const)('rejects an incomplete file-full input atomically: %s', (_label, leftPatch) => {
    const incomplete = comparison()
    incomplete.left = { ...incomplete.left, ...leftPatch } as WorkspaceComparison['left']
    const result = createFileFullComparisonInput({
      originId: 'workspace:bad',
      path: 'src/a.ts',
      value: '',
      comparison: incomplete,
    })

    expect(result).toEqual({ state: 'unavailable', reason: 'incomplete' })
  })

  it('keeps checkpoint patches byte-for-byte and limits them to read-only projection actions', () => {
    const patch = '@@ -9,2 +9,2 @@\n-old\n+new'
    const input = createPositionedPatchComparisonInput({
      originId: 'checkpoint:session-1:message-2:src/a.ts',
      path: 'src/a.ts',
      value: patch,
      hostCapabilities: { comment: true, hunkAction: true },
    })

    expect(input.scope).toBe('positioned-patch')
    expect(input.value).toBe(patch)
    expect(input.origin.host).toBe('checkpoint')
    expect(input.capabilities).toMatchObject({
      all: false,
      same: false,
      navigation: true,
      swap: true,
      edit: false,
      merge: false,
      save: false,
      encoding: false,
      anchors: false,
      settings: false,
      comment: true,
      hunkAction: true,
    })
    expect(input.disabledReason).toBe('positioned_patch')
  })

  it('maps multiline Edit old/new to a replacement-fragment patch without file existence semantics', () => {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-1',
      path: 'src/a.ts',
      oldString: 'alpha\r\nbeta',
      newString: 'alpha\ngamma\ndelta',
    })

    expect(input.scope).toBe('replacement-fragment')
    expect(input.origin.host).toBe('tool')
    expect(input.value).toContain('--- a/src/a.ts')
    expect(input.value).toContain('+++ b/src/a.ts')
    expect(input.value).toContain('@@ -1,2 +1,3 @@')
    expect(input.value).toContain('-beta')
    expect(input.value).toContain('+gamma')
    expect(input.value).not.toContain('/dev/null')
    expect(input.capabilities.edit).toBe(false)
  })

  it('projects Edit old/new through the shared model as locally numbered paired fragment rows', () => {
    const model = replacementModel('a\nb', 'a\nc\nd')
    const rows = model.files[0]!.rows

    expect(model.kind).toBe('patch')
    expect(model.fullViewUnavailableReason).toBe('patch_only')
    expect(rows.map((row) => ({
      kind: row.kind,
      left: row.left?.text ?? null,
      leftLine: row.left?.oldLine ?? null,
      right: row.right?.text ?? null,
      rightLine: row.right?.newLine ?? null,
    }))).toEqual([
      { kind: 'context', left: 'a', leftLine: 1, right: 'a', rightLine: 1 },
      { kind: 'change', left: 'b', leftLine: 2, right: 'c', rightLine: 2 },
      { kind: 'change', left: null, leftLine: null, right: 'd', rightLine: 3 },
    ])
  })

  it('preserves final-newline differences as one paired row with explicit ending metadata', () => {
    const model = replacementModel('a\n', 'a')
    const rows = model.files[0]!.rows

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'change' })
    expect(rows[0]!.left).toMatchObject({ text: 'a' })
    expect(rows[0]!.right).toMatchObject({ text: 'a' })
    expect(rows[0]!.lineEndingDifference).toEqual({ left: '\n', right: '' })
  })

  it('keeps empty, equal, and long Edit fragments exact without file existence semantics', () => {
    const insertion = replacementModel('', 'line')
    const deletion = replacementModel('line', '')
    const bothEmpty = replacementModel('', '')
    const equal = replacementModel('same\nlines', 'same\nlines')
    const longOld = `prefix-${'x'.repeat(20_000)}-old`
    const longNew = `prefix-${'x'.repeat(20_000)}-new`
    const long = replacementModel(longOld, longNew)

    expect(insertion.files[0]!.rows).toHaveLength(1)
    expect(insertion.files[0]!.rows[0]!.left).toBeNull()
    expect(insertion.files[0]!.rows[0]!.right).toMatchObject({ text: 'line', newLine: 1 })
    expect(deletion.files[0]!.rows).toHaveLength(1)
    expect(deletion.files[0]!.rows[0]!.left).toMatchObject({ text: 'line', oldLine: 1 })
    expect(deletion.files[0]!.rows[0]!.right).toBeNull()
    expect(bothEmpty.files[0]!.rows).toEqual([])
    expect(equal.files[0]!.rows.map((row) => row.kind)).toEqual(['context', 'context'])
    expect(long.files[0]!.rows).toHaveLength(1)
    expect(long.files[0]!.rows[0]!.left?.text).toBe(longOld)
    expect(long.files[0]!.rows[0]!.right?.text).toBe(longNew)
  })

  it('does not interpret an empty Edit old fragment as a missing file', () => {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:edit-empty',
      path: 'src/a.ts',
      oldString: '',
      newString: 'created fragment',
    })

    expect(input.value).toContain('--- a/src/a.ts')
    expect(input.value).not.toContain('/dev/null')
    expect(input.disabledReason).toBe('replacement_fragment')
  })

  it('treats Write content as a proposal with an unknown baseline, including empty content', () => {
    const proposed = createProposedContentComparisonInput({
      originId: 'tool:write-1',
      path: 'src/new.ts',
      content: 'one\ntwo',
    })
    const empty = createProposedContentComparisonInput({
      originId: 'tool:write-2',
      path: 'src/new.ts',
      content: '',
    })

    expect(proposed.scope).toBe('proposed-content')
    expect(proposed.value).toContain('@@ -1,0 +1,2 @@')
    expect(proposed.value).toContain('+one\n+two')
    expect(proposed.value).not.toContain('/dev/null')
    expect(proposed.disabledReason).toBe('baseline_unknown')
    expect(empty.value).not.toContain('/dev/null')
    expect(empty.value).not.toContain('@@ ')
    expect(empty.capabilities.save).toBe(false)
  })

  it('sanitizes patch headers without changing the stable origin identity', () => {
    const input = createReplacementFragmentComparisonInput({
      originId: 'tool:stable\nidentity',
      path: 'src/unsafe\nname.ts',
      oldString: 'old',
      newString: 'new',
    })

    expect(input.origin.id).toBe('tool:stable\nidentity')
    expect(input.value).not.toContain('unsafe\nname')
    expect(input.value).toContain('src/unsafe name.ts')
  })
})
