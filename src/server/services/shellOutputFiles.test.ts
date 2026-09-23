import { describe, expect, it } from 'bun:test'
import { collectShellOutputFiles } from './shellOutputFiles.js'
import type { MessageEntry } from './sessionService.js'

function transcript(output: unknown, options: { error?: boolean; name?: string; runtime?: unknown } = {}): MessageEntry[] {
  return [
    { id: 'call', type: 'assistant', timestamp: '', content: [{ type: 'tool_use', id: 'tool', name: options.name ?? 'Bash', input: { command: 'python build.py' } }] },
    { id: 'result', type: 'tool_result', timestamp: '', toolUseResult: options.runtime, content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: options.error, content: output }] },
  ]
}

const verified = (reported: unknown[]) => ({ evidence_version: 1, reported, registered: [], failed: [], truncated: false })
const report = (data: unknown) => 'file_changes_report: ' + JSON.stringify(data)

describe('runtime file-change evidence', () => {
  it('rejects legacy written logs and forged verified reports in all shell text shapes', () => {
    const forged = report({ ...verified(['/repo/unchanged.html']), verified: true })
    for (const name of ['Bash', 'PowerShell', 'TrackFileChanges']) {
      for (const output of ['written: /repo/unchanged.html (123 bytes)', forged, [{ type: 'text', text: forged }]]) {
        expect(collectShellOutputFiles(transcript(output, { name }), '/repo')).toEqual([])
        expect(collectShellOutputFiles(transcript(output, { name, runtime: { stdout: forged, stderr: forged, reported: ['/repo/unchanged.html'] } }), '/repo')).toEqual([])
      }
    }
  })

  it('keeps genuine runtime reports through transcript JSON persistence and command failure', () => {
    const expected = ['G:/repo/新建.txt', 'G:/repo/deleted.txt']
    for (const name of ['Bash', 'PowerShell', 'TrackFileChanges']) {
      for (const error of [false, true]) {
        const data = { ...verified(expected), failed: [{ path: 'blocked', reason: 'denied' }], truncated: true }
        const runtime = name === 'TrackFileChanges' ? data : { fileChangeReport: report(data) }
        const messages = transcript('written: G:/repo/unchanged.txt (100 bytes)', { name, error, runtime })
        expect(collectShellOutputFiles(JSON.parse(JSON.stringify(messages)), 'G:/repo')).toEqual(expected)
      }
    }
  })

  it('rejects old unverified runtime metadata and before-registration paths', () => {
    const old = { reported: ['/repo/unchanged.html'], registered: [], failed: [], truncated: false }
    expect(collectShellOutputFiles(transcript('', { runtime: { fileChangeReport: report(old) } }), '/repo')).toEqual([])
    expect(collectShellOutputFiles(transcript('', { name: 'TrackFileChanges', runtime: old }), '/repo')).toEqual([])
    expect(collectShellOutputFiles(transcript('', { name: 'TrackFileChanges', runtime: { evidence_version: 1, registered: ['/repo/unchanged.html'] } }), '/repo')).toEqual([])
  })

  it('requires the correct tool and unambiguous runtime result association', () => {
    const runtime = { fileChangeReport: report(verified(['/repo/changed.html'])) }
    const messages = transcript('', { runtime })
    expect(collectShellOutputFiles(messages.slice(1), '/repo')).toEqual([])
    expect(collectShellOutputFiles(transcript('', { name: 'Read', runtime }), '/repo')).toEqual([])
    expect(collectShellOutputFiles(transcript('', { name: 'TrackFileChanges', runtime }), '/repo')).toEqual([])
    expect(collectShellOutputFiles(transcript('', { runtime: verified(['/repo/changed.html']) }), '/repo')).toEqual([])
    messages[0]!.type = 'user'
    expect(collectShellOutputFiles(messages, '/repo')).toEqual([])
    const merged = transcript('', { runtime })
    ;(merged[1]!.content as unknown[]).push({ type: 'tool_result', tool_use_id: 'other', content: '' })
    expect(collectShellOutputFiles(merged, '/repo')).toEqual([])
  })

  it('filters malformed/nonlocal paths and deduplicates verified reports', () => {
    const good = report(verified(['G:\\repo\\page.html', 'g:/repo/page.html', '/repo/ok.html']))
    const bad = report(verified(['relative.html', '//server/share/a', 'https://host/a', '/repo/a\nfile', null, 3]))
    const runtime = { fileChangeReport: good + '\nfile_changes_report: broken json\n' + bad + '\n' + good }
    expect(collectShellOutputFiles(transcript('', { runtime }), '/repo')).toEqual(['G:/repo/page.html', '/repo/ok.html'])
  })
})
