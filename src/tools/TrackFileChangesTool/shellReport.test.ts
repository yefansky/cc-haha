import { expect, test } from 'bun:test'
import { finishShellFileChanges } from './shellReport.js'
import { ShellError } from '../../utils/errors.js'
import { formatError } from '../../utils/toolErrors.js'
import type { ToolUseContext } from '../../Tool.js'

test('background manifests remain pending instead of capturing an unfinished inventory', async () => {
  const report = await finishShellFileChanges('/fresh/manifest.json', true, {} as ToolUseContext)
  expect(report).toContain('pending')
  expect(report).toContain('TrackFileChanges')
  expect(report).not.toContain('file_changes_report: ')
})
test('error formatting preserves large change inventories independently of console truncation', () => {
  const report = 'file_changes_report: ' + JSON.stringify({ reported: Array.from({ length: 500 }, (_, i) => `/repo/path/to/file-${i}.txt`), failed: [], truncated: false })
  const error = new ShellError('x'.repeat(30000), '', 3, false, report)
  const formatted = formatError(error)
  expect(formatted).toContain(report)
  expect(formatted).toContain('characters truncated')
})
