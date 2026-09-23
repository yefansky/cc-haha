import { memo, useCallback, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { fileRefFromElement } from '../../lib/markdownAutolink'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import type { TurnCompletion } from '../../lib/turnCompletion'
import { InlineImageGallery } from './InlineImageGallery'
import { InlineVideoGallery } from './InlineVideoGallery'
import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import {
  extractAssistantOutputTargets,
} from '../../lib/assistantOutputTargets'
import { useAssistantFileActions } from '../../lib/useAssistantFileActions'
import type { MessageFileEvidence } from '../../lib/assistantFileEvidence'
import { parseFilePathRef } from '../../lib/filePathBoundary'
import { resolveAssistantFileLink } from '../../lib/assistantFileLink'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useTranslation, type TranslationKey } from '../../i18n'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
  timestamp?: number
  /** This turn's real changed files (absolute), used to anchor output chips onto
   *  files that were actually written instead of guessing from the prose. */
  turnChangedFiles?: string[]
  /** File evidence available at this message, excluding later messages. */
  turnReferencedFiles?: string[]
  fileEvidence?: MessageFileEvidence
  /** Set only on the last reply of a finished turn: when it ended and how long it took. */
  turnCompletion?: TurnCompletion
}

const MAX_CARDS = 3

export const AssistantMessage = memo(function AssistantMessage({ content, isStreaming, branchAction, sessionId, timestamp, turnChangedFiles, turnReferencedFiles, fileEvidence, turnCompletion }: Props) {
  const t = useTranslation()
  const workDir = useWorkspacePanelStore((s) => (sessionId ? s.statusBySession[sessionId]?.workDir : undefined))

  const rootsRevision = useWorkspacePanelStore((s) => JSON.stringify(s.mountedRoots ?? []))
  const actions = useAssistantFileActions({ sessionId: sessionId ?? '', workDir: workDir ?? '', rootsRevision, evidence: fileEvidence, changedFiles: turnChangedFiles, referencedFiles: turnReferencedFiles }, (key, vars) => t(key as TranslationKey, vars))
  const resolveFileLink = useCallback((href: string) => {
    const ref = parseFilePathRef(href)
    const candidates = ref && fileEvidence ? fileEvidence.index.lookup(ref.path, fileEvidence.cutoff, /^[a-z]:/i.test(workDir ?? '')).candidates : turnReferencedFiles
    return resolveAssistantFileLink(href, { workDir, changedFiles: turnChangedFiles, referencedFiles: candidates })
  }, [workDir, turnChangedFiles, turnReferencedFiles, fileEvidence])
  const resolveLinkTitle = useCallback((href: string) => resolveFileLink(href).title, [resolveFileLink])
  const handleLinkClick = useCallback((href: string, event: ReactMouseEvent<HTMLDivElement>): boolean => {
    if (!sessionId) return false
    event.preventDefault()
    actions.activate(href)
    return true
  }, [sessionId, actions])
  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!sessionId) return
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[data-file-path], a[href]')
    const href = fileRefFromElement(link) ?? link?.getAttribute('href')
    if (!href) return
    event.preventDefault()
    actions.activate(href, link!.getBoundingClientRect())
  }, [sessionId, actions])

  const outputTargets = useMemo(
    () =>
      isStreaming || !sessionId
        ? []
        : // Image/video targets render inline (InlineImageGallery/InlineVideoGallery); never also as a card.
          extractAssistantOutputTargets(content, { workDir, changedFiles: turnChangedFiles }).filter(
            (target) => {
              if (target.kind === 'image' || target.kind === 'video') return false
              return target.kind === 'localhost-url' || turnChangedFiles !== undefined
            },
          ),
    [content, isStreaming, sessionId, workDir, turnChangedFiles],
  )

  if (!content.trim()) return null

  const documentLayout = shouldUseDocumentLayout(content)
  const showTurnCompletion = !isStreaming && Boolean(turnCompletion)

  return (
    <div className="mb-5 flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        className={`group flex min-w-0 flex-col items-start ${
          documentLayout
            ? 'w-full max-w-full'
            : 'max-w-[88%] sm:max-w-[80%] lg:max-w-[720px]'
        }`}
      >
        <div
          onContextMenu={sessionId ? handleContextMenu : undefined}
          className={`rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[14.5px] text-[var(--color-text-primary)] shadow-[var(--shadow-card)] ${
            documentLayout ? 'w-full' : 'max-w-full'
          }`}
        >
          <MarkdownRenderer
            content={content}
            variant={documentLayout ? 'document' : 'default'}
            streaming={isStreaming}
            onLinkClick={sessionId ? handleLinkClick : undefined}
            resolveLinkTitle={sessionId ? resolveLinkTitle : undefined}
          />
          {!isStreaming && (
            <InlineImageGallery
              text={content}
              sessionId={sessionId}
              workDir={workDir}
              changedFiles={turnChangedFiles}
              suppressManagedGeneratedImages
            />
          )}
          {!isStreaming && (
            <InlineVideoGallery
              text={content}
              sessionId={sessionId}
              workDir={workDir}
              changedFiles={turnChangedFiles}
            />
          )}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-shimmer bg-[var(--color-brand)] align-text-bottom" />
          )}
        </div>

        {actions.feedback && <div role="alert" className="mt-2 whitespace-pre-line text-sm text-[var(--color-text-secondary)]">
          <p>{actions.feedback.text}</p>
          {actions.feedback.candidates.map((path) => <button key={path} className="block text-left underline" onClick={() => actions.activate(path, actions.feedback?.anchor)}>{path}</button>)}
        </div>}

        {!isStreaming && sessionId && outputTargets.length > 0 && (
          <div className="mt-1 flex w-full flex-col gap-2">
            {outputTargets.slice(0, MAX_CARDS).map((target) => (
              <AssistantOutputTargetCard key={target.id} target={target} sessionId={sessionId} workDir={workDir} resolveFileLink={resolveFileLink} onAction={actions.activate} />
            ))}
            {outputTargets.length > MAX_CARDS && (
              <div className="px-1 text-xs text-[var(--color-text-tertiary)]">
                {t('assistantOutputs.moreOutputs', { count: String(outputTargets.length - MAX_CARDS) })}
              </div>
            )}
          </div>
        )}

        {actions.menu && (
          <OpenWithMenu
            items={actions.menu.items}
            anchor={actions.menu.anchor}
            notice={actions.menu.notice}
            onClose={actions.closeMenu}
          />
        )}

        {showTurnCompletion ? <TurnCompletionStamp completion={turnCompletion!} /> : null}

        <MessageActionBar
          copyText={isStreaming ? undefined : content}
          copyLabel={t('chat.copyReply')}
          branchAction={branchAction}
          align="start"
          // The stamp above already carries this turn's end time; a hover chip
          // repeating it a line below reads as two different times.
          timestamp={showTurnCompletion ? undefined : timestamp}
        />
      </div>
    </div>
  )
})

function shouldUseDocumentLayout(content: string) {
  const normalized = content.trim()
  if (!normalized) return false

  if (/```/.test(normalized)) return true
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.+\|)/m.test(normalized)) return true

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  return paragraphs.length >= 2 || normalized.split('\n').filter((line) => line.trim()).length >= 8
}
