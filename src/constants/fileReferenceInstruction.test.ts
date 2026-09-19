import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { FILE_REFERENCE_INSTRUCTION, fileReferenceInstructionFor } from './fileReferenceInstruction.js'

let proactive = false
// Real prompt assembly with deterministic environment/data sources. No model calls.
const originalMacro = (globalThis as any).MACRO
;(globalThis as any).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'use the test issue tracker' }
mock.module('../proactive/index.js', () => ({ isProactiveActive: () => proactive }))
const commands = await import('../commands.js')
const styles = await import('./outputStyles.js')
const memory = await import('../memdir/memdir.js')
const settings = await import('../utils/settings/settings.js')
const git = await import('../utils/git.js')
const { spyOn } = await import('bun:test')
spyOn(commands, 'getSkillToolCommands').mockResolvedValue([])
spyOn(styles, 'getOutputStyleConfig').mockResolvedValue(null)
spyOn(memory, 'loadMemoryPrompt').mockResolvedValue(null)
spyOn(settings, 'getInitialSettings').mockReturnValue({})
spyOn(git, 'getIsGit').mockResolvedValue(false)
const { getSystemPrompt, enhanceSystemPromptWithEnvDetails } = await import('./prompts.js')
const previousSimple = process.env.CLAUDE_CODE_SIMPLE
const previousUserType = process.env.USER_TYPE
beforeEach(() => { delete process.env.CLAUDE_CODE_SIMPLE; delete process.env.USER_TYPE; proactive = false })
afterAll(() => {
  if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE; else process.env.CLAUDE_CODE_SIMPLE = previousSimple
  if (previousUserType === undefined) delete process.env.USER_TYPE; else process.env.USER_TYPE = previousUserType
  if (originalMacro === undefined) delete (globalThis as any).MACRO; else (globalThis as any).MACRO = originalMacro
  mock.restore()
})
function verify(prompt: string[]) {
  expect(prompt.join('\n').split(FILE_REFERENCE_INSTRUCTION).length - 1).toBe(1)
}
test('main assembly includes shared guidance even without tracking tools', async () => {
  const prompt = await getSystemPrompt([], 'test')
  verify(prompt)
  expect(prompt.some(s => s.includes('# Tone and style'))).toBe(true)
})
test('minimal assembly includes shared guidance without depending on normal sections', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const prompt = await getSystemPrompt([], 'test')
  verify(prompt)
  expect(prompt.some(s => s.includes('# Tone and style'))).toBe(false)
})
test('proactive early return includes shared guidance', async () => {
  proactive = true
  const built = await Bun.build({ entrypoints: [import.meta.dir + '/prompts.ts'], target: 'bun', features: ['PROACTIVE'], external: ['*'] })
  expect(built.success).toBe(true)
  const fixture = import.meta.dir + '/.file-reference-proactive-' + crypto.randomUUID() + '.mjs'
  let prompt: string[]
  try {
    await Bun.write(fixture, await built.outputs[0]!.text())
    const active = await import(fixture)
    prompt = await active.getSystemPrompt([], 'test')
  } finally { await (await import('node:fs/promises')).unlink(fixture) }
  expect(prompt!.join('\n')).toContain('You are an autonomous agent')
  verify(prompt)
})
test('subagent assembly preserves caller prompt and avoids duplicate inherited rules', async () => {
  const original = ['Keep my task-specific instruction.']
  const enhanced = await enhanceSystemPromptWithEnvDetails(original, 'test', [], new Set())
  expect(enhanced[0]).toBe(original[0])
  expect(original).toEqual(['Keep my task-specific instruction.'])
  verify(enhanced)
  verify(await enhanceSystemPromptWithEnvDetails(enhanced, 'test', [], new Set()))
  verify(await enhanceSystemPromptWithEnvDetails(await getSystemPrompt([], 'test'), 'test'))
})
test('guidance covers progress references and planned artifacts without inventing receipts', () => {
  expect(FILE_REFERENCE_INSTRUCTION).toContain('every user-visible message')
  expect(FILE_REFERENCE_INSTRUCTION).toContain('complete absolute path')
  expect(FILE_REFERENCE_INSTRUCTION).toContain('file has not been generated yet')
  expect(FILE_REFERENCE_INSTRUCTION).toContain('do not format it as a file link')
  expect(FILE_REFERENCE_INSTRUCTION).toContain('existing successful-write receipt guidance')
  expect(FILE_REFERENCE_INSTRUCTION).not.toContain('written:')
  expect(fileReferenceInstructionFor([`prefix\n${FILE_REFERENCE_INSTRUCTION}\nsuffix`])).toEqual([])
})
