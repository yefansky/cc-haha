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
  insertWorkspaceComparisonText,
  isWorkspaceComparisonSessionDirty,
  mergeWorkspaceComparisonRow,
  mergeWorkspaceComparisonSection,
  reloadWorkspaceComparisonSession,
  removeWorkspaceManualAlignmentAnchor,
  redoWorkspaceComparisonSession,
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
    const undone = undoWorkspaceComparisonSession(edited)
    expect(undone).toMatchObject({
      left: initial.left,
      right: initial.right,
      manualAnchors: initial.manualAnchors,
      undoStack: [],
      redoStack: [expect.any(Object)],
    })
    expect(undone.revision).toBeGreaterThan(edited.revision)
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
    expect(redoWorkspaceComparisonSession(undoWorkspaceComparisonSession(rightToLeft))).toMatchObject({
      left: rightToLeft.left,
      right: rightToLeft.right,
      redoStack: [],
    })

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

  it('merges one aligned row in either direction and restores it with shared undo', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('head\nleft\ntail\n'),
      side('head\nright\ntail\n'),
    ))!
    const model = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const row = model.files[0]!.rows.find((candidate) => (
      candidate.left?.oldLine === 2 && candidate.right?.newLine === 2
    ))!

    const leftToRight = mergeWorkspaceComparisonRow(initial, model, row.id, 'left', initial.revision)
    expect(leftToRight.right.content).toBe('head\nleft\ntail\n')
    expect(leftToRight.left.content).toBe('head\nleft\ntail\n')
    const undoneLeftToRight = undoWorkspaceComparisonSession(leftToRight)
    expect(undoneLeftToRight).toMatchObject({
      left: initial.left,
      right: initial.right,
      undoStack: [],
      redoStack: [expect.any(Object)],
    })
    expect(redoWorkspaceComparisonSession(undoneLeftToRight)).toMatchObject({
      left: leftToRight.left,
      right: leftToRight.right,
      redoStack: [],
    })

    const rightToLeft = mergeWorkspaceComparisonRow(initial, model, row.id, 'right', initial.revision)
    expect(rightToLeft.left.content).toBe('head\nright\ntail\n')
    expect(rightToLeft.right.content).toBe('head\nright\ntail\n')
    const undoneRightToLeft = undoWorkspaceComparisonSession(rightToLeft)
    expect(redoWorkspaceComparisonSession(undoneRightToLeft)).toMatchObject({
      left: rightToLeft.left,
      right: rightToLeft.right,
      redoStack: [],
    })
  })

  it('inserts placeholder rows at the beginning and end while preserving target EOL and source EOF', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('first\r\nmiddle\r\nlast', { lineEnding: 'crlf' }),
      side('middle\r\n', { lineEnding: 'crlf' }),
    ))!
    const firstModel = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const firstRow = firstModel.files[0]!.rows.find((candidate) => candidate.left?.oldLine === 1)!
    expect(firstRow.right).toBeNull()

    const insertedFirst = mergeWorkspaceComparisonRow(initial, firstModel, firstRow.id, 'left', initial.revision)
    expect(insertedFirst.right.content).toBe('first\r\nmiddle\r\n')
    expect(insertedFirst.right.lineEnding).toBe('crlf')

    const lastModel = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(insertedFirst), 'src/a.ts')
    const lastRow = lastModel.files[0]!.rows.find((candidate) => candidate.left?.oldLine === 3)!
    expect(lastRow.right).toBeNull()
    const insertedLast = mergeWorkspaceComparisonRow(
      insertedFirst,
      lastModel,
      lastRow.id,
      'left',
      insertedFirst.revision,
    )
    expect(insertedLast.right.content).toBe('first\r\nmiddle\r\nlast')
    expect(insertedLast.right.lineEnding).toBe('crlf')
  })

  it('copies a placeholder to delete one target row without deleting an existing source file', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('keep\n'),
      side('remove\nkeep\n'),
    ))!
    const model = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const row = model.files[0]!.rows.find((candidate) => candidate.right?.newLine === 1)!
    expect(row.left).toBeNull()

    const deleted = mergeWorkspaceComparisonRow(initial, model, row.id, 'left', initial.revision)
    expect(deleted.right).toMatchObject({ exists: true, content: 'keep\n', dirty: true })
    expect(undoWorkspaceComparisonSession(deleted)).toMatchObject({
      left: initial.left,
      right: initial.right,
      undoStack: [],
      redoStack: [expect.any(Object)],
    })
  })

  it('rejects one-line and section merges from a stale model revision and protects read-only targets', () => {
    const initial = createWorkspaceComparisonSession(editableComparison('one\nleft\nthree\n', 'one\nright\nthree\n'))!
    const model = buildWorkspaceSideBySideModel('', workspaceComparisonSessionToComparison(initial), 'src/a.ts')
    const row = model.files[0]!.rows.find((candidate) => candidate.left?.oldLine === 2)!
    const changed = editWorkspaceComparisonSide(initial, 'right', 'one\nnewer\nthree\n')

    expect(mergeWorkspaceComparisonRow(changed, model, row.id, 'left', initial.revision)).toBe(changed)
    expect(mergeWorkspaceComparisonSection(
      changed,
      model,
      model.sections[0]!.id,
      'left',
      initial.revision,
    )).toBe(changed)
    expect(mergeWorkspaceComparisonRow(initial, model, row.id, 'right', initial.revision)).toBe(initial)
  })

  it('rebases manual anchors after a one-line insertion before an anchored target line', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('insert\nzero\nhead\nanchor\ntail\n'),
      side('zero\nhead\nanchor\ntail\n'),
    ))!
    const anchored = addWorkspaceManualAlignmentAnchor(initial, 4, 3, initial.revision)
    if (anchored.state !== 'ok') throw new Error('anchor add failed')
    const model = buildWorkspaceSideBySideModel(
      '',
      workspaceComparisonSessionToComparison(anchored.session),
      'src/a.ts',
      anchored.session.manualAnchors,
    )
    const row = model.files[0]!.rows.find((candidate) => candidate.left?.oldLine === 1)!
    expect(row.right).toBeNull()

    const merged = mergeWorkspaceComparisonRow(
      anchored.session,
      model,
      row.id,
      'left',
      anchored.session.revision,
    )
    expect(merged.right.content).toBe('insert\nzero\nhead\nanchor\ntail\n')
    expect(merged.manualAnchors[0]).toMatchObject({ state: 'valid', right: { lineNumber: 4 } })
    expect(undoWorkspaceComparisonSession(merged)).toMatchObject({
      left: anchored.session.left,
      right: anchored.session.right,
      manualAnchors: anchored.session.manualAnchors,
      undoStack: anchored.session.undoStack,
      redoStack: [expect.any(Object)],
    })
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
    expect(accepted.redoStack).toEqual([])
    expect(isWorkspaceComparisonSessionDirty(accepted)).toBe(false)

    const discarded = discardWorkspaceComparisonSession(edited)
    expect(discarded.right.content).toBe(initial.right.content)
    expect(discarded.right.source).toEqual(initial.right.source)
    expect(discarded.undoStack).toEqual([])
    expect(discarded.redoStack).toEqual([])
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
    expect(undoWorkspaceComparisonSession(edited)).toMatchObject({
      left: initial.left,
      right: initial.right,
      undoStack: [],
      redoStack: [expect.any(Object)],
    })
    expect(editWorkspaceComparisonLine(initial, 'right', 2, 'changed', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'right', 2, 'two\nlines', initial.revision).right.content)
      .toBe('one\r\ntwo\r\nlines\r\nthree\r\n')
    expect(editWorkspaceComparisonLine(initial, 'right', 99, 'missing', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'left', 1, 'forbidden', initial.revision)).toBe(initial)
    expect(editWorkspaceComparisonLine(initial, 'right', 2, 'stale', initial.revision - 1)).toBe(initial)
  })

  it('inserts direct-edit text at aligned placeholders with native line endings', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('one\r\nremoved\r\nthree\r\n', {
        source: { kind: 'git_head', path: 'src/a.ts', revision: 'abc' },
        writable: false,
        readOnlyReason: 'Git HEAD is read-only.',
      }),
      side('one\r\nthree\r\n'),
    ))!

    const inserted = insertWorkspaceComparisonText(initial, 'right', 2, 'restored\nextra', initial.revision)
    expect(inserted.right).toMatchObject({
      content: 'one\r\nrestored\r\nextra\r\nthree\r\n',
      lineEnding: 'crlf',
      dirty: true,
    })
    expect(insertWorkspaceComparisonText(initial, 'right', 2, '', initial.revision)).toBe(initial)
    expect(insertWorkspaceComparisonText(initial, 'right', 99, 'missing', initial.revision)).toBe(initial)
    expect(insertWorkspaceComparisonText(initial, 'right', 2, 'stale', initial.revision - 1)).toBe(initial)
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
    expect(saved).toMatchObject({
      state: 'ok',
      session: { right: { originContent: 'saved\n', dirty: false }, undoStack: [], redoStack: [] },
    })

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
    expect(undoWorkspaceComparisonSession(deleted)).toMatchObject({
      left: initial.left,
      right: initial.right,
      undoStack: [],
      redoStack: [expect.any(Object)],
    })
    expect(discardWorkspaceComparisonSession(deleted)).toMatchObject({
      left: initial.left,
      right: initial.right,
      undoStack: [],
      redoStack: [],
    })
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
    expect(discardWorkspaceComparisonSession(created)).toMatchObject({
      left: initial.left,
      right: initial.right,
      undoStack: [],
      redoStack: [],
    })
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
      redoStack: [],
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

  it('undoes and redoes file edits, line edits, merges, and manual alignment in one chronological history', () => {
    const initial = createWorkspaceComparisonSession(comparison(
      side('head\nleft\ntail\n'),
      side('head\nright\ntail\n'),
    ))!
    const wholeEdit = editWorkspaceComparisonSide(initial, 'left', 'head\nleft whole\ntail\n')
    const lineEdit = editWorkspaceComparisonLine(wholeEdit, 'right', 2, 'right line', wholeEdit.revision)
    const anchored = addWorkspaceManualAlignmentAnchor(lineEdit, 2, 2, lineEdit.revision)
    if (anchored.state !== 'ok') throw new Error('anchor add failed')
    const model = buildWorkspaceSideBySideModel(
      '',
      workspaceComparisonSessionToComparison(anchored.session),
      'src/a.ts',
      anchored.session.manualAnchors,
    )
    const merged = mergeWorkspaceComparisonSection(
      anchored.session,
      model,
      model.sections[0]!.id,
      'left',
      anchored.session.revision,
    )

    expect(merged.undoStack).toHaveLength(4)
    let current = merged
    for (let index = 0; index < 4; index += 1) current = undoWorkspaceComparisonSession(current)
    expect(current).toMatchObject({
      left: initial.left,
      right: initial.right,
      manualAnchors: [],
      undoStack: [],
    })
    expect(current.redoStack).toHaveLength(4)

    const revisionAfterUndo = current.revision
    for (let index = 0; index < 4; index += 1) current = redoWorkspaceComparisonSession(current)
    expect(current).toMatchObject({
      left: merged.left,
      right: merged.right,
      manualAnchors: merged.manualAnchors,
      redoStack: [],
    })
    expect(current.undoStack).toHaveLength(4)
    expect(current.revision).toBeGreaterThan(revisionAfterUndo)
  })

  it('clears redo after a branched mutation and preserves monotonic revisions and anchor ids', () => {
    const initial = createWorkspaceComparisonSession(comparison(side('a\nb\n'), side('a\nx\n')))!
    const added = addWorkspaceManualAlignmentAnchor(initial, 2, 2, initial.revision)
    if (added.state !== 'ok') throw new Error('anchor add failed')
    const undone = undoWorkspaceComparisonSession(added.session)
    expect(undone.redoStack).toHaveLength(1)
    expect(undone.revision).toBeGreaterThan(added.session.revision)

    const redone = redoWorkspaceComparisonSession(undone)
    expect(redone.manualAnchors).toMatchObject([{ id: 'manual-anchor-1' }])
    expect(redone.nextManualAnchorSequence).toBe(2)
    expect(redone.redoStack).toEqual([])
    expect(redone.revision).toBeGreaterThan(undone.revision)

    const undoneAgain = undoWorkspaceComparisonSession(redone)
    const settingsBranch = applyWorkspaceComparisonSettings(undoneAgain, {
      ...undoneAgain.comparisonSettings,
      ignoreWhitespace: true,
    })
    expect(settingsBranch).toMatchObject({ state: 'ok', session: { redoStack: [] } })
    const branched = editWorkspaceComparisonSide(undoneAgain, 'right', 'a\nbranch\n')
    expect(branched.redoStack).toEqual([])
    expect(redoWorkspaceComparisonSession(branched)).toBe(branched)
    expect(branched.revision).toBeGreaterThan(undoneAgain.revision)
  })

  it('clears both history directions after a successful save but preserves them on save conflict', async () => {
    const initial = createWorkspaceComparisonSession(editableComparison())!
    const edited = editWorkspaceComparisonSide(initial, 'right', 'saved\n')
    const undone = undoWorkspaceComparisonSession(edited)
    const redone = redoWorkspaceComparisonSession(undone)
    expect(redone.undoStack).not.toEqual([])

    const saved = await saveWorkspaceComparisonSession(redone, async (request) => ({
      state: 'ok',
      path: request.path,
      content: request.content ?? undefined,
    }))
    expect(saved).toMatchObject({ state: 'ok', session: { undoStack: [], redoStack: [] } })

    const conflict = await saveWorkspaceComparisonSession(redone, async (request) => ({
      state: 'conflict',
      path: request.path,
      error: 'changed',
    }))
    expect(conflict.session.undoStack).toEqual(redone.undoStack)
    expect(conflict.session.redoStack).toEqual(redone.redoStack)
  })
})
