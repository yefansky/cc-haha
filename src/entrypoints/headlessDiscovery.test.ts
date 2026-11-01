import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { aggregateHeadlessProviders, parseHeadlessArguments } from './ccHaha.js'
import { getHeadlessCapabilities, renderHeadlessHelp } from './headlessCommandCatalog.js'
import Ajv from 'ajv'

const ajv = new Ajv({ strict: false, allErrors: true })
function assertContract(command: string, data: unknown) {
  const schema = getHeadlessCapabilities().commands.find(item => item.name === command)!.output_schema
  const validate = ajv.compile(schema)
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true)
}

const entry = resolve('bin/cc-haha')
async function execute(args: string[], cwd: string, config = join(cwd, 'absent-config')) {
  const child = Bun.spawn([process.execPath, entry, ...args], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config, CALLER_DIR: undefined, CLAUDE_CLI_PATH: undefined, CC_HAHA_SKIP_DOTENV: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

test('all help spellings and capabilities work offline outside source with missing/corrupt config and unrelated invalid cwd', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'headless-discovery-'))
  try {
    for (const args of [[], ['--help'], ['help'], ['help', 'models'], ['models', '--help'], ['help', '--manual'], ['help', '--cwd', 'does-not-exist']]) {
      const output = await execute(args, sandbox)
      expect(output.code).toBe(0)
      expect(output.stderr).toBe('')
      expect(output.stdout).toContain('capabilities --json')
      expect(output.stdout).toContain('HELP.md')
    }
    expect(await readdir(sandbox)).toEqual([])
    await mkdir(join(sandbox, 'broken-config', 'cc-haha'), { recursive: true })
    const index = join(sandbox, 'broken-config', 'cc-haha', 'providers.json')
    await writeFile(index, 'intentionally invalid JSON')
    const output = await execute(['capabilities', '--json'], sandbox, join(sandbox, 'broken-config'))
    expect(output.code).toBe(0)
    const contract = JSON.parse(output.stdout)
    assertContract('capabilities', contract)
    expect(contract.schema_version).toBe(2)
    expect(contract.commands.map((c: any) => c.name)).toEqual(['help', 'capabilities', 'providers', 'models', 'pricing', 'usage', 'login', 'run'])
    expect(contract.pricing_policy).toContain('null')
    expect(await readFile(index, 'utf8')).toBe('intentionally invalid JSON')
    const invalidOption = await execute(['capabilities', '--json', '--cwd', 'does-not-exist'], sandbox, join(sandbox, 'broken-config'))
    expect(invalidOption.code).toBe(1)
    expect(JSON.parse(invalidOption.stdout).error_code).toBe('INVALID_ARGUMENT')
    expect(await readFile(index, 'utf8')).toBe('intentionally invalid JSON')
    expect(await readdir(join(sandbox, 'broken-config'))).toEqual(['cc-haha'])
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}, 15000)

test('metadata drives examples, selection constraints, permission defaults and error recovery', () => {
  const contract = getHeadlessCapabilities()
  const quickStart = renderHeadlessHelp()
  for (const command of ['models', 'pricing', 'usage']) expect(quickStart).toContain(`cc-haha ${command} --all --no-network --json`)
  expect(quickStart).toContain('status=ok 只表示查询成功')
  expect(contract.commands.find(command => command.name === 'pricing')!.usage).toContain('[--no-network]')
  expect(contract.defaults.permission_mode).toBe('dontAsk')
  const models = contract.commands.find(c => c.name === 'models')!
  expect(models.input_constraints).toEqual({ exactly_one_of: ['--provider', '--all'], provider_all_is_aggregate_alias: false })
  expect(models.parameters.find(p => p.name === '--provider')!.required).toBe(false)
  for (const command of contract.commands) {
    expect(command.examples.length).toBeGreaterThan(0)
    expect(renderHeadlessHelp(command.name)).toContain(command.usage)
    for (const example of command.examples) expect(renderHeadlessHelp(undefined, true)).toContain(example)
  }
  expect(contract.errors.find(error => error.code === 'AMBIGUOUS_PROVIDER')!.action).toContain('ID')
  expect(parseHeadlessArguments(['models', '--all']).all).toBe(true)
  expect(parseHeadlessArguments(['pricing', '--provider', 'all', '--json']).provider).toBe('all')
  expect(parseHeadlessArguments(['pricing', '--provider', 'all', '--json']).all).toBeUndefined()
  expect(() => parseHeadlessArguments(['usage', '--all', '--provider', 'some-id'])).toThrow('不能同时')
  for (const args of [['providers', '--model', 'x'], ['models', '--provider', 'kscc', '--model', 'x'], ['usage', '--provider', 'kscc', '--cwd', '/unused']]) expect(() => parseHeadlessArguments(args)).toThrow('不适用于')
  expect(parseHeadlessArguments(['-p', 'OK', '--provider', 'all', '--model', 'm']).provider).toBe('all')
})

