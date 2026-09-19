import { useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ExternalLink, Globe } from 'lucide-react'
import type { AssistantOutputTarget } from '../../lib/assistantOutputTargets'
import { useTranslation, type TranslationKey } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { describeFileType, type OpenWithItem } from '../../lib/openWithItems'
import { buildOpenWithMenuItemsForHref } from '../../lib/openWithMenuItems'
import { resolveAssistantFileLink } from '../../lib/assistantFileLink'
import { openPreviewLink } from '../../lib/openPreviewLink'

type Props = {
  target: AssistantOutputTarget
  sessionId: string
  onAction?: (href: string, anchor?: DOMRect) => void
  workDir?: string
  resolveFileLink?: (href: string) => ReturnType<typeof resolveAssistantFileLink>
}

export function AssistantOutputTargetCard({ target, sessionId, workDir, resolveFileLink, onAction }: Props) {
  const t = useTranslation()
  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect; triggerEl: HTMLElement } | null>(null)

  const [fileLinkError, setFileLinkError] = useState<string | null>(null)
  const resolveTarget = useCallback(() => resolveFileLink
    ? resolveFileLink(target.href)
    : resolveAssistantFileLink(target.href, { workDir }), [resolveFileLink, target.href, workDir])

  const isLocalhost = target.kind === 'localhost-url'
  const typeInfo = describeFileType(target.normalizedPath ?? target.href)
  const icon = typeInfo.icon
  const badge = isLocalhost
    ? t('assistantOutputs.kind.localhost')
    : target.kind === 'local-html'
      ? t('assistantOutputs.kind.html')
      : target.kind === 'markdown'
        ? t('assistantOutputs.kind.markdown')
        : t('assistantOutputs.kind.image')
  const subtitle = target.subtitle ?? target.normalizedPath ?? target.href
  const showSubtitle = subtitle !== target.title

  const handleOpen = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (onAction) { onAction(target.href); return }
    const resolved = resolveTarget()
    if (resolved.blocked) {
      setFileLinkError(resolved.title ?? '文件引用未唯一定位，请使用完整路径。')
      return
    }
    setFileLinkError(null)
    openPreviewLink(resolved.href, sessionId)
  }, [sessionId, resolveTarget, onAction, target.href])

  const handleOpenWith = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (onAction) { onAction(target.href, event.currentTarget.getBoundingClientRect()); return }
    // Toggle: a second click on the same trigger closes the menu. OpenWithMenu's
    // outside-mousedown ignores the trigger, so the trigger's own click is the
    // only path that can close it on re-click.
    if (openWith) {
      setOpenWith(null)
      return
    }
    const triggerEl = event.currentTarget
    const rect = triggerEl.getBoundingClientRect()
    void (async () => {
      const resolved = resolveTarget()
      if (resolved.blocked) {
        setFileLinkError(resolved.title ?? '文件引用未唯一定位，请使用完整路径。')
        return
      }
      setFileLinkError(null)
      const items = await buildOpenWithMenuItemsForHref(resolved.href, {
        sessionId,
        workDir,
        t: (k, v) => t(k as TranslationKey, v),
      })
      if (items.length === 0) return
      setOpenWith({ items, anchor: rect, triggerEl })
    })()
  }, [openWith, sessionId, t, resolveTarget, workDir, onAction, target.href])

  return (
    <section className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2.5 shadow-[var(--shadow-card)]">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
        {isLocalhost ? (
          <Globe size={17} strokeWidth={2.1} aria-hidden="true" />
        ) : (
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{icon}</span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
            {target.title}
          </span>
          <Badge bordered className="font-semibold uppercase tracking-[0.08em]">
            {badge}
          </Badge>
        </div>
        {fileLinkError && <p role="alert" className="mt-1 whitespace-pre-line text-xs text-[var(--color-text-secondary)]">{fileLinkError}</p>}
        {showSubtitle && (
          <div className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]" title={subtitle}>
            {subtitle}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <IconButton
          icon={<ExternalLink size={14} strokeWidth={2.2} aria-hidden="true" />}
          label={t('assistantOutputs.open')}
          size="md"
          tone="secondary"
          shape="circle"
          filled
          onClick={handleOpen}
        />
        <Button
          variant="secondary"
          size="base"
          aria-label={t('openWith.title')}
          onClick={handleOpenWith}
          className="shrink-0 rounded-full"
          icon={<ChevronDown size={13} strokeWidth={2.2} aria-hidden="true" />}
          iconPosition="end"
        >
          {t('openWith.title')}
        </Button>
      </div>

      {openWith && <OpenWithMenu items={openWith.items} anchor={openWith.anchor} triggerEl={openWith.triggerEl} onClose={() => setOpenWith(null)} />}
    </section>
  )
}
