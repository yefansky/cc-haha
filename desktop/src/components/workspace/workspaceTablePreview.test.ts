import { describe, expect, it } from 'vitest'
import { getWorkspaceTableDelimiter, isWorkspaceTablePath, parseWorkspaceTable } from './workspaceTablePreview'

describe('workspaceTablePreview', () => {
  it('parses quoted CSV fields, escaped quotes, and embedded newlines', () => {
    expect(parseWorkspaceTable('name,note\r\nAlice,"hello, world"\r\nBob,"line 1\nline ""2"""\r\n', 'people.csv')).toMatchObject({
      rows: [
        ['name', 'note'],
        ['Alice', 'hello, world'],
        ['Bob', 'line 1\nline "2"'],
      ],
      columnCount: 2,
    })
  })

  it('parses .tab and .tsv files as tab-delimited tables and pads ragged rows', () => {
    expect(getWorkspaceTableDelimiter('data.tab')).toBe('\t')
    expect(getWorkspaceTableDelimiter('data.tsv')).toBe('\t')
    expect(parseWorkspaceTable('id\tname\tscore\n1\tAlice\t98\n2\tBob', 'scores.tab').rows).toEqual([
      ['id', 'name', 'score'],
      ['1', 'Alice', '98'],
      ['2', 'Bob', ''],
    ])
  })

  it('recognizes only supported table extensions', () => {
    expect(isWorkspaceTablePath('report.CSV')).toBe(true)
    expect(isWorkspaceTablePath('report.tab')).toBe(true)
    expect(isWorkspaceTablePath('report.tsv')).toBe(true)
    expect(isWorkspaceTablePath('report.txt')).toBe(false)
  })
})