test('all-provider aggregation preserves successes and emits only stable safe per-item failures', async () => {
  const result = await aggregateHeadlessProviders('models', ['custom-one', 'failed-two'], async id => {
    if (id === 'custom-one') return { models: [{ id: 'model-a' }] }
    throw Object.assign(new Error('private-token-should-never-appear'), { code: 'private-error-token' })
  })
  expect(result.status).toBe('partial')
  expect(result.results[0]!.data).toEqual({ models: [{ id: 'model-a' }] })
  expect(result.results[1]!.error?.code).toBe('CLI_ERROR')
  expect(JSON.stringify(result)).not.toContain('private-')
})

test('real query entry enumerates saved IDs and queries all local model/pricing data without credentials or GUI mutations', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'headless-all-'))
  const config = join(sandbox, 'config')
  await mkdir(join(config, 'cc-haha'), { recursive: true })
  const indexPath = join(config, 'cc-haha/providers.json')
  const providers = ['one', 'two'].map(id => ({ id, presetId: 'custom', name: id, apiKey: 'fake-query-key', baseUrl: 'http://127.0.0.1:1', apiFormat: 'anthropic', models: { main: `model-${id}`, haiku: `model-${id}`, sonnet: `model-${id}`, opus: `model-${id}` } }))
  const before = JSON.stringify({ activeId: 'two', providers })
  await writeFile(indexPath, before)
  try {
    const listing = await execute(['providers', '--json'], sandbox, config)
    expect(listing.code).toBe(0)
    expect(JSON.parse(listing.stdout).providers.map((p: any) => p.id)).toEqual(['one', 'two'])
    assertContract('providers', JSON.parse(listing.stdout))
    expect(listing.stdout).not.toContain('fake-query-key')
    for (const command of ['models', 'pricing', 'usage']) {
      const output = await execute([command, '--all', '--no-network', '--json'], sandbox, config)
      expect(output.code).toBe(0)
      const data = JSON.parse(output.stdout)
      assertContract(command, data)
      expect(data.schema_version).toBe(2)
      expect(data.status).toBe('ok')
      expect(data.results.map((r: any) => r.provider_id)).toEqual(['one', 'two'])
      expect(output.stdout).not.toContain('fake-query-key')
      if (command === 'pricing') for (const result of data.results) expect(result.data.rates.input).toBeNull()
    }
    expect(await readFile(indexPath, 'utf8')).toBe(before)
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}, 15000)

test('actual preflight errors, empty discovery, partial aggregation and unknown price all match advertised schemas', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'headless-schema-'))
  const config = join(sandbox, 'config')
  await mkdir(join(config, 'cc-haha'), { recursive: true })
  try {
    const empty = await execute(['providers', '--json'], sandbox, config)
    expect(empty.code).toBe(0)
    assertContract('providers', JSON.parse(empty.stdout))
    for (const args of [['-p', 'OK', '--provider', 'not-saved', '--model', 'm', '--json'], ['models', '--provider', 'not-saved', '--json']]) {
      const output = await execute(args, sandbox, config)
      expect(output.code).toBe(1)
      const result = JSON.parse(output.stdout)
      expect(result.provider_id).toBeNull()
      assertContract(args[0] === 'models' ? 'models' : 'run', result)
    }
    const provider = (id: string, presetId: string, key: string) => ({ id, presetId, name: id, apiKey: key, baseUrl: 'http://127.0.0.1:1', apiFormat: 'anthropic', models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' } })
    await writeFile(join(config, 'cc-haha/providers.json'), JSON.stringify({ activeId: null, providers: [provider('all', 'custom', 'fake-schema-key'), provider('requires-login', 'kscc', ''), provider('kscc', 'custom', 'fake-custom-key')] }))
    const partial = await execute(['models', '--all', '--json'], sandbox, config)
    expect(partial.code).toBe(1)
    expect(JSON.parse(partial.stdout).status).toBe('partial')
    assertContract('models', JSON.parse(partial.stdout))
    const exactAll = await execute(['models', '--provider', 'all', '--no-network', '--json'], sandbox, config)
    expect(JSON.parse(exactAll.stdout).provider_id).toBe('all')
    assertContract('models', JSON.parse(exactAll.stdout))
    const price = await execute(['pricing', '--provider', 'all', '--json'], sandbox, config)
    expect(JSON.parse(price.stdout).status).toBe('unknown')
    assertContract('pricing', JSON.parse(price.stdout))
    const exactKscc = await execute(['usage', '--provider', 'kscc', '--no-network', '--json'], sandbox, config)
    const exactUsage = JSON.parse(exactKscc.stdout)
    expect(exactUsage.provider_id).toBe('kscc')
    expect(exactUsage.provider_preset).toBe('custom')
    expect(exactUsage.legacy_usage).toBeNull()
    assertContract('usage', exactUsage)
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}, 35000)
