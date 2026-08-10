export const WORKSPACE_TABLE_ROW_LIMIT = 1_000
export const WORKSPACE_TABLE_COLUMN_LIMIT = 100

export type WorkspaceTablePreview = {
  rows: string[][]
  columnCount: number
  truncatedRows: number
  truncatedColumns: number
}

export function isWorkspaceTablePath(path: string) {
  return /\.(?:csv|tab|tsv)$/i.test(path)
}

export function getWorkspaceTableDelimiter(path: string) {
  return /\.(?:tab|tsv)$/i.test(path) ? '\t' : ','
}

function parseDelimitedRows(value: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  const pushCell = () => {
    row.push(cell)
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    rows.push(row)
    row = []
  }

  const source = value.replace(/^\uFEFF/, '')
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += character
      }
      continue
    }

    if (character === '"' && cell.length === 0) {
      quoted = true
    } else if (character === delimiter) {
      pushCell()
    } else if (character === '\n') {
      pushRow()
    } else if (character === '\r') {
      if (source[index + 1] === '\n') index += 1
      pushRow()
    } else {
      cell += character
    }
  }

  if (cell.length > 0 || row.length > 0 || !/[\r\n]$/.test(source)) pushRow()
  return rows
}

export function parseWorkspaceTable(value: string, path: string): WorkspaceTablePreview {
  if (!value) return { rows: [], columnCount: 0, truncatedRows: 0, truncatedColumns: 0 }

  const parsedRows = parseDelimitedRows(value, getWorkspaceTableDelimiter(path))
  const sourceColumnCount = parsedRows.reduce((count, row) => Math.max(count, row.length), 0)
  const rows = parsedRows
    .slice(0, WORKSPACE_TABLE_ROW_LIMIT)
    .map((row) => row.slice(0, WORKSPACE_TABLE_COLUMN_LIMIT))
  const columnCount = Math.min(sourceColumnCount, WORKSPACE_TABLE_COLUMN_LIMIT)

  return {
    rows: rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? '')),
    columnCount,
    truncatedRows: Math.max(0, parsedRows.length - rows.length),
    truncatedColumns: Math.max(0, sourceColumnCount - columnCount),
  }
}
