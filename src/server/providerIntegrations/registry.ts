import type { ProviderIntegration } from './types.js'
import type { SavedProvider } from '../types/provider.js'

/** Compile-time businesses, with injectable registries for isolated contract tests. */
export class ProviderIntegrationRegistry {
  private readonly integrations: readonly ProviderIntegration[]

  constructor(integrations: readonly ProviderIntegration[]) {
    const ids = new Set<string>()
    const presets = new Set<string>()
    const aliases = new Set<string>()
    for (const integration of integrations) {
      if (!integration.id || ids.has(integration.id) || !integration.presetId || presets.has(integration.presetId)) {
        throw new Error('Provider integrations require unique non-empty ids and preset ids')
      }
      ids.add(integration.id)
      presets.add(integration.presetId)
      for (const alias of integration.legacyAuthResources ?? []) {
        if (!alias || aliases.has(alias) || alias === 'provider-integrations') {
          throw new Error('Provider integrations require unique legacy auth resources')
        }
        aliases.add(alias)
      }
    }
    this.integrations = [...integrations]
  }

  get(id: string): ProviderIntegration | undefined {
    return this.integrations.find(integration => integration.id === id)
  }

  forPreset(presetId: string): ProviderIntegration | undefined {
    return this.integrations.find(integration => integration.presetId === presetId)
  }

  forLegacyAuthResource(resource: string): ProviderIntegration | undefined {
    return this.integrations.find(integration => integration.legacyAuthResources?.includes(resource))
  }

  managedEnvKeys(): string[] {
    return [...new Set(this.integrations.flatMap(integration => [...(integration.managedEnvKeys ?? [])]))]
  }

  buildRuntimeEnv(provider: SavedProvider, workDir: string): Record<string, string> {
    return this.forPreset(provider.presetId)?.buildRuntimeEnv?.({ provider, workDir }) ?? {}
  }
}
