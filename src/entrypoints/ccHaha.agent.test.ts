import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const event = (type: string, value: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
function reply(model: string, turn: number, tool?: { name: string; input: Record<string, unknown> }) {
  return new Response([
    event('message_start', { message: { id: `msg-agent-${turn}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: `tool-${turn}`, name: tool.name, input: {} } : { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'DONE fixture-bare-secret' } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
    event('message_stop', {}),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

test('real native agent denies unapproved edits, then reads, edits and executes verification with explicit tool rules', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-agent-'))
  const config = join(sandbox, 'config')
  const target = join(sandbox, 'output.txt')
  const verified = join(sandbox, 'verified.txt')
  await writeFile(target, 'original content')
  await mkdir(join(config, 'cc-haha'), { recursive: true })
  let turn = 0
  let allow = false
  const receivedResults: unknown[] = []
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method === 'HEAD') return new Response(null)
    const body = await req.json() as any
    if (new URL(req.url).pathname.includes('count_tokens')) return Response.json({ input_tokens: 3 })
    turn++
    if (turn > 1) receivedResults.push(body.messages.at(-1))
    if (turn === 1) return reply(body.model, turn, { name: 'Read', input: { file_path: target } })
    if (turn === 2) return reply(body.model, turn, { name: 'Edit', input: { file_path: target, old_string: 'original content', new_string: 'fixture content' } })
    if (allow && turn === 3) {
      const script = `if ((Get-Content -Raw -LiteralPath '${target.replaceAll("'", "''")}') -ne 'fixture content') { exit 3 }; Set-Content -LiteralPath '${verified.replaceAll("'", "''")}' -Value 'verified'`
      const command = process.platform === 'win32' ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` : `test "$(cat '${target}')" = 'fixture content' && printf verified > '${verified}'`
      return reply(body.model, turn, { name: 'Bash', input: { command, description: '验证测试文件', timeout: 10000 } })
    }
    return reply(body.model, turn)
  } })
  const providerBytes = JSON.stringify({ activeId: null, providers: [{ id: 'fixture', presetId: 'kscc', name: 'KSCC', apiKey: 'fixture-bare-secret', authStrategy: 'auth_token_empty_api_key', baseUrl: `http://127.0.0.1:${upstream.port}`, apiFormat: 'anthropic', models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' } }] })
  await writeFile(join(config, 'cc-haha/providers.json'), providerBytes)
  await writeFile(join(config, 'settings.json'), JSON.stringify({ network: { proxy: { mode: 'direct' } }, traceCapture: { enabled: true, fullBodies: true }, env: { CC_HAHA_HEADLESS_HOST: '0', CC_HAHA_TRACE_API_CALLS: '1', DEBUG: '1', DEBUG_SDK: '1', CLAUDE_CODE_DIAGNOSTICS_FILE: join(config, 'unsafe-diagnostics.jsonl') } }))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CLI_PATH: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CC_HAHA_SKIP_DOTENV: '1', CI: '1', NODE_ENV: 'production' }
  const run = async (rules: string[]) => {
    const launcher = process.env.CC_HAHA_TEST_COMPILED_EXECUTABLE ? [process.env.CC_HAHA_TEST_COMPILED_EXECUTABLE] : [process.execPath, resolve('bin/cc-haha')]
    const child = Bun.spawn([...launcher, '-p', 'Complete fixture', '--bare', '--provider', 'kscc', '--model', 'fixture-model', '--cwd', sandbox, '--output-format', 'json', '--timeout-ms', '20000', ...rules], { cwd: sandbox, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    const [text, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(text).not.toContain('fixture-bare-secret')
    return JSON.parse(text)
  }
  try {
    const denied = await run([])
    expect(denied.permission_denials.some((entry: any) => entry.tool_name === 'Edit')).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('original content')
    expect(turn).toBe(3)
    allow = true; turn = 0
    const allowed = await run(['--allowed-tools', 'Edit', 'Read', 'Bash'])
    expect(allowed.permission_denials).toEqual([])
    expect(allowed.tool_usage).toEqual({ Read: 1, Edit: 1, Bash: 1 })
    expect(await readFile(target, 'utf8')).toBe('fixture content')
    expect((await readFile(verified, 'utf8')).trim()).toBe('verified')
    expect(receivedResults.length).toBeGreaterThan(0)
    expect(await readFile(join(config, 'cc-haha/providers.json'), 'utf8')).toBe(providerBytes)
    // Existing credential storage is expected; newly emitted records may never contain it.
    for (const path of await readdir(config, { recursive: true })) {
      if (path === join('cc-haha', 'providers.json') || path === 'settings.json') continue
      const value = await readFile(join(config, path), 'utf8').catch(() => '')
      expect(value).not.toContain('fixture-bare-secret')
    }
  } finally { upstream.stop(true); await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined) }
}, 60000)
