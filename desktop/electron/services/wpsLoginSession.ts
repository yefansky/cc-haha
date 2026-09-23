import { createDecipheriv, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Session } from 'electron'

const COOKIE_PATHS = [
  'cef/cache/wpsoffice/Network/Cookies', 'kcloudpage/cookies-v3/Network/Cookies',
  'promebrowser/cookie/Network/Cookies', 'promeapps/cookie/Network/Cookies',
]
const WINDOWS_EPOCH_SECONDS = 11644473600
type WpsCookie = { host_key: string; name: string; path: string; value: string; encrypted_value: Uint8Array;
  expires_utc: number; last_access_utc: number; is_secure: number; is_httponly: number; samesite: number; version: number }

export function readWpsCookieRows(db: DatabaseSync): WpsCookie[] {
  const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string })?.value || 0)
  const query = db.prepare("SELECT host_key,name,path,value,encrypted_value,expires_utc,last_access_utc,is_secure,is_httponly,samesite FROM cookies WHERE host_key = '.wps.cn' AND name = 'wps_sid' AND path = '/'")
  // Chromium timestamps are microseconds since 1601, beyond JS safe integers.
  query.setReadBigInts(true)
  return query.all().map(row => ({ ...row, version,
    expires_utc: Number(row.expires_utc), last_access_utc: Number(row.last_access_utc),
    is_secure: Number(row.is_secure), is_httponly: Number(row.is_httponly), samesite: Number(row.samesite),
  }) as WpsCookie)
}

/** DPAPI runs as the current Windows user. Secrets travel only through pipes. */
async function unprotect(value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; try { $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p)) } catch { exit 1 }'
    const child = spawn(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), 10_000)
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 32768) child.kill() })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', () => { clearTimeout(timer); reject(new Error('WPS session unavailable')) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0 || !output || output.length > 32768) reject(new Error('WPS session unavailable'))
      else resolve(Buffer.from(output.trim(), 'base64'))
    })
    child.stdin.end(value.toString('base64'))
  })
}

export function decryptWpsCookie(row: WpsCookie, key: Buffer): string {
  if (row.value) return row.value
  const encrypted = Buffer.from(row.encrypted_value)
  if (!['v10', 'v11'].includes(encrypted.subarray(0, 3).toString()) || encrypted.length < 31) throw new Error('Unsupported WPS cookie')
  const cipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(3, 15))
  cipher.setAuthTag(encrypted.subarray(-16))
  let plain = Buffer.concat([cipher.update(encrypted.subarray(15, -16)), cipher.final()])
  if (row.version >= 24) {
    if (!plain.subarray(0, 32).equals(createHash('sha256').update(row.host_key).digest())) throw new Error('Invalid WPS cookie host')
    plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

/** Import only WPS's session cookie, never a browser profile, passwords or unrelated cookies. */
export async function readWpsDesktopSession(): Promise<Electron.CookiesSetDetails | null> {
  if (process.platform !== 'win32' || !process.env.APPDATA) return null
  let key: Buffer | undefined
  try {
    const root = join(process.env.APPDATA, 'kingsoft/wps/addons/data/win-i386')
    const { DatabaseSync } = await import('node:sqlite')
    const rows: WpsCookie[] = []
    for (const relative of COOKIE_PATHS) {
      let db: InstanceType<typeof DatabaseSync> | undefined
      try {
        db = new DatabaseSync(join(root, relative), { readOnly: true })
        rows.push(...readWpsCookieRows(db))
      } catch { /* A missing or locked WPS profile must not prevent interactive login. */ }
      finally { db?.close() }
    }
    const now = Date.now() / 1000
    const row = rows.filter(row => row.expires_utc === 0 || row.expires_utc / 1e6 - WINDOWS_EPOCH_SECONDS > now)
      .sort((a, b) => b.last_access_utc - a.last_access_utc)[0]
    if (!row) return null
    const prefs = JSON.parse(await readFile(join(root, 'LocalPrefs.json'), 'utf8'))
    const wrapped = Buffer.from(prefs.os_crypt.encrypted_key, 'base64')
    if (wrapped.subarray(0, 5).toString() !== 'DPAPI') return null
    key = await unprotect(wrapped.subarray(5))
    const value = decryptWpsCookie(row, key)
    if (!value || value.length > 16384 || /[\u0000-\u0020\u007f;]/.test(value)) return null
    return { url: 'https://account.wps.cn/', domain: '.wps.cn', name: 'wps_sid', value, path: '/',
      secure: true, httpOnly: !!row.is_httponly,
      ...(row.expires_utc ? { expirationDate: row.expires_utc / 1e6 - WINDOWS_EPOCH_SECONDS } : {}),
      sameSite: row.samesite === 2 ? 'strict' : row.samesite === 1 ? 'lax' : row.samesite === 0 ? 'no_restriction' : 'unspecified' }
  } catch { return null }
  finally { key?.fill(0) }
}

export async function prepareWpsLoginSession(session: Session, readCookie = readWpsDesktopSession): Promise<void> {
  // Keep an account explicitly selected in this app. Electron excludes expired cookies.
  if ((await session.cookies.get({ url: 'https://account.wps.cn/', name: 'wps_sid' })).length) return
  const cookie = await readCookie()
  if (cookie) await session.cookies.set(cookie)
}
