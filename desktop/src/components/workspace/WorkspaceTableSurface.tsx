import { useMemo } from 'react'
import { useTranslation } from '../../i18n'
import { parseWorkspaceTable } from './workspaceTablePreview'

export function WorkspaceTableSurface({ value, path }: { value: string; path: string }) {
  const t = useTranslation()
  const table = useMemo(() => parseWorkspaceTable(value, path), [path, value])
  const header = table.rows[0] ?? []
  const body = table.rows.slice(1)

  if (table.rows.length === 0 || table.columnCount === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-surface)] text-xs text-[var(--color-text-tertiary)]">
        {t('workspace.tableEmpty')}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]" data-testid="workspace-table">
      <table className="min-w-full w-max border-separate border-spacing-0 font-mono text-[12px] text-[var(--color-text-primary)]">
        <thead className="sticky top-0 z-20 bg-[var(--color-surface-container)]">
          <tr>
            <th className="sticky left-0 z-30 w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-surface-container)] px-2 py-2 text-right font-medium text-[var(--color-text-tertiary)]">#</th>
            {header.map((cell, columnIndex) => (
              <th
                key={columnIndex}
                className="max-w-[360px] border-b border-r border-[var(--color-border)] px-3 py-2 text-left font-semibold text-[var(--color-text-primary)] last:border-r-0"
                title={cell}
              >
                <span className="block whitespace-pre-wrap break-words">{cell || '\u00a0'}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="even:bg-[var(--color-surface-container-low)] hover:bg-[var(--color-surface-hover)]">
              <th className="sticky left-0 z-10 border-b border-r border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-right font-normal tabular-nums text-[var(--color-text-tertiary)]">
                {rowIndex + 2}
              </th>
              {row.map((cell, columnIndex) => (
                <td
                  key={columnIndex}
                  className="max-w-[360px] border-b border-r border-[var(--color-border)] px-3 py-1.5 align-top last:border-r-0"
                  title={cell}
                >
                  <span className="block whitespace-pre-wrap break-words">{cell || '\u00a0'}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(table.truncatedRows > 0 || table.truncatedColumns > 0) && (
        <div className="sticky bottom-0 border-t border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)] backdrop-blur">
          {t('workspace.tableTruncated', {
            rows: table.truncatedRows,
            columns: table.truncatedColumns,
          })}
        </div>
      )}
    </div>
  )
}
