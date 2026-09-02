import { describe, expect, it } from 'vitest'
import type { WorkspaceComparison, WorkspaceComparisonSide } from '@/api/sessions'
import { buildWorkspaceSideBySideModel } from './workspaceSideBySideModel'
import {
  acceptWorkspaceComparisonSave,
  applyWorkspaceComparisonSettings,
  addWorkspaceManualAlignmentAnchor,
  clearWorkspaceManualAlignmentAnchors,
  createWorkspaceComparisonSession,
  discardWorkspaceComparisonSession,
  editWorkspaceComparisonLine,
  editWorkspaceComparisonSide,
  getWorkspaceComparisonCapability,
  isWorkspaceComparisonSessionDirty,
  mergeWorkspaceComparisonSection,
  reloadWorkspaceComparisonSession,
  removeWorkspaceManualAlignmentAnchor,
  saveWorkspaceComparisonSession,
  undoWorkspaceComparisonSession,
  workspaceComparisonSessionToComparison,
} from './workspaceComparisonSession'
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
    contentFingerprint: `fp:${content}`,
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

function editableComparison(left = 'one\ntwo\nthree\n', right = 'one\nchanged\nthree\n') {
  return comparison(
    side(left, {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc123' },
      writable: false,
      readOnlyReason: 'Git HEAD is read-only.',
    }),
    side(right),
  )
}

