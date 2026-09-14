import { describe, expect, it } from 'bun:test'
import { collectShellOutputFiles } from './shellOutputFiles.js'
import type { MessageEntry } from './sessionService.js'

function transcript(command: string, output: unknown, options: { error?: boolean; cwd?: string; name?: string } = {}): MessageEntry[] {
  return [
    { id: 'call', type: 'assistant', timestamp: '', cwd: options.cwd, content: [{ type: 'tool_use', id: 'tool', name: options.name ?? 'Bash', input: { command } }] },
    { id: 'result', type: 'tool_result', timestamp: '', content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: options.error, content: output }] },
  ]
}

describe('script output receipts', () => {
  it('recovers both real board receipt shapes and deduplicates repeated builds', () => {
    const messages = transcript('cd "G:/project" && python build.py --out report.html 2>&1 | tail -10',
      'written: 项目大脑/看板/完整.html (3427432 bytes)\nwritten: 项目大脑/看板\\简版.html (3357714 bytes)\nwritten: 项目大脑/看板/完整.html (3427499 bytes)')
    expect(collectShellOutputFiles(messages, 'G:/other')).toEqual([
      'G:/project/项目大脑/看板/完整.html', 'G:/project/项目大脑/看板/简版.html',
    ])
    expect(collectShellOutputFiles(JSON.parse(JSON.stringify(messages)), 'G:/other')).toEqual(collectShellOutputFiles(messages, 'G:/other'))
  })
  it('uses persisted tool cwd and PowerShell literal location with structured text', () => {
    expect(collectShellOutputFiles(transcript("Set-Location -LiteralPath 'C:/工作'; python build.py", [{ type: 'text', text: 'written: board.html (12 bytes)' }], { name: 'PowerShell', cwd: 'D:/cwd' }), 'E:/fallback')).toEqual(['C:/工作/board.html'])
    expect(collectShellOutputFiles(transcript('python build.py', 'written: board.html (12 bytes)', { cwd: '/child' }), '/root')).toEqual(['/child/board.html'])
  })
  it('ignores failed, unmatched, read-only, prose, links and directory listings', () => {
    expect(collectShellOutputFiles(transcript('python build.py', 'written: report.html (1 bytes)', { error: true }), '/repo')).toEqual([])
    expect(collectShellOutputFiles(transcript('cat log.txt', 'written: report.html (1 bytes)'), '/repo')).toEqual([])
    const messages = transcript('python build.py', 'see report.html\n-rw-r-- 1 user report.html\n[board](report.html)\n1 written: report.html (1 bytes)')
    expect(collectShellOutputFiles(messages, '/repo')).toEqual([])
    expect(collectShellOutputFiles(messages.slice(1), '/repo')).toEqual([])
  })
  it('rejects ambiguous relative locations and nonlocal addresses', () => {
    for (const command of ['cd "$OUT" && python build.py', 'cd /one && cd /two && python build.py', 'pushd /one; python build.py']) {
      expect(collectShellOutputFiles(transcript(command, 'written: board.html (10 bytes)'), '/repo')).toEqual([])
    }
    expect(collectShellOutputFiles(transcript('python build.py', 'written: https://host/a.html (1 bytes)\nwritten: //server/share/a.html (1 bytes)'), '/repo')).toEqual([])
  })
})
