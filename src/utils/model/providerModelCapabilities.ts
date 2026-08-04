export const PROVIDER_MODEL_CAPABILITIES_ENV_KEY = 'CC_HAHA_PROVIDER_MODEL_CAPABILITIES'

export function getProviderModelCapability(
  model: string,
  capability: string,
  raw = process.env[PROVIDER_MODEL_CAPABILITIES_ENV_KEY],
): boolean | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const modelCapabilities = Object.entries(parsed as Record<string, unknown>)
      .find(([modelId]) => modelId.toLowerCase() === model.toLowerCase())?.[1]
    if (typeof modelCapabilities !== 'string') return undefined
    return modelCapabilities
      .toLowerCase()
      .split(',')
      .map((value) => value.trim())
      .includes(capability.toLowerCase())
  } catch {
    return undefined
  }
}
