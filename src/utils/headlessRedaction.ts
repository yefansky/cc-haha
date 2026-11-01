/** Shared output projection; known credentials remain in process memory only. */
export function redactHeadlessText(value: string, secrets: string[] = []): string {
  let text = value
  for (const secret of secrets) if (secret.length >= 4) text = text.replaceAll(secret, '[已打码]').replaceAll(encodeURIComponent(secret), '[已打码]')
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已打码]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[已打码]')
}

export function redactHeadlessValue(value: unknown, secrets: string[]): any {
  if (typeof value === 'string') return redactHeadlessText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactHeadlessValue(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactHeadlessText(key, secrets), redactHeadlessValue(item, secrets)]))
  return value
}
