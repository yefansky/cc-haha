import { expect, it } from 'vitest'
import type { WorkspaceComparisonSide } from '@/api/sessions'
import { buildWorkspaceTableModel } from './workspaceTableCompareModel'
const side = (content: string): WorkspaceComparisonSide => ({ source: { kind: 'working_tree', path: 'x.tab', revision: '' }, exists: true, state: 'ok', content, requestedEncoding: 'auto', actualEncoding: 'gbk', bom: 'none', lineEnding: 'mixed', writable: true })
it('aligns duplicate identifiers across LF and CRLF using content anchors', () => {
 const left = side('ID\tName\tValue\n1\tsame\tx\n1\tsame\ty\n1\tsame\tz\n')
 const right = side('ID\tName\tValue\r\n1\tsame\tx\r\nnew\tinserted\t\r\n1\tsame\ty\r\n1\tsame\tz\r\n')
 const model=buildWorkspaceTableModel({schemaVersion:1,left,right},'x.tab')
 expect(model.files[0]!.rows.map(row=>[row.left?.oldLine ?? null,row.right?.newLine ?? null])).toEqual([[1,1],[2,2],[null,3],[3,4],[4,5]])
 expect(model.diagnostics.alignment.some(item=>item.reason)).toBe(false)
})
it('preserves missing trailing fields versus present empty cells', () => {
 const model=buildWorkspaceTableModel({schemaVersion:1,left:side('ID\tA\tB\n1\tvalue\n'),right:side('ID\tA\tB\n1\tvalue\t\n')},'x.tab')
 expect(model.files[0]!.rows[1]!.kind).toBe('change')
 expect(model.files[0]!.rows[1]!.right!.text).toBe('1\tvalue\t')
})
