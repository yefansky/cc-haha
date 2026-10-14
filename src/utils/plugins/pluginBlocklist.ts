/**
 * Plugin delisting detection.
 *
 * Compares installed plugins against marketplace manifests to find plugins
 * that have been removed, and auto-uninstalls them.
 *
 * The security.json fetch was removed (see #25447) — ~29.5M/week GitHub hits
 * for UI reason/text only. If re-introduced, serve from downloads.claude.ai.
 */

import { withPluginDiagnosticScope, pluginDiagnosticEvent, marketplaceDiagnosticId } from './diagnosticTrace.js'
import { uninstallPluginOp } from '../../services/plugins/pluginOperations.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { loadInstalledPluginsV2 } from './installedPluginsManager.js'
import {
  getMarketplaceCacheOnly,
  loadKnownMarketplacesConfigSafe,
} from './marketplaceManager.js'
import {
  addFlaggedPlugin,
  getFlaggedPlugins,
  loadFlaggedPlugins,
} from './pluginFlagging.js'
import type { InstalledPluginsFileV2, PluginMarketplace } from './schemas.js'

/**
 * Detect plugins installed from a marketplace that are no longer listed there.
 *
 * @param installedPlugins All installed plugins
 * @param marketplace The marketplace to check against
 * @param marketplaceName The marketplace name suffix (e.g. "claude-plugins-official")
 * @returns List of delisted plugin IDs in "name@marketplace" format
 */
export function detectDelistedPlugins(
  installedPlugins: InstalledPluginsFileV2,
  marketplace: PluginMarketplace,
  marketplaceName: string,
): string[] {
  const marketplacePluginNames = new Set(marketplace.plugins.map(p => p.name))
  const suffix = `@${marketplaceName}`

  const delisted: string[] = []
  for (const pluginId of Object.keys(installedPlugins.plugins)) {
    if (!pluginId.endsWith(suffix)) continue

    const pluginName = pluginId.slice(0, -suffix.length)
    if (!marketplacePluginNames.has(pluginName)) {
      delisted.push(pluginId)
    }
  }

  return delisted
}

/**
 * Detect delisted plugins across all marketplaces, auto-uninstall them,
 * and record them as flagged.
 *
 * This is the core delisting enforcement logic, shared between interactive
 * mode (useManagePlugins) and headless mode (main.tsx print path).
 *
 * @returns List of newly flagged plugin IDs
 */
export async function detectAndUninstallDelistedPlugins(): Promise<string[]> {
  return withPluginDiagnosticScope('delisting', async () => {
    pluginDiagnosticEvent('info', 'plugin_delisting_started')
    const result = await detectAndUninstallDelistedPluginsImpl()
    pluginDiagnosticEvent('info', 'plugin_delisting_completed', { count: result.length })
    return result
  })
}
async function detectAndUninstallDelistedPluginsImpl(): Promise<string[]> {
  await loadFlaggedPlugins()

  const installedPlugins = loadInstalledPluginsV2()
  const alreadyFlagged = getFlaggedPlugins()
  // Read-only iteration — Safe variant so a corrupted config doesn't throw
  // out of this function (it's called in the same try-block as loadAllPlugins
  // in useManagePlugins, so a throw here would void loadAllPlugins' resilience).
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()
  const newlyFlagged: string[] = []

  pluginDiagnosticEvent('info', 'plugin_delisting_inventory', { count: Object.keys(knownMarketplaces).length, installed_count: Object.keys(installedPlugins.plugins).length })
  const installedIds = Object.keys(installedPlugins.plugins)
  if (installedIds.length === 0) {
    pluginDiagnosticEvent('info', 'plugin_delisting_skipped', { reason: 'no_installed_plugins' })
    return newlyFlagged
  }
  for (const marketplaceName of Object.keys(knownMarketplaces)) {
    if (!installedIds.some(id => id.endsWith(`@${marketplaceName}`))) {
      pluginDiagnosticEvent('info', 'plugin_delisting_market_skipped', { market_id: marketplaceDiagnosticId(marketplaceName), reason: 'no_matching_plugins' })
      continue
    }
    try {
      const market_id = marketplaceDiagnosticId(marketplaceName)
      pluginDiagnosticEvent('info', 'plugin_delisting_market_started', { market_id })
      // Delisting is startup bookkeeping, not an instruction to repair or
      // update a remote market. Missing/invalid cache must never trigger Git.
      const marketplace = await getMarketplaceCacheOnly(marketplaceName)
      if (!marketplace) {
        pluginDiagnosticEvent('warn', 'plugin_delisting_market_skipped', { market_id, reason: 'cache_unavailable' })
        continue
      }
      pluginDiagnosticEvent('info', 'plugin_delisting_market_completed', { market_id, force_remove: marketplace.forceRemoveDeletedPlugins === true })

      if (!marketplace.forceRemoveDeletedPlugins) continue

      const delisted = detectDelistedPlugins(
        installedPlugins,
        marketplace,
        marketplaceName,
      )

      for (const pluginId of delisted) {
        if (pluginId in alreadyFlagged) continue

        // Skip managed-only plugins — enterprise admin should handle those
        const installations = installedPlugins.plugins[pluginId] ?? []
        const hasUserInstall = installations.some(
          i =>
            i.scope === 'user' || i.scope === 'project' || i.scope === 'local',
        )
        if (!hasUserInstall) continue

        // Auto-uninstall the delisted plugin from all user-controllable scopes
        for (const installation of installations) {
          const { scope } = installation
          if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
            continue
          }
          try {
            await uninstallPluginOp(pluginId, scope)
          } catch (error) {
            logForDebugging(
              `Failed to auto-uninstall delisted plugin ${pluginId} from ${scope}: ${errorMessage(error)}`,
              { level: 'error' },
            )
          }
        }

        await addFlaggedPlugin(pluginId)
        newlyFlagged.push(pluginId)
      }
    } catch (error) {
      pluginDiagnosticEvent('warn', 'plugin_delisting_market_failed', { market_id: marketplaceDiagnosticId(marketplaceName) })
      // Marketplace may not be available yet — log and continue
      logForDebugging(
        `Failed to check for delisted plugins in "${marketplaceName}": ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }

  return newlyFlagged
}
