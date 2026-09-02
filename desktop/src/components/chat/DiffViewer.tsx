import { useMemo } from 'react'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation } from '../../i18n'
import { WorkspaceReadonlyComparisonSurface } from '../workspace/WorkspaceReadonlyComparisonSurface'
import {
  createProposedContentComparisonInput,
  createReplacementFragmentComparisonInput,
} from '../workspace/workspaceComparisonInput'
import {
  buildWorkspaceSideBySideModel,
  buildWorkspaceSideBySideTextPairModel,
  summarizeWorkspaceSideBySideModel,
} from '../workspace/workspaceSideBySideModel'

type Props = {
  filePath: string
  oldString?: string
  newString: string
  scope?: 'replacement-fragment' | 'proposed-content'
  originId?: string
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function DiffViewer({
  filePath,
  oldString = '',
  newString,
  scope = 'replacement-fragment',
  originId,
}: Props) {
  const t = useTranslation()
  const effectiveOriginId = originId
    ?? `tool-fallback:${scope}:${stableHash(`${filePath}\0${oldString}\0${newString}`)}`
  const input = useMemo(() => scope === 'proposed-content'
    ? createProposedContentComparisonInput({
        originId: effectiveOriginId,
        path: filePath,
        content: newString,
      })
    : createReplacementFragmentComparisonInput({
        originId: effectiveOriginId,
        path: filePath,
        oldString,
        newString,
      }), [effectiveOriginId, filePath, newString, oldString, scope])
  const model = useMemo(() => input.textPair
    ? buildWorkspaceSideBySideTextPairModel(input.textPair, input.path)
    : buildWorkspaceSideBySideModel(input.value, undefined, input.path), [input])
  const { additions, deletions } = useMemo(
    () => summarizeWorkspaceSideBySideModel(model),
    [model],
  )

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-code-bg)]">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--color-text-secondary)]">
          {filePath}
        </span>
        <CopyButton
          text={filePath}
          label={t('chat.copyPath')}
          className="shrink-0 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-1 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        />
      </div>
      <div className="flex gap-2 px-3.5 pb-2 font-mono text-[12px] font-semibold">
        <span className="rounded-[var(--radius-sm)] bg-[var(--color-diff-added-gutter)] px-2 py-0.5 text-[var(--color-diff-added-text)]">+{additions}</span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--color-diff-removed-gutter)] px-2 py-0.5 text-[var(--color-diff-removed-text)]">-{deletions}</span>
      </div>
      <div className="max-h-[400px] overflow-auto border-t border-[var(--color-border)]">
        <WorkspaceReadonlyComparisonSurface
          input={input}
          model={model}
          hideSingleFileHeader
          className="min-w-0"
        />
      </div>
    </div>
  )
}
