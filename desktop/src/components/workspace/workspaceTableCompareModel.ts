import type { WorkspaceComparison } from '@/api/sessions'
import { solveWorkspaceAlignment } from './workspaceAlignmentSolver'
import { prepareWorkspaceComparisonInputs } from './workspaceComparisonLanguage'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'
import type { WorkspaceDiffRow } from './workspaceDiffModel'
import type { WorkspaceSideBySideModel, WorkspaceSideBySideRow } from './workspaceSideBySideModel'

// Use a unique leading key only when it identifies records on both sides.
// Duplicate keys fall back to the existing bounded content alignment solver.
export function buildWorkspaceTableModel(comparison: WorkspaceComparison | undefined, path: string): WorkspaceSideBySideModel {
  if (!comparison) throw new Error('Table comparison requires complete sources')
  const settings = { ...createDefaultWorkspaceComparisonSettings(path), profile: 'fast' as const }
  const prepared = prepareWorkspaceComparisonInputs(comparison.left.content ?? '', comparison.right.content ?? '', settings)
  const left = prepared.left, right = prepared.right
  if (left.length > 500_000 || right.length > 500_000) throw new Error('表格比较每侧最多支持 500,000 行')
  const parts = (lines: typeof left, length: number) => lines.slice(1).map(line => line.text.split('\t', length).join('\t'))
  for (let length = 1; length <= 3; length++) {
    const l = parts(left, length), r = parts(right, length)
    const ls = new Set(l), rs = new Set(r)
    if (!l.length || !r.length || ls.size !== l.length || rs.size !== r.length) continue
    const common = l.filter(key => rs.has(key)).length
    if (common / Math.min(l.length, r.length) < .5) continue
    for (const lines of [left, right]) for (let i = 1; i < lines.length; i++) lines[i]!.equivalenceKey = lines[i]!.text.split('\t', length).join('\t')
    break
  }
  // Line endings affect difference reporting, never record alignment.
  for (const line of [...left, ...right]) line.comparisonEnding = ''
  const alignment = solveWorkspaceAlignment(left, right, [], 'fast')
  const source = (line: typeof left[number] | undefined, side: 'old' | 'new', equal: boolean): WorkspaceDiffRow | null => line ? ({ id: `${side}-${line.lineNumber}`, kind: equal ? 'context' : side === 'old' ? 'deletion' : 'addition', text: line.text, prefix: '', hunkId: null, oldLine: side === 'old' ? line.lineNumber : null, newLine: side === 'new' ? line.lineNumber : null, side, selectable: true }) : null
  const rows: WorkspaceSideBySideRow[] = alignment.pairs.map(pair => {
    const l = pair.leftIndex === null ? undefined : left[pair.leftIndex], r = pair.rightIndex === null ? undefined : right[pair.rightIndex]
    const equal = !!l && !!r && l.text === r.text
    return { id: `table-${l?.lineNumber ?? 'x'}-${r?.lineNumber ?? 'x'}`, kind: equal ? 'context' : 'change', hunkId: null, ...(l && r && l.ending !== r.ending ? { lineEndingDifference: { left: l.ending, right: r.ending } } : {}), left: source(l, 'old', equal), right: source(r, 'new', equal) }
  })
  return { kind: 'comparison', files: [{ id: 'table', oldPath: comparison.left.source.path, newPath: comparison.right.source.path, source: { id: 'table', oldPath: comparison.left.source.path, newPath: comparison.right.source.path, rows: [] }, rows, sections: [], complete: true }], sections: [], fullViewUnavailableReason: null, diagnostics: { alignment: alignment.diagnostics, comparison: [] } }
}