describe('workspaceComparisonSession', () => {
  it('only initializes complete sources and preserves their save identity and format metadata', () => {
    const input = editableComparison()
    const session = createWorkspaceComparisonSession(input)

    expect(session).toMatchObject({
      left: {
        sourceSide: 'left',
        source: input.left.source,
        originContent: input.left.content,
        contentFingerprint: input.left.contentFingerprint,
        writable: false,
        originActualEncoding: 'utf8',
        actualEncoding: 'utf8',
        originLineEnding: 'lf',
        lineEnding: 'lf',
      },
      right: {
        sourceSide: 'right',
        source: input.right.source,
        originContent: input.right.content,
        writable: true,
      },
    })
    expect(createWorkspaceComparisonSession(comparison(
      { ...input.left, state: 'too_large', content: undefined },
      input.right,
    ))).toBeNull()
    expect(createWorkspaceComparisonSession(undefined)).toBeNull()
  })

  it('supports substantive multiline editing, added/deleted lines, and one-step undo without saving', () => {
    const initial = createWorkspaceComparisonSession(editableComparison())!
    const edited = editWorkspaceComparisonSide(initial, 'right', 'one\ninserted\nthree changed')

    expect(edited.right.content).toBe('one\ninserted\nthree changed')
    expect(edited.right.dirty).toBe(true)
    expect(edited.right.originContent).toBe('one\nchanged\nthree\n')
    expect(initial.right.content).toBe('one\nchanged\nthree\n')
    expect(workspaceComparisonSessionToComparison(edited).right.content).toBe('one\ninserted\nthree changed')
    expect(undoWorkspaceComparisonSession(edited)).toEqual(initial)
  })

  it('merges a replacement in both directions and retains source-side semantics independently of visual swap', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('one\nleft\nthree\n'),
      side('one\nright\nthree\n'),
    ))!
    const model = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const sectionId = model.sections[0]!.id

    const leftToRight = mergeWorkspaceComparisonSection(initial, model, sectionId, 'left')
    expect(leftToRight.right.content).toBe('one\nleft\nthree\n')
    expect(leftToRight.left.content).toBe('one\nleft\nthree\n')

    const rightToLeft = mergeWorkspaceComparisonSection(initial, model, sectionId, 'right')
    expect(rightToLeft.left.content).toBe('one\nright\nthree\n')
    expect(rightToLeft.right.content).toBe('one\nright\nthree\n')

    // The operation takes an original source side, not a visual column. Swapping is
    // presentation-only and therefore requires no mutation of this session.
    expect(mergeWorkspaceComparisonSection(initial, model, sectionId, 'left')).toEqual(leftToRight)
  })

  it('merges unequal insertion/deletion groups and can create or delete a missing working file', () => {
    const unequal = createWorkspaceComparisonSession(comparison(
      side('head\na\nb\nc\ntail\n'),
      side('head\nx\ntail\n'),
    ))!
    const unequalModel = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(unequal), 'src/a.ts')
    const merged = mergeWorkspaceComparisonSection(unequal, unequalModel, unequalModel.sections[0]!.id, 'left')
    expect(merged.right.content).toBe('head\na\nb\nc\ntail\n')

    const missingRightComparison = comparison(
      side('created\nfile\n'),
      side('', {
        exists: false,
        state: 'missing',
        content: undefined,
        contentFingerprint: undefined,
        actualEncoding: undefined,
        lineEnding: 'none',
      }),
    )
    const missing = createWorkspaceComparisonSession(missingRightComparison)!
    const missingModel = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(missing), 'src/a.ts')
    const created = mergeWorkspaceComparisonSection(missing, missingModel, missingModel.sections[0]!.id, 'left')
    expect(created.right).toMatchObject({ exists: true, content: 'created\nfile\n', actualEncoding: 'utf8', dirty: true })

    const missingLeftComparison = comparison(
      side('', {
        source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc123' },
        exists: false,
        state: 'missing',
        content: undefined,
        contentFingerprint: undefined,
        actualEncoding: undefined,
        lineEnding: 'none',
        writable: false,
      }),
      side('delete\nme\n'),
    )
    const deletion = createWorkspaceComparisonSession(missingLeftComparison)!
    const deletionModel = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(deletion), 'src/a.ts')
    const deleted = mergeWorkspaceComparisonSection(deletion, deletionModel, deletionModel.sections[0]!.id, 'left')
    expect(deleted.right).toMatchObject({ exists: false, content: '', dirty: true })
  })

  it('blocks baseline, patch-only and unknown encodings while allowing GBK and a missing UTF-8 side', () => {
    const readonly = createWorkspaceComparisonSession(editableComparison())!
    expect(getWorkspaceComparisonCapability(readonly, 'left')).toMatchObject({ allowed: false, reason: 'not_writable' })
    expect(getWorkspaceComparisonCapability(null, 'right')).toEqual({ allowed: false, reason: 'patch_only' })

    const gbk = createWorkspaceComparisonSession(comparison(side('left'), side('右', { actualEncoding: 'gbk' })))!
    expect(getWorkspaceComparisonCapability(gbk, 'right')).toEqual({ allowed: true })
    expect(editWorkspaceComparisonSide(gbk, 'right', 'changed')).toMatchObject({
      right: { actualEncoding: 'gbk', content: 'changed', dirty: true },
    })

    const unknown = createWorkspaceComparisonSession(comparison(side('left'), side('right', { actualEncoding: undefined })))!
    expect(getWorkspaceComparisonCapability(unknown, 'right')).toEqual({ allowed: false, reason: 'unsupported_encoding' })

    const missing = createWorkspaceComparisonSession(comparison(side('left'), side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })))!
    expect(getWorkspaceComparisonCapability(missing, 'right')).toEqual({ allowed: true })
    expect(editWorkspaceComparisonSide(missing, 'right', 'new')).toMatchObject({
      right: { exists: true, actualEncoding: 'utf8', dirty: true },
    })
  })

  it('updates the CAS origin after save and supports discard without mutating source identity', () => {
    const initial = createWorkspaceComparisonSession(editableComparison())!
    const edited = editWorkspaceComparisonSide(initial, 'right', 'saved\n')
    const accepted = acceptWorkspaceComparisonSave(edited, 'right', 'saved\n')

    expect(accepted.right).toMatchObject({
      originContent: 'saved\n',
      content: 'saved\n',
      dirty: false,
      source: initial.right.source,
    })
    expect(accepted.undoStack).toEqual([])
    expect(isWorkspaceComparisonSessionDirty(accepted)).toBe(false)

    const discarded = discardWorkspaceComparisonSession(edited)
    expect(discarded.right.content).toBe(initial.right.content)
    expect(discarded.right.source).toEqual(initial.right.source)
    expect(discarded.undoStack).toEqual([])
  })

  it('edits one source line in place while preserving exact line endings and undo state', () => {
    const readonlyLeft = side('base\r\n', {
      source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
      writable: false,
      readOnlyReason: 'Git HEAD is read-only.',
    })
    const initial = createWorkspaceComparisonSession(comparison(
      readonlyLeft,
      side('one\r\nchanged\r\nthree\r\n'),
    ))!

    const edited = editWorkspaceComparisonLine(initial, 'right', 2, 'updated', initial.revision)
    expect(edited.right).toMatchObject({
      content: 'one\r\nupdated\r\nthree\r\n',
      lineEnding: 'crlf',
      dirty: true,
    })
    expect(edited.revision).toBe(initial.revision + 1)
    expect(undoWorkspaceComparisonSession(edited)).toEqual(initial)
    expect(editWorkspaceComparisonLine(initial, 'right', 2, 'changed', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'right', 2, 'two\nlines', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'right', 99, 'missing', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'left', 1, 'forbidden', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'right', 2, 'stale', initial.revision - 1)).toBe(initial)
  })

  it('sends the exact CAS baseline, accepts success, and preserves dirty state on conflict', async () => {
    const initial = createWorkspaceComparisonSession(editableComparison())!
    const edited = editWorkspaceComparisonSide(initial, 'right', 'saved\n')
    const requests: unknown[] = []
    const saved = await saveWorkspaceComparisonSession(edited, async (request) => {
      requests.push(request)
      return { state: 'ok', path: request.path, content: request.content ?? undefined }
    })

    expect(requests).toEqual([{
      path: 'src/a.ts',
      expectedContent: 'one\nchanged\nthree\n',
      content: 'saved\n',
      expectedFingerprint: 'fp:one\nchanged\nthree\n',
      encoding: 'utf8',
      bom: 'none',
      lineEnding: 'lf',
    }])
    expect(saved).toMatchObject({ state: 'ok', session: { right: { originContent: 'saved\n', dirty: false }, undoStack: [] } })

    const conflict = await saveWorkspaceComparisonSession(edited, async () => ({
      state: 'conflict',
      path: 'src/a.ts',
      error: 'changed on disk',
    }))
    expect(conflict).toMatchObject({
      state: 'conflict',
      sourceSide: 'right',
      error: 'changed on disk',
      session: { right: { content: 'saved\n', originContent: 'one\nchanged\nthree\n', dirty: true } },
    })
  })

  it('uses explicit null CAS to create a missing UTF-8 working side', async () => {
    const missing = createWorkspaceComparisonSession(comparison(side('base'), side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })))!
    const edited = editWorkspaceComparisonSide(missing, 'right', 'created\n')
    const requests: unknown[] = []
    const saved = await saveWorkspaceComparisonSession(edited, async (request) => {
      requests.push(request)
      return { state: 'ok', path: request.path, content: request.content ?? undefined }
    })

    expect(requests).toEqual([{
      path: 'src/a.ts',
      expectedContent: null,
      content: 'created\n',
      expectedFingerprint: null,
      encoding: 'utf8',
      bom: 'none',
      lineEnding: 'lf',
    }])
    expect(saved).toMatchObject({ state: 'ok', session: { right: { originExists: true, actualEncoding: 'utf8', dirty: false } } })
  })

  it('saves GBK edits with raw-byte identity and preserved BOM/line endings', async () => {
    const initial = createWorkspaceComparisonSession(comparison(side('base'), side('你好\r\n', {
      contentFingerprint: 'sha256:gbk-before',
      requestedEncoding: 'gbk',
      actualEncoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    })))!
    const edited = editWorkspaceComparisonSide(initial, 'right', '修改\n')
    const requests: unknown[] = []
    const saved = await saveWorkspaceComparisonSession(edited, async (request) => {
      requests.push(request)
      return {
        state: 'ok',
        path: request.path,
        content: request.content ?? undefined,
        contentFingerprint: 'sha256:gbk-after',
        actualEncoding: 'gbk',
        bom: 'none',
        lineEnding: 'crlf',
      }
    })

    expect(requests).toEqual([{
      path: 'src/a.ts',
      expectedContent: '你好\r\n',
      content: '修改\n',
      expectedFingerprint: 'sha256:gbk-before',
      encoding: 'gbk',
      bom: 'none',
      lineEnding: 'crlf',
    }])
    expect(saved).toMatchObject({
      state: 'ok',
      session: {
        right: {
          originContent: '修改\n',
          contentFingerprint: 'sha256:gbk-after',
          originActualEncoding: 'gbk',
          originLineEnding: 'crlf',
          dirty: false,
        },
      },
    })
  })

  it('merges an existence-only section in both source directions and emits exact create/delete payloads', async () => {
    const missing = side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      contentFingerprint: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })
    const initial = createWorkspaceComparisonSession(comparison(missing, side('')))!
    const model = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const sectionId = model.sections[0]!.id

    const deleted = mergeWorkspaceComparisonSection(initial, model, sectionId, 'left')
    expect(deleted.right).toMatchObject({ exists: false, content: '', dirty: true })
    expect(workspaceComparisonSessionToComparison(deleted).right).toMatchObject({ exists: false, state: 'missing' })
    expect(workspaceComparisonSessionToComparison(deleted).right).not.toHaveProperty('content')
    expect(undoWorkspaceComparisonSession(deleted)).toEqual(initial)
    expect(discardWorkspaceComparisonSession(deleted)).toEqual(initial)
    const deleteRequests: unknown[] = []
    await saveWorkspaceComparisonSession(deleted, async (request) => {
      deleteRequests.push(request)
      return { state: 'ok', path: request.path }
    })
    expect(deleteRequests).toEqual([{
      path: 'src/a.ts',
      expectedContent: '',
      content: null,
      expectedFingerprint: 'fp:',
      encoding: 'utf8',
      bom: 'none',
      lineEnding: 'none',
    }])

    const created = mergeWorkspaceComparisonSection(initial, model, sectionId, 'right')
    expect(created.left).toMatchObject({ exists: true, content: '', actualEncoding: 'utf8', dirty: true })
    expect(workspaceComparisonSessionToComparison(created).left).toMatchObject({ exists: true, state: 'ok', content: '' })
    expect(discardWorkspaceComparisonSession(created)).toEqual(initial)
    const createRequests: unknown[] = []
    await saveWorkspaceComparisonSession(created, async (request) => {
      createRequests.push(request)
      return { state: 'ok', path: request.path, content: request.content ?? undefined }
    })
    expect(createRequests).toEqual([{
      path: 'src/a.ts',
      expectedContent: null,
      content: '',
      expectedFingerprint: null,
      encoding: 'utf8',
      bom: 'none',
      lineEnding: 'none',
    }])
  })

  it('mirrors existence-only merging when the right side is missing', () => {
    const missing = side('', {
      exists: false,
      state: 'missing',
      content: undefined,
      actualEncoding: undefined,
      lineEnding: 'none',
    })
    const initial = createWorkspaceComparisonSession(comparison(side(''), missing))!
    const model = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const sectionId = model.sections[0]!.id

    expect(mergeWorkspaceComparisonSection(initial, model, sectionId, 'left').right).toMatchObject({
      exists: true,
      content: '',
      actualEncoding: 'utf8',
      dirty: true,
    })
    expect(mergeWorkspaceComparisonSection(initial, model, sectionId, 'right').left).toMatchObject({
      exists: false,
      content: '',
      dirty: true,
    })
  })

  it('adds, removes, clears, and undoes anchors without changing file dirty or save payloads', async () => {
    const initial = createWorkspaceComparisonSession(comparison(side('a\nb\nc\n'), side('a\nx\nc\n')))!
    const added = addWorkspaceManualAlignmentAnchor(initial, 2, 2, initial.revision)
    expect(added).toMatchObject({ state: 'ok', session: { revision: 1, manualAnchors: [{ id: 'manual-anchor-1', state: 'valid' }] } })
    if (added.state !== 'ok') throw new Error('anchor add failed')
    expect(isWorkspaceComparisonSessionDirty(added.session)).toBe(false)
    const undoneAdd = undoWorkspaceComparisonSession(added.session)
    const addedAgain = addWorkspaceManualAlignmentAnchor(undoneAdd, 2, 2, undoneAdd.revision)
    expect(addedAgain).toMatchObject({ state: 'ok', anchor: { id: 'manual-anchor-2' } })

    const removed = removeWorkspaceManualAlignmentAnchor(added.session, 'manual-anchor-1')
    expect(removed.manualAnchors).toEqual([])
    expect(undoWorkspaceComparisonSession(removed).manualAnchors).toHaveLength(1)
    const cleared = clearWorkspaceManualAlignmentAnchors(added.session)
    expect(cleared.manualAnchors).toEqual([])
    expect(undoWorkspaceComparisonSession(cleared).manualAnchors).toHaveLength(1)

    const requests: unknown[] = []
    await saveWorkspaceComparisonSession(added.session, async (request) => {
      requests.push(request)
      return { state: 'ok', path: request.path }
    })
    expect(requests).toEqual([])
  })

  it('atomically rejects stale and crossing candidates and rebases or invalidates anchors with content transactions', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('head\nleft anchor\ntail\n'),
      side('head\nright anchor\ntail\n'),
    ))!
    const added = addWorkspaceManualAlignmentAnchor(initial, 2, 2, initial.revision)
    if (added.state !== 'ok') throw new Error('anchor add failed')
    expect(addWorkspaceManualAlignmentAnchor(added.session, 3, 1, added.session.revision)).toMatchObject({
      state: 'error', reason: 'crossing', session: added.session,
    })
    expect(addWorkspaceManualAlignmentAnchor(added.session, 3, 3, initial.revision)).toMatchObject({
      state: 'error', reason: 'stale_selection', session: added.session,
    })

    const shifted = editWorkspaceComparisonSide(added.session, 'left', 'inserted\nhead\nleft anchor\ntail\n')
    expect(shifted.manualAnchors[0]).toMatchObject({ state: 'valid', left: { lineNumber: 3 }, right: { lineNumber: 2 } })
    const invalidated = editWorkspaceComparisonSide(added.session, 'left', 'head\nchanged\ntail\n')
    expect(invalidated.manualAnchors[0]).toMatchObject({ state: 'stale', staleReason: 'line_changed' })
    expect(undoWorkspaceComparisonSession(invalidated).manualAnchors[0]).toMatchObject({ state: 'valid', left: { lineNumber: 2 } })
  })

  it('fail-closed rebases anchors across clean refresh and encoding reload without changing source-side identity', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('head\nleft anchor\ntail\n'),
      side('head\nright anchor\ntail\n'),
    ))!
    const added = addWorkspaceManualAlignmentAnchor(initial, 2, 2, initial.revision)
    if (added.state !== 'ok') throw new Error('anchor add failed')
    const reloaded = reloadWorkspaceComparisonSession(added.session, comparison(
      side('inserted\nhead\nleft anchor\ntail\n', { requestedEncoding: 'gbk', actualEncoding: 'gbk' }),
      side('head\nright anchor\ntail\n'),
    ))!

    expect(reloaded).toMatchObject({
      left: { requestedEncoding: 'gbk', actualEncoding: 'gbk', dirty: false },
      manualAnchors: [{ id: 'manual-anchor-1', state: 'valid', left: { lineNumber: 3 }, right: { lineNumber: 2 } }],
      undoStack: [],
    })
    const stale = reloadWorkspaceComparisonSession(added.session, comparison(
      side('head\nchanged\ntail\n'),
      side('head\nright anchor\ntail\n'),
    ))!
    expect(stale.manualAnchors[0]).toMatchObject({ id: 'manual-anchor-1', state: 'stale', staleReason: 'line_changed' })
  })

  it('applies settings atomically outside file dirty/undo and preserves them across reload', () => {
    const initial = createWorkspaceComparisonSession(editableComparison())!
    const draft = createDefaultWorkspaceComparisonSettings('src/a.cpp')
    draft.profile = 'precise'
    draft.ignoreWhitespace = true
    const applied = applyWorkspaceComparisonSettings(initial, draft)

    expect(applied).toMatchObject({ state: 'ok', session: { settingsRevision: 1, comparisonSettings: { profile: 'precise', ignoreWhitespace: true } } })
    if (applied.state !== 'ok') throw new Error('settings apply failed')
    expect(isWorkspaceComparisonSessionDirty(applied.session)).toBe(false)
    expect(applied.session.undoStack).toEqual([])
    expect(reloadWorkspaceComparisonSession(applied.session, editableComparison())).toMatchObject({
      comparisonSettings: { profile: 'precise', ignoreWhitespace: true },
      settingsRevision: 1,
    })

    const invalid = { ...draft, rules: [{ id: 'bad', name: 'bad', enabled: true, pattern: '(?=x)', caseSensitive: true, scope: 'line' as const, effect: 'ignore' as const, priority: 1 }] }
    expect(applyWorkspaceComparisonSettings(applied.session, invalid)).toMatchObject({ state: 'error', session: applied.session })
  })
})
