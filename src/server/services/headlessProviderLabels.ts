/** Match the runtime's opaque model IDs, including suffixes such as [1m]. */
export function isHeadlessModelLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}
