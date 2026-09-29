/** Resolve local document links without using the web application's URL as a base. */
export function resolveMarkdownDocumentLink(href: string, filePath: string) {
  const hash = href.indexOf('#')
  const fragment = hash < 0 ? '' : href.slice(hash + 1)
  const rawPath = (hash < 0 ? href : href.slice(0, hash)).split('?')[0]!
  if (!rawPath || href.startsWith('//')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) && !/^[a-z]:[/\\]/i.test(rawPath) && !/^file:\/\//i.test(rawPath)) return null
  let path: string
  try { path = decodeURIComponent(rawPath).replace(/\\/g, '/') } catch { return null }
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(rawPath)
      if (url.hostname && url.hostname !== 'localhost') return null
      path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1')
    } catch { return null }
  }
  if (!/\.(?:md|markdown|mdown)$/i.test(path)) return null
  const base = filePath.replace(/\\/g, '/')
  const joined = /^(?:[a-z]:\/|\/)/i.test(path) ? path : base.slice(0, base.lastIndexOf('/') + 1) + path
  const prefix = joined.match(/^(?:[a-z]:\/|\/)/i)?.[0] ?? ''
  const segments: string[] = []
  for (const segment of joined.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..' && segments.length && segments.at(-1) !== '..') segments.pop()
    else if (segment !== '..' || !prefix) segments.push(segment)
  }
  return { path: prefix + segments.join('/'), fragment }
}

/** Scope lookup to this renderer: multiple documents may contain the same IDs. */
export function scrollToMarkdownFragment(root: HTMLElement, fragment: string): boolean {
  let id: string
  try { id = decodeURIComponent(fragment.replace(/^#/, '')) } catch { id = fragment.replace(/^#/, '') }
  const target = id
    ? Array.from(root.querySelectorAll<HTMLElement>('[id], a[name]')).find((node) => node.id === id || node.getAttribute('name') === id)
    : root
  if (!target) return false
  target.scrollIntoView?.({ block: 'start' })
  return true
}
