import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

export const KSCC_PROTOCOL_ENV_KEY = 'CC_HAHA_KSCC_PROTOCOL'
export const KSCC_HEADERS_ENV_KEY = 'CC_HAHA_KSCC_HEADERS'
export const KSCC_CLIENT_VERSION = '1.1.28'

const KSCC_BETAS = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
  'structured-outputs-2025-12-15',
].join(',')

function encode(value: string): string {
  return encodeURIComponent(value)
}

/** Match the network-adapter choice made by the native KSCC binary. */
export function getKsccMacAddress(): string {
  const candidates: Array<{ name: string; mac: string; score: number }> = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || !address.mac || address.mac === '00:00:00:00:00:00') continue
      let score = address.family === 'IPv4' || address.family === 'IPv6' ? 1 : 0
      if (/^((en|eth)[0-9]+|ethernet)$/i.test(name)) score += 2
      if (/vboxnet/i.test(name)) score -= 3
      candidates.push({ name, mac: address.mac, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return candidates[0]?.mac ?? ''
}

function readGitValue(workDir: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_500,
      windowsHide: true,
    }).trim()
  } catch {
    return ''
  }
}

function getProjectName(gitRemote: string): string {
  return gitRemote.match(/\/ezone((?:\/[^/]+)+\/[^/]+?)(?:\.git)(?:$|\?)/)?.[1] ?? ''
}

export interface KsccProtocolContext {
  sessionId: string
  workDir: string
}

/** Headers observed from KSCC 1.1.28's real /v1/messages request. */
export function buildKsccProtocolHeaders(context: KsccProtocolContext): Record<string, string> {
  const gitRemote = readGitValue(context.workDir, ['remote', 'get-url', '--push', 'origin'])
  const branch = readGitValue(context.workDir, ['branch', '--show-current'])
  return {
    'User-Agent': `claude-cli/${KSCC_CLIENT_VERSION} (external, sdk-cli)`,
    'ksyun-code-version': KSCC_CLIENT_VERSION,
    'ksyun-code-type': 'kscc-sdk-cli',
    gitremote: encode(gitRemote),
    branch: encode(branch),
    projectname: encode(getProjectName(gitRemote)),
    projectpath: encode(context.workDir),
    macaddress: encode(getKsccMacAddress()),
    'ksyun-session-id': encode(`${context.sessionId}_init_${Date.now()}`),
    'X-KSC-COMPANY-CODE': 'seasun',
    'X-KSC-REQUEST-ID': randomUUID(),
    'owtffssent-version': '2023-06-01',
    'owtffssent-dangerous-direct-browser-access': 'true',
    'owtffssent-beta': KSCC_BETAS,
    'x-stainless-arch': process.arch === 'x64' ? 'x64' : process.arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': process.platform === 'win32' ? 'Windows' : process.platform,
    'x-stainless-package-version': '0.94.0',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-timeout': '900',
  }
}

export function buildKsccRuntimeEnv(workDir: string, sessionId = randomUUID()): Record<string, string> {
  return {
    [KSCC_PROTOCOL_ENV_KEY]: '1',
    [KSCC_HEADERS_ENV_KEY]: JSON.stringify(buildKsccProtocolHeaders({ sessionId, workDir })),
  }
}

function readClaudeUserId(): string {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { userID?: unknown }
    if (typeof config.userID === 'string' && config.userID) return config.userID
  } catch {
    // A connectivity probe only needs the same metadata shape; the CLI owns persistence.
  }
  return randomBytes(32).toString('hex')
}

export function buildKsccTestRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  workDir = process.cwd(),
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const sessionId = randomUUID()
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/v1/messages?beta=true`,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': sessionId,
      ...buildKsccProtocolHeaders({ sessionId, workDir }),
    },
    body: {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say ok and nothing else.' }] }],
      system: [{ type: 'text', text: 'You are a concise coding assistant.' }],
      tools: [],
      metadata: {
        user_id: JSON.stringify({
          device_id: readClaudeUserId(),
          account_uuid: '',
          session_id: sessionId,
        }),
      },
      output_config: {},
      max_tokens: 32_000,
      stream: true,
    },
  }
}
