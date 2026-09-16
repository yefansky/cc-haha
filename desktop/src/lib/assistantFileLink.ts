import { resolveAssistantOutputFileHref } from './assistantOutputTargets'
import { classifyPreviewLink } from './previewLinkRouter'
import { openWithContextForHref } from './openWithContextForHref'
import { isAbsoluteLocalPath } from './handlePreviewLink'
import { parseFilePathRef } from './filePathBoundary'

type Options = Parameters<typeof resolveAssistantOutputFileHref>[1]

function classify(href: string) {
  try { return classifyPreviewLink(href) }
  catch { return { kind: 'ignored' as const } }
}

/** Message-owned evidence resolution, shared by hover, click and context menu.
 * No filesystem access: a workspace-relative fallback is a target, not proof
 * that a file exists. Never pick one of several matching tool paths.
 */
export function resolveAssistantFileLink(href: string, options: Options): {
  href: string
  title?: string
} {
  // Explicit Markdown destinations may be URI-encoded. Preserve encoded
  // separators rather than letting them change the target's path semantics.
  let resolvedHref = resolveAssistantOutputFileHref(href, options)
  const reconciled = resolvedHref !== href
  if (!reconciled && !/%(?:2f|5c)/i.test(href)) {
    try {
      const decoded = decodeURI(href)
      if (parseFilePathRef(decoded)) resolvedHref = decoded
    } catch { /* Keep malformed escapes literal, as the existing opener does. */ }
  }
  let classified = classify(resolvedHref)
  // URL treats `send.py:12` as a scheme; the file boundary already knows
  // this is a line reference. Make its relative-path semantics explicit.
  if (!classified.path && parseFilePathRef(resolvedHref)?.line && !isAbsoluteLocalPath(resolvedHref)) {
    resolvedHref = `./${resolvedHref}`
    classified = classify(resolvedHref)
  }
  if (!classified.path) return { href: resolvedHref }

  const path = classified.path.replace(/\\/g, '/')
  // The output-card resolver covers document/media extensions. Complete the
  // same evidence flow for source files, without reinterpreting absolute,
  // home-relative, traversal or encoded-separator references.
  if (!reconciled && !isAbsoluteLocalPath(path)
    && !path.startsWith('~') && !path.split('/').includes('..')
    && !/%(?:2f|5c)/i.test(path)) {
    const windows = /^[a-z]:[\\/]/i.test(options.workDir ?? '')
    const key = (value: string) => windows ? value.toLowerCase() : value
    const files = [...new Map([...(options.changedFiles ?? []), ...(options.referencedFiles ?? [])]
      .filter(isAbsoluteLocalPath)
      .map((file) => { const p = file.replace(/\\/g, '/'); return [key(p), p] as const })).values()]
    const candidate = key(path.replace(/^\.\//, ''))
    const suffix = files.filter((file) => key(file).endsWith(`/${candidate}`))
    const matches = suffix.length ? suffix : files.filter((file) => key(file.split('/').pop()!) === candidate.split('/').pop())
    if (matches.length > 1) return { href: resolvedHref, title: `${path}\n文件引用未唯一定位` }
    if (matches.length === 1) {
      const position = classified.line ? `:${classified.line}${classified.column ? `:${classified.column}` : ''}` : ''
      resolvedHref = `${matches[0]}${position}`
      classified = classify(resolvedHref)
    }
  }

  const context = openWithContextForHref(resolvedHref, {
    sessionId: '', serverBaseUrl: '', workDir: options.workDir ?? undefined,
  })
  if (context?.kind !== 'file') return { href: resolvedHref }
  const absolute = context.absolutePath.replace(/\\/g, '/')
  const position = classified.line ? `:${classified.line}${classified.column ? `:${classified.column}` : ''}` : ''
  return {
    href: resolvedHref,
    title: isAbsoluteLocalPath(absolute)
      ? `${absolute}${position}`
      : `${absolute}${position}\n完整路径尚未解析`,
  }
}
