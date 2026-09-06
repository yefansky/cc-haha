export type ProviderRequestAdapter = {
  id: string
  applyHeaders: (headers: Headers, env: NodeJS.ProcessEnv) => void
}

export function createProviderRequestHeaders(adapters: readonly ProviderRequestAdapter[]) {
  if (new Set(adapters.map(adapter => adapter.id)).size !== adapters.length) {
    throw new Error('Provider request adapters require unique ids')
  }
  return (headers: Headers, env: NodeJS.ProcessEnv): void => {
    for (const adapter of adapters) adapter.applyHeaders(headers, env)
  }
}
