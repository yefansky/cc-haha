import { memo, useEffect, useRef } from 'react'
import { SendHorizontal, Undo2 } from 'lucide-react'
import type { UIAttachment } from '../../types/chat'
import { AttachmentGallery } from './AttachmentGallery'
import {
  MessageActionBar,
  type MessageBranchAction,
  type MessageEditAction,
  type MessageEditComposer,
} from './MessageActionBar'

type Props = {
  content: string
  attachments?: UIAttachment[]
  branchAction?: MessageBranchAction
  editAction?: MessageEditAction
  editComposer?: MessageEditComposer
  timestamp?: number
}

export const UserMessage = memo(function UserMessage({ content, attachments, branchAction, editAction, editComposer, timestamp }: Props) {
  const hasText = content.trim().length > 0
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editComposer) return
    textareaRef.current?.focus()
    textareaRef.current?.setSelectionRange(editComposer.value.length, editComposer.value.length)
  }, [editComposer])

  return (
    <div className="mb-5 flex justify-end">
      <div
        data-message-shell="user"
        className="group flex min-w-0 max-w-[82%] flex-col items-end sm:max-w-[78%] lg:max-w-[72%]"
      >
        <div className="flex max-w-full flex-col items-end gap-2">
          {attachments && attachments.length > 0 && (
            <AttachmentGallery attachments={attachments} variant="message" />
          )}

          {editComposer ? (
            <div
              data-message-editor
              className="min-w-0 max-w-full bg-[var(--color-surface-user-msg)] px-3 py-3 text-sm text-[var(--color-text-primary)]"
              style={{ borderRadius: '18px 4px 18px 18px' }}
            >
              <textarea
                ref={textareaRef}
                value={editComposer.value}
                onChange={(event) => editComposer.onChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    editComposer.onCancel()
                  } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    editComposer.onSubmit()
                  }
                }}
                aria-label="Edit prompt"
                disabled={editComposer.submitting}
                className="min-h-24 w-full resize-y rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface)] px-3 py-2 leading-relaxed outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20 disabled:cursor-wait disabled:opacity-70"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={editComposer.onCancel}
                  disabled={editComposer.submitting}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-container-high)] disabled:cursor-wait disabled:opacity-60"
                >
                  <Undo2 size={14} aria-hidden="true" />
                  {editComposer.cancelLabel}
                </button>
                <button
                  type="button"
                  onClick={editComposer.onSubmit}
                  disabled={editComposer.submitting || !editComposer.value.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-brand)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-brand-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <SendHorizontal size={14} aria-hidden="true" />
                  {editComposer.submitLabel}
                </button>
              </div>
            </div>
          ) : hasText && (
            <div
              className="min-w-0 max-w-full bg-[var(--color-surface-user-msg)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap break-words"
              style={{
                borderRadius: '18px 4px 18px 18px',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              {content}
            </div>
          )}
        </div>

        {hasText && !editComposer && (
          <MessageActionBar
            copyText={content}
            copyLabel="Copy prompt"
            branchAction={branchAction}
            editAction={editAction}
            align="end"
            timestamp={timestamp}
          />
        )}
      </div>
    </div>
  )
})
