import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHeadlessArguments, executeNativeHeadless, redactHeadlessText, redactHeadlessValue } from './ccHaha.js'

let sandbox: string
let mockCli: string
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-entry-'))
  mockCli = join(sandbox, 'fixture.ts')
  await writeFile(mockCli, `
const args = process.argv.slice(2)
if (args.includes('wait')) { setInterval(() => {}, 1000); await Bun.sleep(60000) }
const model = args[args.indexOf('--model') + 1]
console.log('diagnostic banner must not enter JSON')
console.error('Bearer must-not-escape-stderr')
console.log(JSON.stringify({type:'assistant',message:{id:'m1',model,usage:{input_tokens:3,output_tokens:1}}}))
console.log(JSON.stringify({type:'assistant',message:{id:'m1',model,usage:{input_tokens:3,output_tokens:2}}}))
console.log(JSON.stringify({type:'result',subtype:'success',result:process.cwd()+' '+process.env.ANTHROPIC_API_KEY,usage:{input_tokens:3,output_tokens:2},modelUsage:{[model]:{inputTokens:3,outputTokens:2}},duration_ms:12,is_error:args.includes('errorflag')}))
`)
})
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }) })

test('parses cwd before runtime and preserves native tool allow rules without bypass', () => {
  const options = parseHeadlessArguments(['-p', '修复测试', '--provider', 'tokenhub', '--model=a=b', '--cwd=中文 目=录', '--allowed-tools', 'Read', 'Edit', '--output-format=json'], sandbox)
  expect(options.cwd).toBe(join(sandbox, '中文 目=录'))
  expect(options.model).toBe('a=b')
  expect(options.nativeArgs).toEqual(['-p', '修复测试', '--allowed-tools', 'Read', 'Edit'])
  expect(options.json).toBe(true)
  expect(() => parseHeadlessArguments(['-p', 'OK', '--provider', 'bad', '--model', 'a'])).toThrow('服务商')
  expect(() => parseHeadlessArguments(['-p', 'OK', '--provider', 'kscc', '--model', 'a', '--output-format', 'stream-json'])).toThrow('输出格式')
})

test('joins real subprocess stream to one compatible result, dedupes final assistant usage, redacts secrets', async () => {
  const options = parseHeadlessArguments(['-p', 'OK', '--provider', 'kscc', '--model', 'alpha', '--output-format', 'json'], sandbox)
  const output = await executeNativeHeadless(options, { ...process.env, CLAUDE_CLI_PATH: mockCli, ANTHROPIC_API_KEY: 'fixture-private-value' }, ['fixture-private-value'], 'run-one')
  expect(output.exitCode).toBe(0)
  expect(output.result.result).toBe(`${sandbox} [已打码]`)
  expect(output.result.model).toBe('alpha')
  expect(output.result.run_id).toBe('run-one')
  expect(output.result.duration_ms).toBe(12)
  expect(output.assistantUsage.size).toBe(1)
  expect(output.assistantUsage.get('m1')?.usage.output_tokens).toBe(2)
})

test('concurrent different-provider and model child runs keep their process env and result identity', async () => {
  const outputs = await Promise.all(['kscc', 'tokenhub'].map((provider, i) => executeNativeHeadless(
    parseHeadlessArguments(['-p', 'OK', '--provider', provider, '--model', `model-${i}`], sandbox),
    { ...process.env, CLAUDE_CLI_PATH: mockCli, ANTHROPIC_API_KEY: `private-${i}` }, [], `parallel-${i}`,
  )))
  expect(outputs[0]!.result.model).toBe('model-0')
  expect(outputs[1]!.result.model).toBe('model-1')
  expect(outputs[0]!.result.result).toEndWith('private-0')
  expect(outputs[1]!.result.result).toEndWith('private-1')
  expect(outputs.map(o => o.result.run_id)).toEqual(['parallel-0', 'parallel-1'])
})

test('wall timeout terminates an actual stalled subprocess and returns bounded failure', async () => {
  const options = parseHeadlessArguments(['-p', 'wait', '--provider', 'kscc', '--model', 'a', '--timeout-ms', '100'], sandbox)
  const output = await executeNativeHeadless(options, { ...process.env, CLAUDE_CLI_PATH: mockCli }, [], 'timeout-run')
  expect(output.exitCode).toBe(124)
  expect(output.result.error_code).toBe('TIMEOUT')
  expect(output.result.is_error).toBe(true)
})

test('an error result cannot become a successful exit merely because the subprocess exited zero', async () => {
  const options = parseHeadlessArguments(['-p', 'errorflag', '--provider', 'kscc', '--model', 'a'], sandbox)
  const output = await executeNativeHeadless(options, { ...process.env, CLAUDE_CLI_PATH: mockCli }, [], 'error-result')
  expect(output.exitCode).toBe(1)
  expect(output.result.exit_code).toBe(1)
  expect(output.result.is_error).toBe(true)
})

test('redaction hides literal credential and generic authorization text', () => {
  expect(redactHeadlessText('secret-123 Bearer xyz.123-abc', ['secret-123'])).toBe('[已打码] Bearer [已打码]')
  const escapedSecret = 'private-"\\\nsecret'
  expect(JSON.parse(JSON.stringify(redactHeadlessValue({ result: escapedSecret }, [escapedSecret])))).toEqual({ result: '[已打码]' })
})

test('full entry joins explicit provider selection, subprocess, single JSON and local usage without touching GUI default', async () => {
  const config = join(sandbox, 'entry-config')
  await mkdir(join(config, 'cc-haha'), { recursive: true })
  const indexPath = join(config, 'cc-haha/providers.json')
  const baseline = JSON.stringify({ activeId: 'desktop-default', providers: [{ id: 'fixture-kscc', presetId: 'kscc', name: 'KSCC', apiKey: 'fixture-entry-secret', baseUrl: 'http://127.0.0.1:1', apiFormat: 'anthropic', models: { main: 'old', haiku: 'old', sonnet: 'old', opus: 'old' } }] })
  await writeFile(indexPath, baseline)
  const child = Bun.spawn([process.execPath, 'bin/cc-haha', '-p', 'OK', '--provider', 'kscc', '--model', 'entry-model', '--cwd', sandbox, '--output-format', 'json'], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CLI_PATH: mockCli, CC_HAHA_SKIP_DOTENV: '1' },
  })
  const [text, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(status).toBe(0)
  expect(stderr).toBe('')
  const result = JSON.parse(text)
  expect(result.provider).toBe('kscc')
  expect(result.model).toBe('entry-model')
  expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
  expect(text).not.toContain('fixture-entry-secret')
  expect(await readFile(indexPath, 'utf8')).toBe(baseline)
  expect(result.warnings).toBeUndefined()
}, 15000)
