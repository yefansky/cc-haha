import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { SavedProvider } from '../../types/provider.js'
import { fetchSeasunModels, seasunReconnectRequired, validToken, type SeasunManagerCredentials } from './protocol.js'

type CredentialsFile = SeasunManagerCredentials & { version: 1; providerId: string; apiKeyHash: string }
const operations = new Map<string, Promise<unknown>>()
const fingerprint = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex')
function credentialsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha', 'provider-integrations', 'seasun-credentials.json')
}
function withCredentials<T>(operation: (file: string) => Promise<T>): Promise<T> {
  const file = credentialsPath()
  const pending = (operations.get(file) ?? Promise.resolve()).catch(() => {}).then(() => operation(file))
  operations.set(file, pending)
  void pending.finally(() => { if (operations.get(file) === pending) operations.delete(file) }).catch(() => {})
  return pending
}
async function writeCredentials(file: string, value: CredentialsFile) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

/** Backend-only file, separate from the public login status and saved provider. */
export function saveSeasunCredentials(providerId: string, apiKey: string, credentials: SeasunManagerCredentials) {
  return withCredentials(file => writeCredentials(file, { ...credentials, version: 1, providerId, apiKeyHash: fingerprint(apiKey) }))
}

export function clearSeasunCredentials() {
  return withCredentials(file => fs.rm(file, { force: true }))
}

export function refreshSeasunModelCatalog(provider: SavedProvider) {
  return withCredentials(async file => {
    const saved: CredentialsFile | undefined = await fs.readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
    // Old installations have no manager credentials. Keep their provider intact;
    // one explicit reconnect upgrades them without guessing an identity/token.
    if (!saved || saved.version !== 1 || saved.providerId !== provider.id || saved.apiKeyHash !== fingerprint(provider.apiKey) ||
      !validToken(saved.accessToken) || (saved.refreshToken !== undefined && !validToken(saved.refreshToken))) throw seasunReconnectRequired()
    const result = await fetchSeasunModels(saved, credentials => writeCredentials(file, { ...saved, ...credentials }))
    if (result.apiKey !== provider.apiKey) throw seasunReconnectRequired()
    return result.modelCatalog
  })
}
