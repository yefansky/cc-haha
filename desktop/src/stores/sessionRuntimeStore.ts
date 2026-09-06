import { create } from 'zustand'
import type { RuntimeSelection } from '../types/runtime'
import type { SessionListItem } from '../types/session'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import { normalizeRuntimeSelection } from '../lib/runtimeSelection'

const STORAGE_KEY = 'cc-haha-session-runtime'
const RETIRED_GROK_MODEL_IDS = new Set([
  'grok-build',
  'grok-build-0.1',
  'grok-4.3',
  'grok-4.20-reasoning',
  'grok-4.20-non-reasoning',
])

export const DRAFT_RUNTIME_SELECTION_KEY = '__draft__'

type SessionRuntimeStore = {
  selections: Record<string, RuntimeSelection>
  revision: number
  selectionRevisions: Record<string, number>
  pendingKeys: Record<string, boolean>
  setPending: (key: string, pending: boolean) => void
  setSelection: (key: string, selection: RuntimeSelection) => void
  clearSelection: (key: string) => void
  moveSelection: (fromKey: string, toKey: string) => void
  syncFromSessions: (sessions: SessionListItem[], requestRevision?: number) => void
}

function normalizeSelection(selection: RuntimeSelection): RuntimeSelection {
  const normalizedSelection = normalizeRuntimeSelection(selection)
  if (
    normalizedSelection.providerId !== GROK_OFFICIAL_PROVIDER_ID ||
    !RETIRED_GROK_MODEL_IDS.has(normalizedSelection.modelId)
  ) {
    return normalizedSelection
  }

  const fallback = GROK_OFFICIAL_MODELS.find(
    (model) => model.id === GROK_OFFICIAL_DEFAULT_MODEL_ID,
  )
  return {
    providerId: GROK_OFFICIAL_PROVIDER_ID,
    modelId: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    ...(fallback?.defaultReasoningEffort
      ? { effortLevel: fallback.defaultReasoningEffort }
      : {}),
  }
}

function normalizeSelections(
  selections: Record<string, RuntimeSelection>,
): { selections: Record<string, RuntimeSelection>; changed: boolean } {
  let changed = false
  const normalized = Object.fromEntries(
    Object.entries(selections).map(([key, selection]) => {
      const next = normalizeSelection(selection)
      if (next !== selection) changed = true
      return [key, next]
    }),
  )
  return { selections: normalized, changed }
}

function loadSelections(): Record<string, RuntimeSelection> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, RuntimeSelection>
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized = normalizeSelections(parsed)
    if (normalized.changed) persistSelections(normalized.selections)
    return normalized.selections
  } catch {
    return {}
  }
}

function persistSelections(selections: Record<string, RuntimeSelection>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selections))
  } catch {
    // noop
  }
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set) => ({
  selections: loadSelections(),
  revision: 0,
  selectionRevisions: {},
  pendingKeys: {},
  setPending: (key, pending) => set(state => ({ pendingKeys: { ...state.pendingKeys, [key]: pending } })),

  setSelection: (key, selection) =>
    set((state) => {
      const selections = {
        ...state.selections,
        [key]: normalizeSelection(selection),
      }
      persistSelections(selections)
      return { selections, revision: state.revision + 1, selectionRevisions: { ...state.selectionRevisions, [key]: state.revision + 1 } }
    }),

  clearSelection: (key) =>
    set((state) => {
      if (!(key in state.selections)) return state
      const { [key]: _removed, ...rest } = state.selections
      persistSelections(rest)
      const { [key]: _revision, ...selectionRevisions } = state.selectionRevisions
      const { [key]: _pending, ...pendingKeys } = state.pendingKeys
      return { selections: rest, revision: state.revision + 1, selectionRevisions: { ...selectionRevisions, [key]: state.revision + 1 }, pendingKeys }
    }),

  moveSelection: (fromKey, toKey) =>
    set((state) => {
      const selection = state.selections[fromKey]
      if (!selection) return state
      const { [fromKey]: _removed, ...rest } = state.selections
      const selections = {
        ...rest,
        [toKey]: selection,
      }
      persistSelections(selections)
      const { [fromKey]: _revision, ...selectionRevisions } = state.selectionRevisions
      const { [fromKey]: pending, ...pendingKeys } = state.pendingKeys
      return { selections, revision: state.revision + 1, selectionRevisions: { ...selectionRevisions, [fromKey]: state.revision + 1, [toKey]: state.revision + 1 }, pendingKeys: { ...pendingKeys, [toKey]: !!pending } }
    }),

  syncFromSessions: (sessions, requestRevision) =>
    set((state) => {
      let selections = state.selections
      for (const session of sessions) {
        if (state.pendingKeys[session.id] || (requestRevision !== undefined && (state.selectionRevisions[session.id] ?? 0) > requestRevision)) continue
        if (!session.runtimeModelId || session.runtimeProviderId === undefined) continue
        const selection = normalizeSelection({
          providerId: session.runtimeProviderId,
          modelId: session.runtimeModelId,
          ...(session.effortLevel ? { effortLevel: session.effortLevel } : {}),
        })
        const current = selections[session.id]
        if (
          current?.providerId === selection.providerId &&
          current.modelId === selection.modelId &&
          current.effortLevel === selection.effortLevel
        ) {
          continue
        }
        if (selections === state.selections) selections = { ...state.selections }
        selections[session.id] = selection
      }
      if (selections === state.selections) return state
      persistSelections(selections)
      return { selections }
    }),
}))
