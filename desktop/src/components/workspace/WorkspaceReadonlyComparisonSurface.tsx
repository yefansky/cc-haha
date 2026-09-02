import { useId, type ReactNode } from 'react'
import { useTranslation } from '../../i18n'
import type { WorkspaceDiffCommentSelection } from './WorkspaceDiffSurface'
import { WorkspaceSideBySideDiffSurface } from './WorkspaceSideBySideDiffSurface'
import type { WorkspaceReadonlyComparisonInput } from './workspaceComparisonInput'
import type { WorkspaceSideBySideModel } from './workspaceSideBySideModel'

export interface WorkspaceReadonlyComparisonSurfaceProps {
  input: WorkspaceReadonlyComparisonInput
  className?: string
  hideSingleFileHeader?: boolean
  onAddComment?: (selection: WorkspaceDiffCommentSelection, note: string) => void
  renderHunkAction?: (hunkId: string) => ReactNode
  model?: WorkspaceSideBySideModel
}

export function WorkspaceReadonlyComparisonSurface({
  input,
  className,
  hideSingleFileHeader = false,
  onAddComment,
  renderHunkAction,
  model,
}: WorkspaceReadonlyComparisonSurfaceProps) {
  const t = useTranslation()
  const noticeId = useId()
  const scopeKey = input.scope.replaceAll('-', '_') as
    | 'positioned_patch'
    | 'replacement_fragment'
    | 'proposed_content'
  const scopeNotice = t(`workspace.comparisonInput.notice.${scopeKey}`)

  return (
    <section
      data-testid="workspace-readonly-comparison"
      data-comparison-scope={input.scope}
      data-origin-id={input.origin.id}
      aria-label={t('workspace.comparisonInput.readOnlyLabel', { path: input.path })}
      aria-describedby={noticeId}
      className={className ?? 'flex min-h-0 flex-1 flex-col overflow-hidden'}
    >
      <div
        id={noticeId}
        role="note"
        data-testid="workspace-comparison-scope-notice"
        className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-info-container)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]"
      >
        {scopeNotice}
      </div>
      <WorkspaceSideBySideDiffSurface
        value={input.value}
        path={input.path}
        hideSingleFileHeader={hideSingleFileHeader}
        onAddComment={input.capabilities.comment ? onAddComment : undefined}
        renderHunkAction={input.capabilities.hunkAction ? renderHunkAction : undefined}
        fullOnlyDisabledReason={scopeNotice}
        textPair={input.textPair}
        modelOverride={model}
      />
    </section>
  )
}
