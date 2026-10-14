import { clearInstalledPluginsCache } from './installedPluginsManager.js'
import { detectAndUninstallDelistedPlugins } from './pluginBlocklist.js'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  addMarketplaceSource,
  clearMarketplacesCache,
  getMarketplacesCacheDir,
  isStrictMarketplaceCachePath,
  refreshMarketplace,
} from './marketplaceManager.js'
import { runBackgroundPluginUpdate } from './backgroundUpdate.js'

describe('marketplace cache deletion safety', () => {
  let tempDir: string
  let originalConfigDir: string | undefined
  let originalPluginCacheDir: string | undefined

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-cache-safe-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, '.claude')
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    clearMarketplacesCache()
    clearInstalledPluginsCache()
  })

  afterEach(async () => {
    clearMarketplacesCache()
    clearInstalledPluginsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalPluginCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalPluginCacheDir
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('treats only strict children of the marketplace cache as removable', async () => {
    const cacheDir = getMarketplacesCacheDir()
    expect(isStrictMarketplaceCachePath(cacheDir)).toBe(false)
    expect(isStrictMarketplaceCachePath(path.join(cacheDir, 'official'))).toBe(true)
    expect(isStrictMarketplaceCachePath(path.join(tempDir, '.claude'))).toBe(false)
  })

  test('keeps a mirror cache when background Git fallback fails, but allows manual repair', async () => {
    const cacheDir = getMarketplacesCacheDir()
    const location = path.join(cacheDir, 'mirror-cache')
    const manifestPath = path.join(location, '.claude-plugin', 'marketplace.json')
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.writeFile(manifestPath, '{"name":"mirror-cache","owner":{"name":"Test"},"plugins":[]}')
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unavailable', { status: 503 }) })
    try {
      await fs.writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'known_marketplaces.json'), JSON.stringify({
        'mirror-cache': { source: { source: 'git', url: `${server.url}repo.git` }, installLocation: location, lastUpdated: new Date().toISOString() },
      }))
      await runBackgroundPluginUpdate(path.join(tempDir, 'maintenance'), async () => {
        await expect(refreshMarketplace('mirror-cache', undefined, { disableCredentialHelper: true })).rejects.toThrow('kept existing cache')
      })
      expect(await fs.readFile(manifestPath, 'utf8')).toContain('mirror-cache')
      await expect(refreshMarketplace('mirror-cache')).rejects.toThrow('Failed to clone marketplace')
      await expect(fs.stat(manifestPath)).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  test('skips delisting without installed plugins, never accesses the remote or helper', async () => {
    const original = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, CLAUDE_CODE_DIAGNOSTICS_FILE: process.env.CLAUDE_CODE_DIAGNOSTICS_FILE, DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER }
    const log = path.join(tempDir, 'cli-diagnostics.jsonl')
    const marker = path.join(tempDir, 'helper-called')
    const helper = path.join(tempDir, 'helper.js')
    const config = path.join(tempDir, 'gitconfig')
    await fs.writeFile(helper, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called')`)
    await fs.writeFile(config, `[credential]\n\thelper = ${JSON.stringify(`!node '${helper.replaceAll('\\', '/')}'`)}\n`)
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_DIAGNOSTICS_FILE: log, DISABLE_AUTOUPDATER: '1' })
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { requests++; return new Response('auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } }) } })
    try {
      const directory = path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins')
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
      await fs.writeFile(path.join(directory, 'known_marketplaces.json'), JSON.stringify({ 'private-market-name': { source: { source: 'git', url: `${server.url}repo.git` }, installLocation: path.join(getMarketplacesCacheDir(), 'missing'), lastUpdated: new Date().toISOString() } }))
      clearInstalledPluginsCache()
      expect(await detectAndUninstallDelistedPlugins()).toEqual([])
      await expect(fs.stat(marker)).rejects.toThrow()
      expect(requests).toBe(0)
      const raw = await fs.readFile(`${log}.${process.pid}.current.jsonl`, 'utf8')
      const events = raw.trim().split('\n').map(line => JSON.parse(line))
      expect(events.find(e => e.event === 'plugin_delisting_inventory').data.installed_count).toBe(0)
      expect(events.find(e => e.event === 'plugin_delisting_skipped').data.reason).toBe('no_installed_plugins')
      expect(events.some(e => e.event.startsWith('git_process_'))).toBe(false)
      expect(raw).not.toContain('private-market-name')
      expect(raw).not.toContain(server.url.toString())
    } finally {
      server.stop(true)
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })

  test.each(['missing', 'invalid', 'valid'] as const)('delisting with an installed plugin uses only the %s local cache', async cacheState => {
    const log = path.join(tempDir, 'delisting-diagnostics.jsonl')
    const originalLog = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = log
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { requests++; return new Response('auth required', { status: 401 }) } })
    try {
      const directory = path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins')
      const location = path.join(getMarketplacesCacheDir(), 'installed-market')
      const manifest = path.join(location, '.claude-plugin', 'marketplace.json')
      await fs.mkdir(directory, { recursive: true })
      const installed = { version: 2, plugins: { 'kept@installed-market': [{ scope: 'user', installPath: path.join(directory, 'cache', 'installed-market', 'kept', '1.0.0'), version: '1.0.0' }] } }
      await fs.writeFile(path.join(directory, 'installed_plugins.json'), JSON.stringify(installed))
      await fs.writeFile(path.join(directory, 'known_marketplaces.json'), JSON.stringify({ 'installed-market': { source: { source: 'git', url: `${server.url}repo.git` }, installLocation: location, lastUpdated: new Date().toISOString() }, 'unused-market': { source: { source: 'git', url: `${server.url}unused.git` }, installLocation: path.join(location, 'unused'), lastUpdated: new Date().toISOString() } }))
      if (cacheState !== 'missing') {
        await fs.mkdir(path.dirname(manifest), { recursive: true })
        await fs.writeFile(manifest, cacheState === 'invalid' ? '{invalid' : JSON.stringify({ name: 'installed-market', owner: { name: 'Test' }, plugins: [] }))
      }
      clearInstalledPluginsCache()
      expect(await detectAndUninstallDelistedPlugins()).toEqual([])
      expect(requests).toBe(0)
      expect(JSON.parse(await fs.readFile(path.join(directory, 'installed_plugins.json'), 'utf8'))).toEqual(installed)
      const events = (await fs.readFile(`${log}.${process.pid}.current.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(events.some(e => e.event.startsWith('git_process_'))).toBe(false)
      expect(events.some(e => e.event === 'plugin_delisting_market_skipped' && e.data.reason === 'no_matching_plugins')).toBe(true)
      if (cacheState === 'valid') expect(events.some(e => e.event === 'plugin_delisting_market_completed')).toBe(true)
      else expect(events.some(e => e.event === 'plugin_delisting_market_skipped' && e.data.reason === 'cache_unavailable')).toBe(true)
    } finally {
      server.stop(true)
      if (originalLog === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
      else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalLog
    }
  })

  test('does not delete the marketplace cache root from corrupted stored state', async () => {
    const cacheDir = getMarketplacesCacheDir()
    const sentinel = path.join(cacheDir, 'sentinel.txt')
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(sentinel, 'keep', 'utf-8')

    await fs.writeFile(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        'safe-marketplace': {
          source: { source: 'github', repo: 'owner/repo' },
          installLocation: cacheDir,
          lastUpdated: new Date().toISOString(),
        },
      }),
      'utf-8',
    )

    const marketplaceRoot = path.join(tempDir, 'local-marketplace')
    const marketplaceJson = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')
    await fs.mkdir(path.dirname(marketplaceJson), { recursive: true })
    await fs.writeFile(
      marketplaceJson,
      JSON.stringify({
        name: 'safe-marketplace',
        owner: { name: 'Test' },
        plugins: [],
      }),
      'utf-8',
    )

    await addMarketplaceSource({ source: 'file', path: marketplaceJson })

    await expect(fs.readFile(sentinel, 'utf-8')).resolves.toBe('keep')
  })

  test('refuses to refresh a remote marketplace whose installLocation is the cache root', async () => {
    const cacheDir = getMarketplacesCacheDir()
    const sentinel = path.join(cacheDir, 'sentinel.txt')
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(sentinel, 'keep', 'utf-8')

    await fs.writeFile(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        unsafe: {
          source: { source: 'github', repo: 'owner/repo' },
          installLocation: cacheDir,
          lastUpdated: new Date().toISOString(),
        },
      }),
      'utf-8',
    )

    await expect(refreshMarketplace('unsafe')).rejects.toThrow(
      'has a corrupted installLocation',
    )
    await expect(fs.readFile(sentinel, 'utf-8')).resolves.toBe('keep')
  })
})
