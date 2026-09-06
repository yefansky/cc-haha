import { Badge } from '@/components/ui/Badge'
import { useTranslation } from '@/i18n'
import type { SavedProvider } from '@/types/provider'

export function ProviderProtocolBadge({ provider }: { provider: Pick<SavedProvider, 'apiFormat' | 'modelCatalog'> }) {
  const t = useTranslation()
  const formats = new Set(provider.modelCatalog?.map(model => model.transport?.apiFormat)
    .filter(format => format === 'anthropic' || format === 'openai_chat' || format === 'openai_responses'))
  if (formats.size > 1) return <Badge tone="warning">{t('settings.providers.multiProtocol')}</Badge>
  if (!provider.apiFormat || provider.apiFormat === 'anthropic') return null
  return <Badge tone="warning">{provider.apiFormat === 'openai_chat' ? 'OpenAI Chat' : 'OpenAI Responses'}</Badge>
}
