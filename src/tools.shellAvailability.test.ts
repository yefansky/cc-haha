import { afterAll, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from './Tool.js'
import { tryFindGitBashPath } from './utils/windowsPaths.js'

const originalGitBashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
const originalSimple = process.env.CLAUDE_CODE_SIMPLE

function clearGitBashPathCache(): void {
  const memoizedTryFindGitBashPath =
    tryFindGitBashPath as typeof tryFindGitBashPath & {
      cache: { clear(): void }
    }
  memoizedTryFindGitBashPath.cache.clear()
}

afterAll(() => {
  if (originalGitBashPath === undefined) {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
  } else {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = originalGitBashPath
  }

  if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = originalSimple
  clearGitBashPathCache()
})

describe('Windows shell tool exposure', () => {
  test('keeps file-change registration available to main and async agents and in the simple system prompt', async () => {
    const { getAllBaseTools } = await import('./tools.js')
    const { ASYNC_AGENT_ALLOWED_TOOLS } = await import('./constants/tools.js')
    const { getSystemPrompt } = await import('./constants/prompts.js')
    const tool = getAllBaseTools().find(tool => tool.name === 'TrackFileChanges')!
    expect(tool).toBeDefined()
    expect(tool.alwaysLoad).toBe(true)
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)).toBe(true)
    process.env.CLAUDE_CODE_SIMPLE = '1'
    const prompt = (await getSystemPrompt([tool], 'test-model')).join('\n')
    expect(prompt).toContain('call TrackFileChanges and wait for registration')
  })

  test('substitutes PowerShell for Bash when Git Bash is unavailable', async () => {
    if (process.platform !== 'win32') return

    process.env.CLAUDE_CODE_GIT_BASH_PATH =
      'C:\\missing-git-bash\\bash.exe'
    clearGitBashPathCache()
    const { getAllBaseTools, getTools } = await import('./tools.js')

    const baseToolNames = getAllBaseTools().map(tool => tool.name)
    expect(baseToolNames).toContain('PowerShell')
    expect(baseToolNames).toContain('TrackFileChanges')
    expect(baseToolNames).not.toContain('Bash')

    process.env.CLAUDE_CODE_SIMPLE = '1'
    const simpleToolNames = getTools(getEmptyToolPermissionContext()).map(
      tool => tool.name,
    )
    expect(simpleToolNames).toEqual(['PowerShell', 'Read', 'TrackFileChanges', 'Edit'])
  })
})
