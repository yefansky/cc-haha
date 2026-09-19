import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionsApi } from '../api/sessions'
import { getBaseUrl, getApiContextRevision, subscribeApiContext } from '../api/client'
import { AssistantFileNavigator, type FileNavigationContext, type FileNavigationResult } from './assistantFileNavigation'
import { classifyPreviewLink } from './previewLinkRouter'
import { parseFilePathRef } from './filePathBoundary'
import { openPreviewLink } from './openPreviewLink'
import { buildOpenWithMenuItemsForHref } from './openWithMenuItems'
import type { OpenWithItem } from './openWithItems'

const navigator = new AssistantFileNavigator(
  (request, context, signal) => sessionsApi.resolveFileReference(context.sessionId, request, { timeout: request.timeoutMs ?? 500, signal }),
  async (path, context, signal, timeout) => (await sessionsApi.getWorkspaceFile(context.sessionId, path, 'auto', { signal, timeout })).state === 'ok',
)
export const invalidateAssistantFileNavigation = () => navigator.invalidate()
const navigationIntentBySession = new Map<string, number>()
let nextNavigationIntent = 0
const messages: Record<string, string> = {
  missing: '未找到，可能尚未生成或路径不完整',
  ambiguous: '找到多个可能文件，请选择完整路径',
  incomplete: '定位尚未完成，请选择候选或使用完整路径',
  denied: '当前工作区没有此文件的访问权限',
  invalid: '文件路径无法解析，请使用完整路径',
  error: '文件定位失败，请重试',
}

export function useAssistantFileActions(context: Omit<FileNavigationContext, 'server' | 'generation'> & { rootsRevision: string }, t: (key: string, vars?: Record<string, string>) => string) {
  const [apiRevision, setApiRevision] = useState(getApiContextRevision)
  const [feedback, setFeedback] = useState<{ text: string; candidates: string[]; anchor?: DOMRect } | null>(null)
  const [menu, setMenu] = useState<{ items: OpenWithItem[]; anchor: DOMRect } | null>(null)
  const pending = useRef<AbortController | null>(null)
  const stamp = JSON.stringify([context.sessionId, context.workDir, context.rootsRevision, apiRevision, context.evidence?.revision, context.changedFiles, context.referencedFiles])
  const currentStamp = useRef(stamp)
  currentStamp.current = stamp
  useEffect(() => subscribeApiContext(() => { pending.current?.abort(); navigator.invalidate(); setApiRevision(getApiContextRevision()) }), [])
  useEffect(() => {
    pending.current?.abort()
    setFeedback(null); setMenu(null)
    return () => { pending.current?.abort() }
  }, [stamp])
  const scopeStamp = JSON.stringify([context.workDir, context.rootsRevision, context.sessionId])
  const previousScope = useRef(scopeStamp)
  useEffect(() => {
    if (previousScope.current !== scopeStamp) { previousScope.current = scopeStamp; navigator.invalidate() }
  }, [scopeStamp])

  const activate = useCallback((href: string, anchor?: DOMRect) => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const sourceStamp = stamp
    const intent = ++nextNavigationIntent
    navigationIntentBySession.set(context.sessionId, intent)
    while (navigationIntentBySession.size > 128) navigationIntentBySession.delete(navigationIntentBySession.keys().next().value!)
    const live = () => !controller.signal.aborted && currentStamp.current === sourceStamp && navigationIntentBySession.get(context.sessionId) === intent
    setFeedback(null); setMenu(null)
    let classified
    try {
      if (!/%(?:2f|5c)/i.test(href)) { try { href = decodeURI(href) } catch { /* Preserve malformed literal references. */ } }
      classified = classifyPreviewLink(href)
      if (!classified.path && parseFilePathRef(href)?.line) classified = classifyPreviewLink(`./${href}`)
    } catch { return }
    if (!classified.path) {
      if (!anchor) openPreviewLink(href, context.sessionId)
      else void buildOpenWithMenuItemsForHref(href, { sessionId: context.sessionId, workDir: context.workDir, t }).then((items) => { if (live() && items.length) setMenu({ items, anchor }) })
      return
    }
    const position = classified.line ? `:${classified.line}${classified.column ? `:${classified.column}` : ''}` : ''
    void (async () => {
      let result: FileNavigationResult
      try {
        result = await navigator.resolve(`${classified.path}${position}`, { ...context, server: getBaseUrl(), generation: `${apiRevision}:${context.rootsRevision}` }, controller.signal)
      } catch (error) {
        if (live()) setFeedback({ text: error instanceof Error ? error.message : '文件定位失败', candidates: [] })
        return
      }
      if (!live()) return
      if (result.compatibility) setFeedback({ text: result.error ?? '自动定位需要服务升级', candidates: [] })
      if (!result.href) {
        setFeedback({ text: result.error === 'unsupported' ? '自动定位需要服务升级' : result.error ?? messages[result.state] ?? messages.error!, candidates: (result.candidates ?? []).slice(0, 5).map((candidate) => candidate.path), anchor })
        return
      }
      if (!anchor) openPreviewLink(result.href, context.sessionId)
      else {
        const items = await buildOpenWithMenuItemsForHref(result.href, { sessionId: context.sessionId, workDir: context.workDir, t })
        if (live() && items.length) setMenu({ items, anchor })
      }
    })()
  }, [context, stamp, apiRevision, t])
  return { activate, feedback, menu, closeMenu: () => setMenu(null) }
}
