import { redactHeadlessValue } from '../../utils/headlessRedaction.js'
import { isHeadlessModelLabel } from './headlessProviderLabels.js'
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const counterKeys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'contextWindow', 'maxOutputTokens'] as const

/** The native agent's dollar fields use client model tables, never an enterprise invoice. */
export function projectHeadlessRunCost(raw: unknown, secretValues: string[] = []) {
  const source = object(raw)
  const modelEntries = Object.entries(object(source.modelUsage)).filter(([model]) => isHeadlessModelLabel(model))
  const modelUsage = Object.fromEntries(modelEntries.map(([model, value]) => {
    const usage = object(value)
    return [model, { ...Object.fromEntries(counterKeys.filter(key => numeric(usage[key]) && Number.isSafeInteger(usage[key])).map(key => [key, usage[key]])), costUSD: null }]
  }))
  const total = numeric(source.total_cost_usd) ? source.total_cost_usd : null
  const estimates = modelEntries.map(([model, value]) => ({ model, cost_usd: numeric(object(value).costUSD) ? object(value).costUSD as number : null }))
  const result = {
    total_cost_usd: null,
    cost_status: 'unknown' as const,
    modelUsage,
    cost: {
      status: 'unknown' as const,
      billed_cost: null,
      currency: null,
      reason: '未取得此服务商账单或已验证计价；原生美元字段来自客户端模型价表，不代表实际费用',
      client_estimate: {
        status: total !== null || estimates.some(value => value.cost_usd !== null) ? 'client_estimate' as const : 'unavailable' as const,
        billed: false,
        currency: 'USD',
        total_cost_usd: total,
        model_usage: estimates,
        source: 'native_client_model_table',
      },
    },
  }
  return redactHeadlessValue(result, secretValues) as typeof result
}
