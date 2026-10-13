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
  })

  afterEach(async () => {
    clearMarketplacesCache()
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
