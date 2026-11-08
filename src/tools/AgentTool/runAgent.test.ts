import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import type { CustomAgentDefinition } from './loadAgentsDir.js'
import {
  runAgent,
  resolveSubagentEffortValue,
  resolveSubagentThinkingConfig,
} from './runAgent.js'

describe('subagent runtime configuration', () => {
  test('routes the real agent generator through an isolated child and retains its execution limits', async () => {
    await mkdir(resolve('artifacts'), { recursive: true })
    const directory = await mkdtemp(join(resolve('artifacts'), 'agent-generator-'))
    const fakeCli = join(directory, 'fake.ts')
    await mkdir(join(directory, 'config'), { recursive: true })
    await writeFile(fakeCli, `console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({args:process.argv.slice(2),effort:process.env.CLAUDE_CODE_EFFORT_LEVEL,thinking:process.env.MAX_THINKING_TOKENS})}))`)
    const saved = { config: process.env.CLAUDE_CONFIG_DIR, cli: process.env.CLAUDE_CLI_PATH }
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
    process.env.CLAUDE_CLI_PATH = fakeCli
    const definition: CustomAgentDefinition = { agentType: 'route-probe', whenToUse: 'Probe', source: 'projectSettings', rawSystemPrompt: 'Probe', getSystemPrompt: () => 'Probe' }
    const state = getDefaultAppState()
    const context = {
      options: { commands: [], tools: [], mcpClients: [], mcpResources: {}, mainLoopModel: 'parent-model', thinkingConfig: { type: 'disabled' }, agentDefinitions: { activeAgents: [definition], allAgents: [definition] } },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(),
      getAppState: () => state, setAppState: () => {}, setResponseLength: () => {}, messages: [],
    } as unknown as ToolUseContext
    try {
      const messages = []
      for await (const message of runAgent({ agentDefinition: definition, promptMessages: [], toolUseContext: context,
        canUseTool: (async () => ({ behavior: 'deny', message: 'No tools' })) as never,
        isAsync: false, querySource: 'agent:custom', availableTools: [], model: 'grok-4.7', effort: 'medium', maxTurns: 3,
        override: { userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
      })) messages.push(message)
      const assistant = messages.find(message => message.type === 'assistant')
      expect(assistant?.type).toBe('assistant')
      const text = assistant?.type === 'assistant' ? assistant.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
      expect(text).toContain('"model":"grok-4.7"')
      expect(text).toContain('"effort":"medium"')
      expect(text).toContain('"thinking":"0"')
      expect(text).toContain('"--max-turns","3"')
      expect(context.options.mainLoopModel).toBe('parent-model')
    } finally {
      if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved.config
      if (saved.cli === undefined) delete process.env.CLAUDE_CLI_PATH
      else process.env.CLAUDE_CLI_PATH = saved.cli
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
  test('inherits the parent thinking configuration for regular and fork agents', () => {
    const disabled = { type: 'disabled' } as const
    const enabled = { type: 'enabled', budgetTokens: 4096 } as const
    const adaptive = { type: 'adaptive' } as const

    expect(resolveSubagentThinkingConfig(disabled)).toBe(disabled)
    expect(resolveSubagentThinkingConfig(enabled)).toBe(enabled)
    expect(resolveSubagentThinkingConfig(adaptive)).toBe(adaptive)
  })

  test('agent effort overrides the parent independently of disabled thinking', () => {
    const thinking = resolveSubagentThinkingConfig({ type: 'disabled' })
    const effort = resolveSubagentEffortValue('low', 'high')

    expect(thinking).toEqual({ type: 'disabled' })
    expect(effort).toBe('low')
    expect(resolveSubagentEffortValue(undefined, 'xhigh')).toBe('xhigh')
  })

  test('applies inherited thinking and definition effort to the constructed agent context', async () => {
    const thinkingConfig = { type: 'enabled', budgetTokens: 2048 } as const
    const agentDefinition: CustomAgentDefinition = {
      agentType: 'runtime-reviewer',
      whenToUse: 'Review runtime propagation',
      rawSystemPrompt: 'Review carefully.',
      getSystemPrompt: () => 'Review carefully.',
      source: 'projectSettings',
      model: 'gpt-5.6-luna',
      effort: 'low',
    }
    const parentState = {
      ...getDefaultAppState(),
      effortValue: 'high' as const,
    }
    const parentContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: [],
        verbose: false,
        thinkingConfig,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {
          activeAgents: [agentDefinition],
          allAgents: [agentDefinition],
        },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(),
      getAppState: () => parentState,
      setAppState: () => {},
      setResponseLength: () => {},
      messages: [],
    } as unknown as ToolUseContext
    let capturedContext: ToolUseContext | undefined
    const stopAfterContext = new Error('context captured')

    const generator = runAgent({
      agentDefinition,
      promptMessages: [],
      toolUseContext: parentContext,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync: false,
      querySource: 'agent:custom',
      override: {
        userContext: {},
        systemContext: {},
        systemPrompt: asSystemPrompt([]),
        agentId: 'runtime-agent-id' as never,
      },
      availableTools: [],
      onCacheSafeParams: params => {
        capturedContext = params.toolUseContext
        throw stopAfterContext
      },
    })

    await expect(generator.next()).rejects.toBe(stopAfterContext)
    expect(capturedContext?.options.mainLoopModel).toBe('gpt-5.6-luna')
    expect(capturedContext?.options.thinkingConfig).toBe(thinkingConfig)
    expect(capturedContext?.getAppState().effortValue).toBe('low')
  })

  test('explicit effort overrides the definition without mutating the parent', async () => {
    const definition: CustomAgentDefinition = {
      agentType: 'effort-reviewer', whenToUse: 'Review', source: 'projectSettings',
      rawSystemPrompt: 'Review', getSystemPrompt: () => 'Review', effort: 'low',
    }
    const parent = { ...getDefaultAppState(), effortValue: 'medium' as const }
    const context = {
      options: { commands: [], tools: [], mcpClients: [], mcpResources: {},
        mainLoopModel: 'gpt-test', thinkingConfig: { type: 'disabled' },
        agentDefinitions: { activeAgents: [definition], allAgents: [definition] } },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(),
      getAppState: () => parent, setAppState: () => {}, setResponseLength: () => {}, messages: [],
    } as unknown as ToolUseContext
    let child: ToolUseContext | undefined
    const stop = new Error('captured')
    const generator = runAgent({
      agentDefinition: definition, promptMessages: [], toolUseContext: context,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync: false, querySource: 'agent:custom', availableTools: [], effort: 'high',
      override: { userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
      onCacheSafeParams: params => { child = params.toolUseContext; throw stop },
    })
    await expect(generator.next()).rejects.toBe(stop)
    expect(child?.getAppState().effortValue).toBe('high')
    expect(child?.options.effortValueOverridesEnv).toBe(true)
    expect(parent.effortValue).toBe('medium')
    expect(definition.effort).toBe('low')
  })

  test('prevents repository agents from elevating a default parent to bypassPermissions', async () => {
    async function capturePermissionMode(
      source: CustomAgentDefinition['source'] | 'built-in' | 'policySettings',
    ): Promise<string | undefined> {
      const agentDefinition = {
        agentType: `permission-reviewer-${source}`,
        whenToUse: 'Review permission propagation',
        rawSystemPrompt: 'Review carefully.',
        getSystemPrompt: () => 'Review carefully.',
        source,
        permissionMode: 'bypassPermissions' as const,
      } as CustomAgentDefinition
      const parentState = getDefaultAppState()
      const parentContext = {
        options: {
          commands: [],
          debug: false,
          mainLoopModel: 'sonnet',
          tools: [],
          verbose: false,
          thinkingConfig: { type: 'disabled' as const },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: false,
          agentDefinitions: {
            activeAgents: [agentDefinition],
            allAgents: [agentDefinition],
          },
        },
        abortController: new AbortController(),
        readFileState: createFileStateCacheWithSizeLimit(),
        getAppState: () => parentState,
        setAppState: () => {},
        setResponseLength: () => {},
        messages: [],
      } as unknown as ToolUseContext
      let capturedContext: ToolUseContext | undefined
      const stopAfterContext = new Error('context captured')

      const generator = runAgent({
        agentDefinition,
        promptMessages: [],
        toolUseContext: parentContext,
        canUseTool: (async () => ({ behavior: 'allow' })) as never,
        isAsync: false,
        querySource: 'agent:custom',
        override: {
          userContext: {},
          systemContext: {},
          systemPrompt: asSystemPrompt([]),
          agentId: `permission-agent-${source}` as never,
        },
        availableTools: [],
        onCacheSafeParams: params => {
          capturedContext = params.toolUseContext
          throw stopAfterContext
        },
      })

      await expect(generator.next()).rejects.toBe(stopAfterContext)
      return capturedContext?.getAppState().toolPermissionContext.mode
    }

    expect(await capturePermissionMode('projectSettings')).toBe('default')
    expect(await capturePermissionMode('localSettings')).toBe('default')
    expect(await capturePermissionMode('userSettings')).toBe(
      'bypassPermissions',
    )
    expect(await capturePermissionMode('policySettings')).toBe(
      'bypassPermissions',
    )
    expect(await capturePermissionMode('built-in')).toBe('bypassPermissions')
  })
})
