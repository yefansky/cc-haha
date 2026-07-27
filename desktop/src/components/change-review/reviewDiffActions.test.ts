import { describe, expect, it } from 'vitest'
import { buildHunkRevertContent } from './reviewDiffActions'

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' first',
  '-before',
  '+after',
  ' last',
].join('\n')

describe('buildHunkRevertContent', () => {
  it('reverses exactly one matching review hunk', () => {
    expect(buildHunkRevertContent('first\nafter\nlast\n', diff, 'src/a.ts', 'file-0-hunk-0')).toBe(
      'first\nbefore\nlast\n',
    )
  })

  it('refuses to overwrite a stale or ambiguous stacked edit', () => {
    expect(buildHunkRevertContent('first\nlater\nlast\n', diff, 'src/a.ts', 'file-0-hunk-0')).toBeNull()
    expect(buildHunkRevertContent('first\nafter\nlast\nfirst\nafter\nlast\n', diff, 'src/a.ts', 'file-0-hunk-0')).toBeNull()
  })
})
