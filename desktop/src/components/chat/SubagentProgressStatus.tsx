import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import type { SubagentProgress } from '../../lib/subagentProgress'
import { formatTokenCount } from '../../lib/formatTokenCount'

export function SubagentProgressStatus({ progress, sessionId, waiting = false }: {
  progress: SubagentProgress
  sessionId: string
  waiting?: boolean
}) {
  const t = useTranslation()
  const connected = useChatStore(s => s.sessions[sessionId]?.connectionState === 'connected')
  const phase = connected ? progress.phase : 'disconnected'
  return (
    <div data-testid="subagent-progress-status" role="status" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)]">
      <button type="button" className="min-w-0 truncate text-left font-medium text-[var(--color-text-primary)] hover:underline"
        onClick={() => useTabStore.getState().openSubagentTab(sessionId, progress.toolUseId, progress.description)}>
        {t(waiting ? 'chat.subagentProgress.waiting' : 'chat.subagentProgress.running')}: {progress.description}
      </button>
      <span>{t(`chat.subagentProgress.phase.${phase}`)}</span>
      <span className="font-mono tabular-nums">{t('chat.subagentProgress.estimate', { count: formatTokenCount(progress.outputTokensEstimate) })}</span>
    </div>
  )
}
