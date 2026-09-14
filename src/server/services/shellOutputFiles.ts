import path from 'node:path'
import type { MessageEntry } from './sessionService.js'
import { collectSuccessfulToolUseIds } from './transcriptToolResults.js'
import { recordedCommandIsReadOnly } from '../../tools/BashTool/readOnlyValidation.js'

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('\n')
}

// A receipt is display evidence only. It must never create an undo baseline or
// grant filesystem access. Do not infer writes from commands, links or ls output.
export function collectShellOutputFiles(messages: MessageEntry[], workDir: string): string[] {
  const successful = collectSuccessfulToolUseIds(messages)
  const calls = new Map<string, { command: string; cwd: string }>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'tool_use' || !/^(bash|powershell)$/i.test(block.name ?? '') ||
        !successful.has(block.id) || typeof block.input?.command !== 'string') continue
      if (recordedCommandIsReadOnly(block.input.command)) continue
      calls.set(block.id, { command: block.input.command, cwd: message.cwd || workDir })
    }
  }
  const files = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'tool_result' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'tool_result') continue
      const call = calls.get(block.tool_use_id)
      if (!call) continue
      for (const line of textContent(block.content).split(/\r?\n/)) {
        const receipt = /^written:\s+(.+?)\s+\(\d+ bytes\)\s*$/i.exec(line)
        if (!receipt) continue
        const file = receipt[1]!
        if (/[\x00-\x1f]/.test(file) || /^(?:[\\/]{2}|[a-z]+:\/\/)/i.test(file)) continue
        const windows = /^[a-z]:[\\/]/i.test(file) || /^[a-z]:[\\/]/i.test(call.cwd)
        const paths = windows ? path.win32 : path.posix
        let cwd = call.cwd
        if (!paths.isAbsolute(file)) {
          // Only resolve an unambiguous literal leading directory change.
          const cd = /^\s*(?:cd|Set-Location(?:\s+-LiteralPath)?)\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|$`]+))\s*(?:&&|;)\s*/i.exec(call.command)
          const rest = cd ? call.command.slice(cd[0].length) : call.command
          if (/(?:^|[;&|\n])\s*(?:cd|pushd|popd|Set-Location)\b/i.test(rest)) continue
          if (cd) cwd = paths.resolve(cwd, cd[1] ?? cd[2] ?? cd[3]!)
          if (!paths.isAbsolute(cwd)) continue
        }
        files.add(paths.resolve(cwd, file).replace(/\\/g, '/'))
      }
    }
  }
  return [...files]
}
