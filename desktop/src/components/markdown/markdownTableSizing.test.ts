import { describe, expect, it } from 'vitest'
import { allocateTableWidths, MAX_COLUMN_WIDTH } from './markdownTableSizing'

describe('document table width allocation', () => {
  const columns = [
    { natural: 78, min: 72 },
    { natural: 140, min: 90 },
    { natural: 600, min: 130 },
    { natural: 900, min: 120 },
  ]

  it('keeps every column on one line when its natural width fits', () => {
    expect(allocateTableWidths(columns, 1800, new Map())).toEqual([78, 140, 600, 900])
  })

  it('protects short names and identifiers while sharing space between prose columns', () => {
    const widths = allocateTableWidths(columns, 1000, new Map())
    expect(widths.slice(0, 2)).toEqual([78, 140])
    expect(widths.reduce((a, b) => a + b)).toBeCloseTo(1000)
    expect(widths[3]).toBeGreaterThan(widths[2]!)
    expect(widths[2]).toBeGreaterThanOrEqual(180)
  })

  it('overflows the table instead of crushing its readable minimum widths', () => {
    expect(allocateTableWidths(columns, 300, new Map())).toEqual([78, 140, 180, 180])
  })

  it('preserves manually chosen widths across panel sizes', () => {
    for (const available of [300, 900, 1800]) {
      expect(allocateTableWidths(columns, available, new Map([[2, 430]]))[2]).toBe(430)
    }
  })

  it('bounds pathological content and manual widths', () => {
    expect(allocateTableWidths([{ natural: 10000, min: 72 }], 10000, new Map())).toEqual([MAX_COLUMN_WIDTH])
    expect(allocateTableWidths(columns, 2000, new Map([[0, -50], [1, 10000]])).slice(0, 2)).toEqual([72, MAX_COLUMN_WIDTH])
  })

  it('is deterministic and does not change caller measurements or manual state', () => {
    const manual = new Map([[1, 160]])
    const original = structuredClone(columns)
    const first = allocateTableWidths(columns, 700, manual)
    allocateTableWidths(columns, 1300, manual)
    expect(allocateTableWidths(columns, 700, manual)).toEqual(first)
    expect(columns).toEqual(original)
    expect([...manual]).toEqual([[1, 160]])
  })
})
