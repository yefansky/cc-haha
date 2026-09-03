import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { CircleAlert, Code2, Eye, FileText, FolderOpen, FolderPlus, GitCompareArrows, Link2, MessageCircle, PanelRightClose, PanelRightOpen, RefreshCw, Search, X } from 'lucide-react'
import { Highlight } from 'prism-react-renderer'
import {
  sessionsApi,
  type WorkspaceSearchResult,
  type WorkspaceChangedFile,
  type WorkspaceFileStatus,
  type WorkspaceTextEncoding,
  type WorkspaceTreeEntry,
  type WorkspaceTreeResult,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { useShallow } from 'zustand/react/shallow'
import {
  getWorkspacePreviewTabId,
  useWorkspacePanelStore,
  type WorkspacePreviewCloseScope,
  type WorkspacePreviewKind,
  type WorkspacePreviewReveal,
  type WorkspacePreviewTab,
} from '../../stores/workspacePanelStore'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useUIStore } from '../../stores/uiStore'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { useDismissable } from '@/hooks/useDismissable'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'
import { clearWindowSelection, getSelectionPopoverPosition, useSelectionPopoverDismiss } from '../../hooks/useSelectionPopoverDismiss'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { createWorkspaceMarkdownImageResolver } from '../../lib/markdownImages'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { isHtmlFilePath } from '../../lib/htmlPreviewPolicy'
import { openPreviewLink } from '../../lib/openPreviewLink'
import {
  getFileExtension,
  normalizePrismLanguage,
  WORKSPACE_PREVIEW_LINE_LIMIT,
  workspacePrismTheme,
  type WorkspaceDiffCommentSelection,
} from './WorkspaceCodeSurface'
import { WorkspaceFileOpenWith } from './WorkspaceFileOpenWith'
import { WorkspaceSideBySideDiffSurface } from './WorkspaceSideBySideDiffSurface'
import {
  discardWorkspaceComparisonSession,
  isWorkspaceComparisonSessionDirty,
  saveWorkspaceComparisonSession,
  type WorkspaceComparisonSourceSide,
} from './workspaceComparisonSession'
import { WorkspaceTableSurface } from './WorkspaceTableSurface'
import { getWorkspaceStatusLabel } from './fileIdentity'
import type { WorkspaceDiffHighlightToken } from './workspaceDiffHighlighter'
import { isWorkspaceTablePath } from './workspaceTablePreview'

type WorkspacePanelProps = {
  sessionId: string
  /** Keep the explorer and editor visible side by side, like VS Code. */
  layout?: 'standard' | 'vscode'
  /**
   * When hosted inside the unified WorkbenchPanel, the close action lives in the
   * shared workbench mode strip. Set this to drop WorkspacePanel's own close
   * button so the panel header doesn't render a duplicate close control.
   */
  embedded?: boolean
  /**
   * Main-content workbench tabs reuse the same workspace preview UI without
   * depending on the right-side panel's open bit.
   */
  forceVisible?: boolean
}

type WorkspaceDirtyActionKind = 'refresh' | 'switch' | 'close'

type WorkspacePendingDirtyAction = {
  kind: WorkspaceDirtyActionKind
  tabIds: string[]
  proceed: () => void | Promise<void>
}

type TreeNodeProps = {
  sessionId: string
  entry: WorkspaceTreeEntry
  depth: number
  expandedPaths: Set<string>
  treeByPath: Record<string, WorkspaceTreeResult | undefined>
  treeLoadingByPath: Record<string, boolean | undefined>
  treeErrorsByPath: Record<string, string | null | undefined>
  changedFilesByPath: Map<string, WorkspaceChangedFile>
  filterQuery: string
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onFileContextMenu: (event: ReactMouseEvent, path: string, isDirectory: boolean) => void
  activePath: string | null
  variant?: 'tree' | 'changed'
}

type FileContextMenuState = {
  path: string
  isDirectory: boolean
  x: number
  y: number
}

const FILE_STATUS_META: Record<WorkspaceFileStatus, { label: string; className: string }> = {
  modified: {
    label: 'M',
    className: 'text-[var(--color-warning)]',
  },
  added: {
    label: 'A',
    className: 'text-[var(--color-success)]',
  },
  deleted: {
    label: 'D',
    className: 'text-[var(--color-error)]',
  },
  renamed: {
    label: 'R',
    className: 'text-[var(--color-info)]',
  },
  untracked: {
    label: 'U',
    className: 'text-[var(--color-info)]',
  },
  copied: {
    label: 'C',
    className: 'text-[var(--color-info)]',
  },
  type_changed: {
    label: 'T',
    className: 'text-[var(--color-text-secondary)]',
  },
  unknown: {
    label: '?',
    className: 'text-[var(--color-text-secondary)]',
  },
}

const EMPTY_TREE_BY_PATH: Record<string, WorkspaceTreeResult | undefined> = {}
const EMPTY_PREVIEW_TABS: WorkspacePreviewTab[] = []
const EMPTY_EXPANDED_PATHS: string[] = []
const SELECTION_MENU_OFFSET = 10
const SELECTION_MENU_WIDTH = 158
const SELECTION_MENU_HEIGHT = 44
const WORKSPACE_SEARCH_DEBOUNCE_MS = 250
const WORKSPACE_NAVIGATOR_WIDTH_STORAGE_KEY = 'workspace.navigatorWidth'
const WORKSPACE_NAVIGATOR_DEFAULT_WIDTH = 320
const WORKSPACE_NAVIGATOR_MIN_WIDTH = 220
const WORKSPACE_NAVIGATOR_MAX_WIDTH = 720
const WORKSPACE_PREVIEW_MIN_WIDTH = 240
const PLAINTEXT_FILE_EXTENSIONS = new Set([
  'asm', 'bash', 'bat', 'c', 'cc', 'cfg', 'cjs', 'cmake', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts',
  'def', 'go', 'h', 'hh', 'hpp', 'html', 'i', 'ini', 'inl', 'java', 'js', 'json',
  'jsx', 'lh', 'li', 'log', 'lua', 'm', 'md', 'mjs', 'mm', 'ps1', 'py', 'rc',
  'mts', 'rs', 'sh', 'shell', 'sln', 'sql', 'svg', 'tab', 'targets', 'toml', 'ts', 'tsx', 'tsv',
  'txt', 'vcproj', 'vcxproj', 'xml', 'yaml', 'yml', 'zsh',
])
const PLAINTEXT_FILE_NAMES = new Set(['cmakelists.txt', 'dockerfile', 'makefile', 'readme', 'license'])
type ChangedVersionFilter = 'all' | 'versioned' | 'untracked'

function clampWorkspaceNavigatorWidth(width: number, availableMaximum = WORKSPACE_NAVIGATOR_MAX_WIDTH) {
  const maximum = Math.max(WORKSPACE_NAVIGATOR_MIN_WIDTH, Math.min(WORKSPACE_NAVIGATOR_MAX_WIDTH, availableMaximum))
  return Math.min(maximum, Math.max(WORKSPACE_NAVIGATOR_MIN_WIDTH, Math.round(width)))
}

function readWorkspaceNavigatorWidth() {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_NAVIGATOR_WIDTH_STORAGE_KEY)
    const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10)
    return Number.isFinite(parsed) ? clampWorkspaceNavigatorWidth(parsed) : WORKSPACE_NAVIGATOR_DEFAULT_WIDTH
  } catch {
    return WORKSPACE_NAVIGATOR_DEFAULT_WIDTH
  }
}

function persistWorkspaceNavigatorWidth(width: number) {
  try {
    window.localStorage.setItem(WORKSPACE_NAVIGATOR_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // localStorage may be unavailable; the in-memory width still remains usable.
  }
}
const FILE_BADGE_META: Record<string, { label: string; className: string }> = {
  ts: { label: 'TS', className: 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]' },
  tsx: { label: 'TSX', className: 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]' },
  js: { label: 'JS', className: 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]' },
  jsx: { label: 'JSX', className: 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]' },
  json: { label: '{}', className: 'bg-[var(--color-surface-container-high)] text-[var(--color-text-secondary)]' },
  md: { label: 'MD', className: 'bg-[var(--color-surface-container-high)] text-[var(--color-text-secondary)]' },
  css: { label: 'CSS', className: 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]' },
  html: { label: 'H', className: 'bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]' },
  png: { label: 'IMG', className: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]' },
  jpg: { label: 'IMG', className: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]' },
  jpeg: { label: 'IMG', className: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]' },
  gif: { label: 'IMG', className: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]' },
  svg: { label: 'SVG', className: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]' },
}

function makeTreeStateKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

function makePreviewStateKey(sessionId: string, tabId: string) {
  return `${sessionId}::${tabId}`
}

function getSessionScopedRecord<T>(
  record: Record<string, T>,
  sessionId: string,
) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key.startsWith(prefix)),
  ) as Record<string, T>
}

function getPreviewKindLabel(
  t: ReturnType<typeof useTranslation>,
  kind: WorkspacePreviewKind,
) {
  return kind === 'diff' ? t('workspace.previewKind.diff') : t('workspace.previewKind.file')
}

function getFileBadgeMeta(name: string) {
  const extension = getFileExtension(name)
  return FILE_BADGE_META[extension] ?? {
    label: extension ? extension.slice(0, 3).toUpperCase() : 'TXT',
    className: 'bg-[var(--color-surface-container-high)] text-[var(--color-text-secondary)]',
  }
}

function resolveWorkspaceAttachmentPath(workDir: string | undefined, filePath: string) {
  if (!workDir || filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath)) return filePath
  return `${workDir.replace(/[\\/]+$/, '')}/${filePath.replace(/^[/\\]+/, '')}`
}

function getWorkspaceReferenceName(path: string, isDirectory = false) {
  const name = path.split('/').filter(Boolean).pop() || path
  return isDirectory && !name.endsWith('/') ? `${name}/` : name
}

function isMarkdownPreview(tab: WorkspacePreviewTab) {
  if (tab.kind !== 'file') return false
  const language = (tab.language ?? '').toLowerCase()
  const extension = getFileExtension(tab.path)
  return language === 'markdown' || language === 'md' || extension === 'md' || extension === 'markdown'
}

function isTablePreview(tab: WorkspacePreviewTab) {
  return tab.kind === 'file' && isWorkspaceTablePath(tab.path)
}

function FileTypeBadge({ name, subtle = false }: { name: string; subtle?: boolean }) {
  const meta = getFileBadgeMeta(name)
  return (
    <span
      className={`inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] px-1 font-[var(--font-label)] text-[9px] font-semibold leading-none ${meta.className} ${subtle ? 'opacity-55 grayscale' : ''}`}
      aria-hidden="true"
    >
      {meta.label}
    </span>
  )
}

function getInlineStateMessage(
  t: ReturnType<typeof useTranslation>,
  state: WorkspacePreviewTab['state'] | WorkspaceTreeResult['state'] | 'not_git_repo' | undefined,
  fallbackError?: string | null,
) {
  switch (state) {
    case 'loading':
      return t('workspace.previewState.loading')
    case 'binary':
      return t('workspace.previewState.binary')
    case 'too_large':
      return t('workspace.previewState.tooLarge')
    case 'missing':
      return t('workspace.previewState.missing')
    case 'not_git_repo':
      return t('workspace.notGitRepo')
    case 'error':
      return fallbackError || t('workspace.loadError')
    default:
      return fallbackError || t('workspace.loadError')
  }
}

function normalizeFilterQuery(query: string) {
  return query.trim().toLowerCase()
}

function normalizeWorkspacePathKey(filePath: string) {
  return filePath.replace(/\\/g, '/')
}

function changedFileMatchesFilter(file: WorkspaceChangedFile, query: string) {
  if (!query) return true
  return (
    file.path.toLowerCase().includes(query)
    || file.oldPath?.toLowerCase().includes(query)
    || file.status.toLowerCase().includes(query)
  )
}

function changedFileMatchesVersionFilter(
  file: WorkspaceChangedFile,
  versionFilter: ChangedVersionFilter,
) {
  if (versionFilter === 'all') return true
  return versionFilter === 'untracked'
    ? file.status === 'untracked'
    : file.status !== 'untracked'
}

function isLikelyPlaintextChangedFile(file: WorkspaceChangedFile) {
  if (file.isDirectory) return false
  const normalizedPath = normalizeWorkspacePathKey(file.path)
  const fileName = normalizedPath.split('/').pop()?.toLowerCase() ?? ''
  const extensionIndex = fileName.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex + 1) : ''
  return PLAINTEXT_FILE_NAMES.has(fileName) || PLAINTEXT_FILE_EXTENSIONS.has(extension)
}

function buildChangedTree(files: WorkspaceChangedFile[]) {
  const changedFileByPath = new Map(
    files.map((file) => [normalizeWorkspacePathKey(file.path), file]),
  )
  const entriesByParent = new Map<string, Map<string, WorkspaceTreeEntry>>()

  for (const file of files) {
    const normalizedPath = normalizeWorkspacePathKey(file.path)
    const segments = normalizedPath.split('/').filter(Boolean)
    for (let index = 0; index < segments.length; index += 1) {
      const entryPath = segments.slice(0, index + 1).join('/')
      const parentPath = segments.slice(0, index).join('/')
      const exactChange = changedFileByPath.get(entryPath)
      const isFinalSegment = index === segments.length - 1
      const entry: WorkspaceTreeEntry = {
        name: segments[index]!,
        path: entryPath,
        isDirectory: isFinalSegment ? Boolean(file.isDirectory) : true,
        ...(exactChange?.isSymlink ? { isSymlink: true } : {}),
      }
      const siblings = entriesByParent.get(parentPath) ?? new Map<string, WorkspaceTreeEntry>()
      const existing = siblings.get(entryPath)
      if (!existing || entry.isSymlink || (!isFinalSegment && !existing.isDirectory)) {
        siblings.set(entryPath, entry)
      }
      entriesByParent.set(parentPath, siblings)
    }
  }

  const treeByPath: Record<string, WorkspaceTreeResult | undefined> = {}
  for (const [parentPath, entries] of entriesByParent) {
    treeByPath[parentPath] = {
      state: 'ok',
      path: parentPath,
      entries: [...entries.values()].sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
        return left.name.localeCompare(right.name)
      }),
    }
  }
  return treeByPath
}

function treeEntryMatchesFilter(
  entry: WorkspaceTreeEntry,
  query: string,
  treeByPath: Record<string, WorkspaceTreeResult | undefined>,
): boolean {
  if (!query) return true
  if (entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)) {
    return true
  }

  if (!entry.isDirectory) return false
  const childTree = treeByPath[entry.path]
  if (childTree?.state !== 'ok') return false
  return childTree.entries.some((child) => treeEntryMatchesFilter(child, query, treeByPath))
}

type WorkspaceTextSelection = {
  text: string
  startLine?: number
  endLine?: number
}

type FloatingSelectionMenuState = WorkspaceTextSelection & {
  x: number
  y: number
}

type SelectionPointer = {
  clientX: number
  clientY: number
}

function getElementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function getLineNumberFromNode(node: Node | null, root: HTMLElement) {
  const element = getElementForNode(node)
  const row = element?.closest('[data-workspace-line-number]')
  if (!row || !root.contains(row)) return undefined
  const line = Number(row.getAttribute('data-workspace-line-number'))
  return Number.isFinite(line) ? line : undefined
}

function getSelectionPosition(
  range: Range,
  root: HTMLElement,
  selection: Selection,
  pointer?: SelectionPointer,
) {
  return getSelectionPopoverPosition(range, root, {
    menuWidth: SELECTION_MENU_WIDTH,
    menuHeight: SELECTION_MENU_HEIGHT,
    offset: SELECTION_MENU_OFFSET,
    fallbackPointer: pointer,
    selectionFocus: { node: selection.focusNode, offset: selection.focusOffset },
  })
}

function getTextSelectionFromContainer(
  root: HTMLElement | null,
  resolveLines?: (text: string, range: Range) => { startLine?: number; endLine?: number },
  pointer?: SelectionPointer,
): FloatingSelectionMenuState | null {
  if (!root) return null

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const startElement = getElementForNode(range.startContainer)
  const endElement = getElementForNode(range.endContainer)
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) {
    return null
  }

  const text = selection.toString().trim()
  if (!text) return null

  const nodeLines = {
    startLine: getLineNumberFromNode(range.startContainer, root),
    endLine: getLineNumberFromNode(range.endContainer, root),
  }
  const resolvedLines = resolveLines?.(text, range) ?? nodeLines
  const startLine = resolvedLines.startLine ?? nodeLines.startLine
  const endLine = resolvedLines.endLine ?? nodeLines.endLine ?? startLine
  const orderedStart = startLine && endLine ? Math.min(startLine, endLine) : startLine
  const orderedEnd = startLine && endLine ? Math.max(startLine, endLine) : endLine

  return {
    ...getSelectionPosition(range, root, selection, pointer),
    text,
    ...(orderedStart ? { startLine: orderedStart } : {}),
    ...(orderedEnd ? { endLine: orderedEnd } : {}),
  }
}

function getLineRangeForText(value: string, text: string) {
  const index = value.indexOf(text)
  if (index < 0) return {}
  const startLine = value.slice(0, index).split('\n').length
  const endLine = startLine + text.split('\n').length - 1
  return { startLine, endLine }
}

function FloatingSelectionMenu({
  selection,
  onAdd,
  popoverRef,
}: {
  selection: FloatingSelectionMenuState | null
  onAdd: () => void
  popoverRef: { current: HTMLButtonElement | null }
}) {
  const t = useTranslation()
  if (!selection) return null

  return (
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(event) => {
        if (event.button === 0 && !event.ctrlKey) event.preventDefault()
      }}
      onClick={onAdd}
      className="glass-panel fixed z-[var(--z-popover)] inline-flex h-11 items-center gap-2 rounded-full px-5 text-[15px] font-semibold text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      style={{ left: selection.x, top: selection.y }}
    >
      <MessageCircle size={21} strokeWidth={2.15} className="shrink-0 text-[var(--color-text-primary)]" aria-hidden="true" />
      <span>{t('workspace.addSelectionToChat')}</span>
    </button>
  )
}

function PanelMessage({
  icon,
  message,
  tone = 'muted',
  compact = false,
  announce = true,
}: {
  icon: string
  message: string
  tone?: 'muted' | 'error'
  compact?: boolean
  announce?: boolean
}) {
  const toneClass =
    tone === 'error'
      ? 'text-[var(--color-error)]'
      : 'text-[var(--color-text-tertiary)]'

  return (
    <div
      className={`flex items-center gap-2 px-4 ${compact ? 'py-2 text-[11px]' : 'py-8 text-xs'} ${toneClass}`}
      role={announce ? tone === 'error' ? 'alert' : 'status' : undefined}
    >
      <span className={`material-symbols-outlined shrink-0 text-[16px] ${icon === 'progress_activity' ? 'animate-spin' : ''}`}>
        {icon}
      </span>
      <span className="min-w-0 leading-relaxed">{message}</span>
    </div>
  )
}

function WorkspaceFilterInput({
  value,
  onChange,
  summary,
  mode,
  loading = false,
  inputRef,
  onFocusFirstResult,
}: {
  value: string
  onChange: (value: string) => void
  summary?: string
  mode: 'changed' | 'all'
  loading?: boolean
  inputRef: RefObject<HTMLInputElement>
  onFocusFirstResult?: () => void
}) {
  const t = useTranslation()
  const placeholder = mode === 'all'
    ? t('workspace.searchAllPlaceholder')
    : t('workspace.filterChangedPlaceholder')

  return (
    <div className="shrink-0 border-b border-[var(--color-border)] px-3 pb-2.5 pt-2.5">
      <div className="flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 text-[var(--color-text-tertiary)] transition-[background-color,border-color,box-shadow] duration-150 ease-out focus-within:border-[var(--color-border-focus)] focus-within:bg-[var(--color-surface)] focus-within:shadow-[var(--shadow-focus-ring)]">
        <Search size={15} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value) {
              event.preventDefault()
              onChange('')
            } else if (event.key === 'ArrowDown' && onFocusFirstResult) {
              event.preventDefault()
              onFocusFirstResult()
            }
          }}
          aria-label={placeholder}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
        {loading && (
          <RefreshCw size={13} aria-hidden="true" className="shrink-0 animate-spin" />
        )}
        {value.length > 0 && (
          <IconButton
            icon={<X size={13} strokeWidth={2} aria-hidden="true" />}
            label={t('workspace.clearFilter')}
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            size="sm"
            tone="muted"
            showTooltip={false}
          />
        )}
      </div>
      {summary && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 px-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]"
        >
          {summary}
        </div>
      )}
    </div>
  )
}

function ChangedFilesFilterBar({
  plainTextOnly,
  versionFilter,
  onPlainTextOnlyChange,
  onVersionFilterChange,
}: {
  plainTextOnly: boolean
  versionFilter: ChangedVersionFilter
  onPlainTextOnlyChange: (value: boolean) => void
  onVersionFilterChange: (value: ChangedVersionFilter) => void
}) {
  const t = useTranslation()
  const versionOptions: Array<{ value: ChangedVersionFilter; label: string }> = [
    { value: 'all', label: t('workspace.filterVersionAll') },
    { value: 'versioned', label: t('workspace.filterVersioned') },
    { value: 'untracked', label: t('workspace.filterUntracked') },
  ]

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-text-primary)]/10 px-3 py-2">
      <button
        type="button"
        aria-pressed={plainTextOnly}
        onClick={() => onPlainTextOnlyChange(!plainTextOnly)}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-[7px] border px-2 text-[11px] font-medium transition-colors ${
          plainTextOnly
            ? 'border-[var(--color-info)]/35 bg-[var(--color-info-container)] text-[var(--color-info)]'
            : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <FileText size={12} aria-hidden="true" />
        {t('workspace.filterPlaintext')}
      </button>
      <div
        role="group"
        aria-label={t('workspace.filterVersionStatus')}
        className="ml-auto inline-flex min-w-0 overflow-hidden rounded-[7px] border border-[var(--color-border)]"
      >
        {versionOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={versionFilter === option.value}
            onClick={() => onVersionFilterChange(option.value)}
            className={`h-[26px] min-w-0 border-l border-[var(--color-border)] px-2 text-[10px] font-medium first:border-l-0 ${
              versionFilter === option.value
                ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)]'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function FileStatusBadge({ status }: { status: WorkspaceFileStatus }) {
  const t = useTranslation()
  const meta = FILE_STATUS_META[status]
  return (
    <span
      className={`inline-flex h-5 w-4 shrink-0 items-center justify-center font-mono text-[10px] font-semibold ${meta.className}`}
      aria-label={getWorkspaceStatusLabel(status, t)}
    >
      {meta.label}
    </span>
  )
}

function workspaceCodeTokenStyle(token: WorkspaceDiffHighlightToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
  }
}

function CodeSurface({
  value,
  language,
  reveal,
  onAddLineComment,
  onAddSelection,
}: {
  value: string
  language: string
  reveal?: WorkspacePreviewReveal
  onAddLineComment: (lineStart: number, lineEnd: number, note: string, quote: string) => void
  onAddSelection: (selection: WorkspaceTextSelection) => void
}) {
  const t = useTranslation()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const [commentRange, setCommentRange] = useState<{ anchorLine: number; focusLine: number } | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [showAllLines, setShowAllLines] = useState(false)
  const [selectionMenu, setSelectionMenu] = useState<FloatingSelectionMenuState | null>(null)
  const [shikiTokensByLine, setShikiTokensByLine] = useState<WorkspaceDiffHighlightToken[][] | null>(null)
  const lines = value.split('\n')
  const visibleLines = showAllLines ? lines : lines.slice(0, WORKSPACE_PREVIEW_LINE_LIMIT)
  const commentLineStart = commentRange ? Math.min(commentRange.anchorLine, commentRange.focusLine) : null
  const commentLineEnd = commentRange ? Math.max(commentRange.anchorLine, commentRange.focusLine) : null
  const activeQuote = commentLineStart && commentLineEnd
    ? visibleLines.slice(commentLineStart - 1, commentLineEnd).join('\n')
    : ''
  const usePlainLargePreview = showAllLines && lines.length > WORKSPACE_PREVIEW_LINE_LIMIT
  const visibleCode = usePlainLargePreview ? '' : visibleLines.join('\n')

  useEffect(() => {
    setShowAllLines(false)
    setCommentRange(null)
    setCommentDraft('')
    setSelectionMenu(null)
  }, [language, value])

  const revealLine = reveal?.line
  const revealNonce = reveal?.nonce

  // A reference past the fold (`foo.ts:900`) is unreachable while the preview is
  // truncated, so expand first. Declared AFTER the reset effect above on purpose:
  // effects run in declaration order, so when a reload changes `value` the reset
  // collapses and this re-expands, rather than the other way round.
  useEffect(() => {
    if (revealLine && revealLine > WORKSPACE_PREVIEW_LINE_LIMIT) setShowAllLines(true)
  }, [revealLine, revealNonce, value])

  // Scroll the marked line into view. `shikiTokensByLine` and `showAllLines` are
  // dependencies because both rebuild the line rows underneath us — highlighting
  // resolves asynchronously, so the row may not exist on the first pass.
  useEffect(() => {
    if (!revealLine) return
    const surface = surfaceRef.current
    const row = surface?.querySelector<HTMLElement>(`[data-workspace-line-number="${revealLine}"]`)
    if (!surface || !row) return

    // Deliberately not scrollIntoView: that also scrolls every ancestor, which
    // drags the whole chat column when the workbench is a side panel.
    const rowRect = row.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    const delta = rowRect.top - surfaceRect.top - surface.clientHeight / 2 + rowRect.height / 2
    surface.scrollTop = Math.max(0, surface.scrollTop + delta)
  }, [revealLine, revealNonce, value, shikiTokensByLine, showAllLines])

  useEffect(() => {
    if (usePlainLargePreview) {
      setShikiTokensByLine(null)
      return
    }

    let cancelled = false
    setShikiTokensByLine(null)
    void import('./workspaceDiffHighlighter')
      .then(({ highlightWorkspaceCode }) => highlightWorkspaceCode({ value: visibleCode, language }))
      .then((result) => {
        if (!cancelled && result.engine === 'shiki') setShikiTokensByLine(result.tokensByLine)
      })
      .catch(() => {
        if (!cancelled) setShikiTokensByLine(null)
      })
    return () => {
      cancelled = true
    }
  }, [language, usePlainLargePreview, visibleCode])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const submitLineComment = () => {
    if (!commentLineStart || !commentLineEnd || !commentDraft.trim()) return
    onAddLineComment(commentLineStart, commentLineEnd, commentDraft.trim(), activeQuote)
    setCommentRange(null)
    setCommentDraft('')
  }

  const handleSelectionMouseUp = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.ctrlKey) {
      setSelectionMenu(null)
      return
    }
    const selection = getTextSelectionFromContainer(surfaceRef.current, undefined, event)
    if (!selection?.startLine || !selection.endLine || selection.startLine === selection.endLine) {
      setSelectionMenu(selection)
      return
    }

    setSelectionMenu({
      ...selection,
      text: visibleLines.slice(selection.startLine - 1, selection.endLine).join('\n').trim(),
    })
  }

  const addCurrentSelectionToChat = () => {
    if (!selectionMenu) return
    onAddSelection({
      text: selectionMenu.text,
      startLine: selectionMenu.startLine,
      endLine: selectionMenu.endLine,
    })
    setSelectionMenu(null)
    clearWindowSelection()
  }

  const renderLineCommentEditor = (lineNumber: number) => {
    if (!commentLineStart || commentLineEnd !== lineNumber) return null

    return (
      <div className="grid grid-cols-[48px_minmax(0,720px)] gap-3 bg-[var(--color-brand-soft)] px-3 py-2">
        <span aria-hidden="true" />
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <span className="material-symbols-outlined text-[15px] text-[var(--color-text-tertiary)]">chat_bubble</span>
            <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{t('workspace.localComment')}</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
              {commentLineStart === commentLineEnd
                ? t('workspace.commentLineTarget', { line: commentLineStart })
                : t('workspace.commentLineRangeTarget', { start: commentLineStart, end: commentLineEnd })}
            </span>
          </div>
          <textarea
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            autoFocus
            rows={3}
            placeholder={t('workspace.commentPlaceholder')}
            className="block w-full resize-none bg-transparent px-3 py-3 text-[13px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          <div className="flex justify-end gap-2 px-3 pb-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCommentRange(null)
                setCommentDraft('')
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={submitLineComment}
              disabled={!commentDraft.trim()}
            >
              {t('workspace.addCommentToChat')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const isCommentLineSelected = (lineNumber: number) => (
    commentLineStart !== null
    && commentLineEnd !== null
    && lineNumber >= commentLineStart
    && lineNumber <= commentLineEnd
  )

  const lineRowClassName = (lineNumber: number) => {
    // A comment selection is something the user just did by hand, so it outranks
    // the reveal mark left over from the reference they clicked to get here.
    if (isCommentLineSelected(lineNumber)) {
      return 'group grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-3 bg-[var(--color-info-container)]'
    }
    if (revealLine === lineNumber) {
      return 'group grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-3 bg-[var(--color-brand-soft)] shadow-[inset_2px_0_0_var(--color-brand)]'
    }
    return 'group grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-3 hover:bg-[var(--color-surface-hover)]'
  }

  const renderLineNumberButton = (lineNumber: number) => {
    const selected = isCommentLineSelected(lineNumber)
    return (
      <button
        type="button"
        aria-label={t('workspace.commentLine', { line: lineNumber })}
        aria-pressed={selected}
        onClick={(event) => {
          const extendRange = event.shiftKey && commentRange !== null
          setCommentRange(extendRange
            ? { ...commentRange, focusLine: lineNumber }
            : { anchorLine: lineNumber, focusLine: lineNumber })
          if (!extendRange) setCommentDraft('')
        }}
        className={`select-none text-right text-[11px] transition-colors focus-visible:outline-none ${
          selected
            ? 'font-semibold text-[var(--color-info)]'
            : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-brand)] focus-visible:text-[var(--color-brand)]'
        }`}
      >
        {lineNumber}
      </button>
    )
  }

  return (
    <div
      ref={surfaceRef}
      className="min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]"
      onMouseUp={handleSelectionMouseUp}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      <div className="relative min-w-max py-2">
        {usePlainLargePreview ? (
          <pre
            data-workspace-code=""
            data-testid="workspace-code"
            className="m-0 font-mono text-[12px] leading-[1.55]"
            style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
          >
            {visibleLines.map((line, index) => {
              const lineNumber = index + 1
              return (
                <div key={lineNumber}>
                  <div
                    className={lineRowClassName(lineNumber)}
                    data-workspace-line-number={lineNumber}
                  >
                    {renderLineNumberButton(lineNumber)}
                    <span className="whitespace-pre pr-6">{line || ' '}</span>
                  </div>
                  {renderLineCommentEditor(lineNumber)}
                </div>
              )
            })}
          </pre>
        ) : shikiTokensByLine ? (
          <pre
            data-workspace-code=""
            data-testid="workspace-code"
            data-highlight-engine="shiki"
            className="m-0 font-mono text-[12px] leading-[1.55]"
            style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
          >
            {shikiTokensByLine.map((line, index) => {
              const lineNumber = index + 1
              return (
                <div key={lineNumber}>
                  <div
                    data-workspace-line-number={lineNumber}
                    className={lineRowClassName(lineNumber)}
                  >
                    {renderLineNumberButton(lineNumber)}
                    <span className="whitespace-pre pr-6">
                      {line.length === 0 ? ' ' : line.map((token, tokenIndex) => (
                        <span
                          key={`${tokenIndex}:${token.content}`}
                          data-workspace-token=""
                          style={workspaceCodeTokenStyle(token)}
                        >
                          {token.content}
                        </span>
                      ))}
                    </span>
                  </div>
                  {renderLineCommentEditor(lineNumber)}
                </div>
              )
            })}
          </pre>
        ) : (
          <Highlight
            theme={workspacePrismTheme}
            code={visibleCode}
            language={normalizePrismLanguage(language)}
          >
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre
                data-workspace-code=""
                data-testid="workspace-code"
                data-highlight-engine="prism"
                className="m-0 font-mono text-[12px] leading-[1.55]"
                style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
              >
                {tokens.map((line, index) => {
                  const { key: lineKey, ...lineProps } = getLineProps({ line, key: index })
                  const lineNumber = index + 1
                  return (
                    <div key={String(lineKey)}>
                      <div
                        {...lineProps}
                        data-workspace-line-number={lineNumber}
                        className={lineRowClassName(lineNumber)}
                      >
                        {renderLineNumberButton(lineNumber)}
                        <span className="whitespace-pre pr-6">
                          {line.length === 1 && line[0]?.empty ? ' ' : line.map((token, tokenIndex) => {
                            const { key: tokenKey, ...tokenProps } = getTokenProps({ token, key: tokenIndex })
                            return <span key={String(tokenKey)} {...tokenProps} />
                          })}
                        </span>
                      </div>
                      {renderLineCommentEditor(lineNumber)}
                    </div>
                  )
                })}
              </pre>
            )}
          </Highlight>
        )}
        {lines.length > WORKSPACE_PREVIEW_LINE_LIMIT && (
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-xs text-[var(--color-text-tertiary)] backdrop-blur">
            <span>
              {showAllLines
                ? t('workspace.previewAllLines', { total: lines.length })
                : t('workspace.previewLineLimit', { count: visibleLines.length, total: lines.length })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAllLines((current) => !current)}
              className="ml-auto"
            >
              {showAllLines ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </Button>
          </div>
        )}
      </div>
      <FloatingSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}

function MarkdownSurface({
  value,
  path,
  sessionId,
  workDir,
  onAddSelection,
}: {
  value: string
  path: string
  sessionId: string
  workDir?: string | null
  onAddSelection: (selection: WorkspaceTextSelection) => void
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const [selectionMenu, setSelectionMenu] = useState<FloatingSelectionMenuState | null>(null)

  // The document is user-owned local content, so its images are trusted:
  // relative paths resolve against the file's directory (served sandboxed via
  // /preview-fs or /local-file) and remote URLs are left to CSP. Untrusted
  // assistant Markdown gets no resolver and keeps the blob:/data:-only policy.
  const resolveImageSrc = useMemo(
    () => createWorkspaceMarkdownImageResolver({
      baseUrl: getServerBaseUrl(),
      sessionId,
      filePath: path,
      workDir,
    }),
    [path, sessionId, workDir],
  )

  useEffect(() => {
    setSelectionMenu(null)
  }, [value])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const handleSelectionMouseUp = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.ctrlKey) {
      setSelectionMenu(null)
      return
    }
    setSelectionMenu(getTextSelectionFromContainer(
      surfaceRef.current,
      (text) => getLineRangeForText(value, text),
      event,
    ))
  }

  const addCurrentSelectionToChat = () => {
    if (!selectionMenu) return
    onAddSelection({
      text: selectionMenu.text,
      startLine: selectionMenu.startLine,
      endLine: selectionMenu.endLine,
    })
    setSelectionMenu(null)
    clearWindowSelection()
  }

  return (
    <div
      ref={surfaceRef}
      className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]"
      onMouseUp={handleSelectionMouseUp}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <MarkdownRenderer
          content={value}
          variant="document"
          resolveImageSrc={resolveImageSrc}
          className="workspace-markdown-preview prose-p:text-[14px] prose-p:leading-7 prose-h1:text-[24px] prose-h2:text-[18px] prose-h3:text-[15px] prose-code:text-[12px] prose-pre:my-4"
        />
      </div>
      <FloatingSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}

function ImagePreview({ tab }: { tab: WorkspacePreviewTab }) {
  const t = useTranslation()

  if (!tab.dataUrl) {
    return (
      <PanelMessage
        icon="image_not_supported"
        message={tab.error || t('workspace.imagePreviewUnavailable')}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)] p-4">
      <div className="flex min-h-full items-center justify-center">
        <img
          src={tab.dataUrl}
          alt={tab.path}
          className="max-h-full max-w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] object-contain shadow-[var(--shadow-card)]"
        />
      </div>
    </div>
  )
}

function moveWorkspaceSearchResultFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  direction: 'next' | 'previous' | 'first' | 'last',
) {
  const list = event.currentTarget.closest('[data-workspace-search-results]')
  const results = list
    ? Array.from(list.querySelectorAll<HTMLButtonElement>('[data-workspace-search-result]'))
    : []
  if (results.length === 0) return

  const currentIndex = results.indexOf(event.currentTarget)
  const targetIndex = direction === 'first'
    ? 0
    : direction === 'last'
      ? results.length - 1
      : direction === 'next'
        ? Math.min(currentIndex + 1, results.length - 1)
        : Math.max(currentIndex - 1, 0)
  results[targetIndex]?.focus()
}

function WorkspaceSearchResultRow({
  entry,
  active,
  onOpen,
  onContextMenu,
  onClearSearch,
}: {
  entry: WorkspaceTreeEntry
  active: boolean
  onOpen: () => void
  onContextMenu: (event: ReactMouseEvent, path: string, isDirectory: boolean) => void
  onClearSearch: () => void
}) {
  const normalizedPath = entry.path.replace(/\\/g, '/')
  const lastSlash = normalizedPath.lastIndexOf('/')
  const parentPath = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '.'

  return (
    <div role="listitem">
      <button
        type="button"
        data-workspace-search-result=""
        data-workspace-file-path={entry.path}
        aria-current={active ? 'true' : undefined}
        aria-label={`${entry.name}, ${parentPath}`}
        title={normalizedPath}
        onClick={onOpen}
        onContextMenu={(event) => onContextMenu(event, entry.path, false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'next')
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'previous')
          } else if (event.key === 'Home') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'first')
          } else if (event.key === 'End') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'last')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClearSearch()
          }
        }}
        className={`group mx-2 flex min-h-12 w-[calc(100%-16px)] items-start gap-2 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-[background-color,transform] duration-150 ease-out active:scale-[0.99] ${
          active
            ? 'bg-[var(--color-info-container)] shadow-[inset_3px_0_0_var(--color-info)]'
            : 'hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <FileTypeBadge name={entry.name} subtle={!active} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--color-text-primary)]">
            {entry.name}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">
            {parentPath}
          </span>
        </span>
      </button>
    </div>
  )
}

function TreeNode({
  sessionId,
  entry,
  depth,
  expandedPaths,
  treeByPath,
  treeLoadingByPath,
  treeErrorsByPath,
  changedFilesByPath,
  filterQuery,
  onToggle,
  onOpenFile,
  onFileContextMenu,
  activePath,
  variant = 'tree',
}: TreeNodeProps) {
  const t = useTranslation()
  const childTree = treeByPath[entry.path]
  const childLoading = treeLoadingByPath[makeTreeStateKey(sessionId, entry.path)] ?? false
  const childError = treeErrorsByPath[makeTreeStateKey(sessionId, entry.path)] ?? null
  const isExpanded = expandedPaths.has(entry.path)
  const isVisuallyExpanded = isExpanded || filterQuery.length > 0
  const indent = 14 + depth * 20
  const changedFile = changedFilesByPath.get(normalizeWorkspacePathKey(entry.path))

  if (!entry.isDirectory) {
    const isActive = entry.path === activePath
    return (
      <button
        type="button"
        onClick={() => onOpenFile(entry.path)}
        onContextMenu={(event) => onFileContextMenu(event, entry.path, false)}
        aria-current={isActive ? 'true' : undefined}
        data-workspace-file-row=""
        data-workspace-file-path={entry.path}
        title={entry.path}
        className={`group mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-[var(--radius-md)] pr-2 text-left transition-colors ${
          changedFile?.oldPath ? 'min-h-11 py-1' : 'h-8'
        } ${
          isActive
            ? variant === 'changed'
              ? 'bg-[var(--color-info-container)] shadow-[inset_3px_0_0_var(--color-info)]'
              : 'bg-[var(--color-surface-selected)] shadow-[inset_0_0_0_1.5px_var(--color-border-focus)]'
            : 'hover:bg-[var(--color-surface-hover)]'
        }`}
        style={{ paddingLeft: indent }}
      >
        <FileTypeBadge name={entry.name} subtle={!isActive} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-[var(--color-text-primary)]">{entry.name}</span>
          {changedFile?.oldPath && (
            <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-tertiary)]">
              {changedFile.oldPath}
            </span>
          )}
        </span>
        {entry.isSymlink ? <Link2 size={12} aria-label="软链接" className="shrink-0 text-[var(--color-text-tertiary)]" /> : null}
        {changedFile ? (
          <>
            <span className="shrink-0 font-[var(--font-mono)] text-[10px]">
              <span className="text-[var(--color-success)]">+{changedFile.additions}</span>
              <span className="ml-1 text-[var(--color-error)]">-{changedFile.deletions}</span>
            </span>
            <FileStatusBadge status={changedFile.status} />
          </>
        ) : null}
      </button>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(entry.path)}
        onContextMenu={(event) => onFileContextMenu(event, entry.path, true)}
        aria-expanded={isVisuallyExpanded}
        className="group mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-[var(--radius-md)] pr-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ paddingLeft: indent }}
      >
        <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[18px] text-[var(--color-text-tertiary)] transition-colors group-hover:text-[var(--color-text-primary)]">
          {isVisuallyExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span className="min-w-0 truncate text-[15px] font-medium text-[var(--color-text-primary)]">{entry.name}</span>
        {entry.isSymlink ? <Link2 size={12} aria-label="软链接目录" className="shrink-0 text-[var(--color-text-tertiary)]" /> : null}
        {changedFile ? <FileStatusBadge status={changedFile.status} /> : null}
      </button>

      {isVisuallyExpanded && (
        <div className="relative">
          {depth < 4 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-1 top-1 w-px bg-[var(--color-border)]"
              style={{ left: 28 + depth * 20 }}
            />
          )}
          {childLoading && !childTree && (
            <PanelMessage
              compact
              icon="progress_activity"
              message={t('common.loading')}
            />
          )}

          {!childLoading && childError && (
            <PanelMessage compact icon="error" tone="error" message={childError} />
          )}

          {!childLoading && !childError && childTree?.state === 'missing' && (
            <PanelMessage compact icon="folder_off" message={t('workspace.previewState.missing')} />
          )}

          {!childLoading && !childError && childTree?.state === 'error' && (
            <PanelMessage
              compact
              icon="error"
              tone="error"
              message={childTree.error || t('workspace.loadError')}
            />
          )}

          {!childLoading && !childError && childTree?.state === 'ok' && childTree.entries.length === 0 && (
            <PanelMessage compact icon="folder_open" message={t('workspace.noFiles')} />
          )}

          {!childLoading && !childError && childTree?.state === 'ok' && childTree.entries
            .filter((childEntry) => treeEntryMatchesFilter(childEntry, filterQuery, treeByPath))
            .map((childEntry) => (
              <TreeNode
                key={childEntry.path}
                sessionId={sessionId}
                entry={childEntry}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                treeByPath={treeByPath}
                treeLoadingByPath={treeLoadingByPath}
                treeErrorsByPath={treeErrorsByPath}
                changedFilesByPath={changedFilesByPath}
                filterQuery={filterQuery}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onFileContextMenu={onFileContextMenu}
                activePath={activePath}
                variant={variant}
              />
            ))}
        </div>
      )}
    </div>
  )
}

export function WorkspacePanel({ sessionId, embedded = false, forceVisible = false, layout = 'standard' }: WorkspacePanelProps) {
  const t = useTranslation()
  const addToast = useUIStore((state) => state.addToast)
  const [filterQuery, setFilterQuery] = useState('')
  const [plainTextOnly, setPlainTextOnly] = useState(true)
  const [changedVersionFilter, setChangedVersionFilter] = useState<ChangedVersionFilter>('all')
  const [changedDirectoryOverrides, setChangedDirectoryOverrides] = useState<Set<string>>(() => new Set())
  const [workspaceSearch, setWorkspaceSearch] = useState<WorkspaceSearchResult | null>(null)
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false)
  const [workspaceSearchError, setWorkspaceSearchError] = useState<string | null>(null)
  const [workspaceSearchRevision, setWorkspaceSearchRevision] = useState(0)
  const [manualRefreshPending, setManualRefreshPending] = useState(false)
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false)
  const [navigatorWidth, setNavigatorWidth] = useState(readWorkspaceNavigatorWidth)
  // The navigator and preview are separate views so narrow workbench tabs do
  // not squeeze either the tree or the code surface.
  const [isNavigatorOpen, setIsNavigatorOpen] = useState(true)
  const [markdownSourceByTab, setMarkdownSourceByTab] = useState<Record<string, boolean>>({})
  const [tableSourceByTab, setTableSourceByTab] = useState<Record<string, boolean>>({})
  const isVscodeLayout = layout === 'vscode'
  const [previewTabContextMenu, setPreviewTabContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null)
  const [pendingDirtyAction, setPendingDirtyAction] = useState<WorkspacePendingDirtyAction | null>(null)
  const [comparisonSaving, setComparisonSaving] = useState(false)
  const [comparisonSaveError, setComparisonSaveError] = useState<string | null>(null)
  const [encodingChangingSide, setEncodingChangingSide] = useState<WorkspaceComparisonSourceSide | null>(null)
  const previewTabContextMenuRef = useRef<HTMLDivElement>(null)
  const fileContextMenuRef = useRef<HTMLDivElement>(null)
  const width = useWorkspacePanelStore((state) => state.width)
  const isOpen = useWorkspacePanelStore((state) => state.isPanelOpen(sessionId))
  const activeView = useWorkspacePanelStore((state) => state.getActiveView(sessionId))
  const status = useWorkspacePanelStore((state) => state.statusBySession[sessionId])
  const treeByPath = useWorkspacePanelStore((state) => state.treeBySessionPath[sessionId] ?? EMPTY_TREE_BY_PATH)
  const previewTabs = useWorkspacePanelStore((state) => state.previewTabsBySession[sessionId] ?? EMPTY_PREVIEW_TABS)
  const activePreviewTabId = useWorkspacePanelStore((state) => state.activePreviewTabIdBySession[sessionId] ?? null)
  const previewOpenNonce = useWorkspacePanelStore((state) => state.previewOpenNonceBySession?.[sessionId] ?? 0)
  const expandedPaths = useWorkspacePanelStore((state) => state.expandedPathsBySession[sessionId] ?? EMPTY_EXPANDED_PATHS)
  const statusLoading = useWorkspacePanelStore((state) => state.loading.statusBySession[sessionId] ?? false)
  const treeLoadingByPath = useWorkspacePanelStore(
    useShallow((state) => getSessionScopedRecord(state.loading.treeBySessionPath, sessionId)),
  )
  const statusError = useWorkspacePanelStore((state) => state.errors.statusBySession[sessionId] ?? null)
  const treeErrorsByPath = useWorkspacePanelStore(
    useShallow((state) => getSessionScopedRecord(state.errors.treeBySessionPath, sessionId)),
  )
  const mountedRoots = useWorkspacePanelStore((state) => state.mountedRoots)
  const setActiveView = useWorkspacePanelStore((state) => state.setActiveView)
  const loadStatus = useWorkspacePanelStore((state) => state.loadStatus)
  const loadTree = useWorkspacePanelStore((state) => state.loadTree)
  const toggleTreeNode = useWorkspacePanelStore((state) => state.toggleTreeNode)
  const openPreview = useWorkspacePanelStore((state) => state.openPreview)
  const preloadPreview = useWorkspacePanelStore((state) => state.preloadPreview)
  const closePreview = useWorkspacePanelStore((state) => state.closePreview)
  const closePreviewTabs = useWorkspacePanelStore((state) => state.closePreviewTabs)
  const activatePreview = useWorkspacePanelStore((state) => state.activatePreview)
  const setComparisonSession = useWorkspacePanelStore((state) => state.setComparisonSession)
  const closePanel = useWorkspacePanelStore((state) => state.closePanel)
  const addMountedRoot = useWorkspacePanelStore((state) => state.addMountedRoot)
  const removeMountedRoot = useWorkspacePanelStore((state) => state.removeMountedRoot)
  const addWorkspaceReference = useWorkspaceChatContextStore((state) => state.addReference)
  const chatState = useChatStore((state) => state.sessions[sessionId]?.chatState ?? 'idle')
  const shouldRender = forceVisible || isOpen
  const refreshLifecycleRef = useRef({
    sessionId,
    isOpen: false,
    chatState: 'idle',
  })
  const workspaceSearchRequestIdRef = useRef(0)
  const manualRefreshRequestIdRef = useRef(0)
  const manualRefreshInFlightRef = useRef(false)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const previewHeaderRef = useRef<HTMLDivElement>(null)
  const workspaceLayoutRef = useRef<HTMLDivElement>(null)
  const navigatorRef = useRef<HTMLDivElement>(null)
  const navigatorDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const navigatorWidthRef = useRef(navigatorWidth)
  navigatorWidthRef.current = navigatorWidth

  const rootTree = treeByPath['']
  const rootTreeKey = makeTreeStateKey(sessionId, '')
  const rootTreeLoading = treeLoadingByPath[rootTreeKey] ?? false
  const rootTreeError = treeErrorsByPath[rootTreeKey] ?? null
  const normalizedFilterQuery = normalizeFilterQuery(filterQuery)
  const activePreviewTab =
    previewTabs.find((tab) => tab.id === activePreviewTabId) ?? previewTabs[previewTabs.length - 1] ?? null
  const activeMarkdownView = activePreviewTab && isMarkdownPreview(activePreviewTab)
    ? (markdownSourceByTab[activePreviewTab.id] ? 'source' : 'preview')
    : null
  const activeTableView = activePreviewTab && isTablePreview(activePreviewTab)
    ? (tableSourceByTab[activePreviewTab.id] ? 'source' : 'preview')
    : null
  const hasPreviewTabs = previewTabs.length > 0
  const isNavigatorVisible = isNavigatorOpen
  const activePreviewIsWorkspaceComparison = activePreviewTab?.kind === 'diff'
    && activePreviewTab.diffSource?.kind !== 'turn'
  const isWorkspaceComparisonVisible = !isNavigatorVisible && activePreviewIsWorkspaceComparison
  const navigatorView = activeView
  const hasWorkspaceSearch = navigatorView === 'all' && normalizedFilterQuery.length > 0
  const activeWorkspaceSearch = workspaceSearch
    && normalizeFilterQuery(workspaceSearch.query) === normalizedFilterQuery
    ? workspaceSearch
    : null
  const displayedWorkspaceSearch = activeWorkspaceSearch ?? workspaceSearch
  const expandedPathSet = new Set(expandedPaths)
  const activeTreePath = activePreviewTab?.path ?? null
  const activeChangedFile = activePreviewTab
    ? status?.changedFiles.find((file) => file.path === activePreviewTab.path) ?? null
    : null
  const workspaceComparisonPath = activeChangedFile && !activeChangedFile.isDirectory
    ? activePreviewTab?.path
    : status?.changedFiles.find((file) => !file.isDirectory)?.path
  const filteredChangedFiles = useMemo(() => {
    const allChangedFiles = status?.changedFiles ?? []
    const matchingFiles = allChangedFiles.filter((file) => (
      !file.isDirectory
      && changedFileMatchesFilter(file, normalizedFilterQuery)
      && changedFileMatchesVersionFilter(file, changedVersionFilter)
      && (!plainTextOnly || isLikelyPlaintextChangedFile(file))
    ))
    const matchingDirectories = allChangedFiles.filter((file) => {
      if (!file.isDirectory) return false
      const prefix = `${normalizeWorkspacePathKey(file.path)}/`
      const hasMatchingDescendant = matchingFiles.some((candidate) => (
        normalizeWorkspacePathKey(candidate.path).startsWith(prefix)
      ))
      if (hasMatchingDescendant) return true
      return !plainTextOnly
        && changedFileMatchesFilter(file, normalizedFilterQuery)
        && changedFileMatchesVersionFilter(file, changedVersionFilter)
    })
    return [...matchingDirectories, ...matchingFiles]
      .sort((left, right) => left.path.localeCompare(right.path))
  }, [changedVersionFilter, normalizedFilterQuery, plainTextOnly, status?.changedFiles])
  const changedFilesByPath = useMemo(
    () => new Map((status?.changedFiles ?? []).map((file) => [normalizeWorkspacePathKey(file.path), file])),
    [status?.changedFiles],
  )
  const visibleChangedFilesByPath = useMemo(
    () => new Map(filteredChangedFiles
      .filter((file) => (
        changedFileMatchesFilter(file, normalizedFilterQuery)
        && changedFileMatchesVersionFilter(file, changedVersionFilter)
      ))
      .map((file) => [normalizeWorkspacePathKey(file.path), file])),
    [changedVersionFilter, filteredChangedFiles, normalizedFilterQuery],
  )
  const changedTreeByPath = useMemo(
    () => buildChangedTree(filteredChangedFiles),
    [filteredChangedFiles],
  )
  const changedLinkedRootPaths = useMemo(
    () => (status?.changedFiles ?? [])
      .filter((file) => file.isDirectory && file.isSymlink)
      .map((file) => normalizeWorkspacePathKey(file.path)),
    [status?.changedFiles],
  )
  const changedExpandedPathSet = useMemo(() => {
    const expanded = new Set<string>()
    for (const [parentPath, tree] of Object.entries(changedTreeByPath)) {
      if (!parentPath || tree?.state !== 'ok' || tree.entries.length === 0) continue
      const normalizedParentPath = normalizeWorkspacePathKey(parentPath)
      const isInsideLinkedRoot = changedLinkedRootPaths.some((rootPath) => (
        normalizedParentPath === rootPath || normalizedParentPath.startsWith(`${rootPath}/`)
      ))
      const defaultExpanded = !isInsideLinkedRoot
      const overridden = changedDirectoryOverrides.has(parentPath)
      if (defaultExpanded !== overridden) expanded.add(parentPath)
    }
    return expanded
  }, [changedDirectoryOverrides, changedLinkedRootPaths, changedTreeByPath])
  const filteredRootEntries = useMemo(
    () => rootTree?.state === 'ok'
      ? rootTree.entries.filter((entry) => treeEntryMatchesFilter(entry, normalizedFilterQuery, treeByPath))
      : [],
    [normalizedFilterQuery, rootTree, treeByPath],
  )
  const visibleEntryCount = filteredChangedFiles.filter((file) => !file.isDirectory).length
  const totalEntryCount = status?.changedFiles.filter((file) => !file.isDirectory).length ?? 0
  const filterSummary = navigatorView === 'changed'
    ? normalizedFilterQuery
      ? t('workspace.filteredFilesCount', { visible: visibleEntryCount, total: totalEntryCount })
      : t('workspace.filesCount', { count: totalEntryCount })
    : !normalizedFilterQuery || workspaceSearchError
      ? undefined
      : workspaceSearchLoading || !activeWorkspaceSearch
        ? t('workspace.searching')
        : activeWorkspaceSearch.truncated
          ? t('workspace.searchResultsTruncated', { count: activeWorkspaceSearch.entries.length })
          : t('workspace.searchResultsCount', { count: activeWorkspaceSearch.entries.length })
  const activePreviewRequestKey = activePreviewTab
    ? makePreviewStateKey(sessionId, activePreviewTab.id)
    : null
  const activePreviewLoading = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.loading.previewByTabId[activePreviewRequestKey] ?? false : false,
  )
  const activePreviewError = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.errors.previewByTabId[activePreviewRequestKey] ?? null : null,
  )
  const activePreviewRefreshState = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.errors.previewRefreshStateByTabId[activePreviewRequestKey] ?? null : null,
  )
  const workspaceRefreshLoading = manualRefreshPending || statusLoading || activePreviewLoading

  useEffect(() => {
    manualRefreshRequestIdRef.current += 1
    manualRefreshInFlightRef.current = false
    setManualRefreshPending(false)
  }, [sessionId])

  useEffect(() => {
    const previous = refreshLifecycleRef.current
    const sessionChanged = previous.sessionId !== sessionId
    const opened = shouldRender && (sessionChanged || !previous.isOpen)
    const completedTurn =
      shouldRender &&
      !sessionChanged &&
      previous.chatState !== 'idle' &&
      chatState === 'idle'

    refreshLifecycleRef.current = { sessionId, isOpen: shouldRender, chatState }

    const shouldRefreshOnOpen = opened
    const shouldRefreshAfterCompletedTurn = completedTurn && chatState === 'idle'
    if ((!shouldRefreshOnOpen && !shouldRefreshAfterCompletedTurn) || statusLoading) return
    void loadStatus(sessionId, { force: shouldRefreshAfterCompletedTurn })
  }, [chatState, loadStatus, sessionId, shouldRender, statusLoading])

  useEffect(() => {
    if (!shouldRender || !isNavigatorVisible || navigatorView !== 'all' || rootTree || rootTreeLoading || rootTreeError) return
    void loadTree(sessionId, '')
  }, [isNavigatorVisible, loadTree, navigatorView, rootTree, rootTreeError, rootTreeLoading, sessionId, shouldRender])

  useEffect(() => {
    // Only speculate for the file the user is already looking at. Falling back
    // to changedFiles[0] here can pick an arbitrary generated/untracked file in
    // very large workspaces and start an expensive SVN diff on panel open.
    if (
      !shouldRender
      || !workspaceComparisonPath
      || !activeChangedFile
      || activeChangedFile.isDirectory
      || activePreviewIsWorkspaceComparison
    ) return
    const path = workspaceComparisonPath
    const samePathTab = activePreviewTab?.path === path ? activePreviewTab : null
    const timer = window.setTimeout(() => {
      void preloadPreview(
        sessionId,
        path,
        'diff',
        { kind: 'workspace' },
        samePathTab?.textEncoding,
        samePathTab?.comparisonEncodings,
      ).catch(() => {
        // Speculative loading is intentionally silent; opening owns feedback.
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    activePreviewIsWorkspaceComparison,
    activePreviewTab,
    activeChangedFile,
    preloadPreview,
    sessionId,
    shouldRender,
    workspaceComparisonPath,
  ])

  useEffect(() => {
    if (!shouldRender || navigatorView !== 'all') return
    for (const root of mountedRoots) {
      void sessionsApi.registerWorkspaceRoot(sessionId, root.path)
        .then(() => loadTree(sessionId, root.path))
        .catch(() => {
          // Keep the persisted root visible: it may be a temporarily missing
          // network drive and the tree row will show its existing load state.
        })
    }
  }, [loadTree, mountedRoots, navigatorView, sessionId, shouldRender])

  useEffect(() => {
    const requestId = workspaceSearchRequestIdRef.current + 1
    workspaceSearchRequestIdRef.current = requestId

    if (!shouldRender || navigatorView !== 'all' || !normalizedFilterQuery) {
      if (!normalizedFilterQuery) setWorkspaceSearch(null)
      setWorkspaceSearchLoading(false)
      setWorkspaceSearchError(null)
      return
    }

    setWorkspaceSearchLoading(true)
    setWorkspaceSearchError(null)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void sessionsApi.searchWorkspace(sessionId, filterQuery.trim()).then((result) => {
        if (cancelled || workspaceSearchRequestIdRef.current !== requestId) return
        setWorkspaceSearch(result)
        setWorkspaceSearchLoading(false)
      }).catch((error) => {
        if (cancelled || workspaceSearchRequestIdRef.current !== requestId) return
        setWorkspaceSearchLoading(false)
        setWorkspaceSearchError(error instanceof Error ? error.message : t('workspace.loadError'))
      })
    }, WORKSPACE_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [filterQuery, navigatorView, normalizedFilterQuery, sessionId, shouldRender, t, workspaceSearchRevision])

  const closeContextMenus = useCallback(() => {
    setPreviewTabContextMenu(null)
    setFileContextMenu(null)
  }, [])

  // Both menus already stopped propagation on their own container, so treating
  // them as "inside" reproduces the previous behavior (a copy-path click leaves
  // the menu open) without a hand-rolled document listener.
  useDismissable({
    open: previewTabContextMenu !== null || fileContextMenu !== null,
    refs: [previewTabContextMenuRef, fileContextMenuRef],
    onDismiss: closeContextMenus,
  })

  useEffect(() => {
    if (!isNavigatorVisible) {
      setIsViewMenuOpen(false)
    }
  }, [isNavigatorVisible])

  // `openPreview` can be initiated from a chat change card, where the navigator
  // is not involved. Always land on "查看文件" when that happens instead of
  // leaving the user on the visually unrelated file-tree tab.
  useEffect(() => {
    if (shouldRender && previewOpenNonce > 0 && !isVscodeLayout) setIsNavigatorOpen(false)
  }, [isVscodeLayout, previewOpenNonce, shouldRender])

  const getNavigatorMaximumWidth = useCallback(() => {
    const layoutWidth = workspaceLayoutRef.current?.getBoundingClientRect().width ?? 0
    if (layoutWidth <= 0) return WORKSPACE_NAVIGATOR_MAX_WIDTH
    return Math.max(WORKSPACE_NAVIGATOR_MIN_WIDTH, layoutWidth - WORKSPACE_PREVIEW_MIN_WIDTH)
  }, [])

  const handleNavigatorResizeMove = useCallback((event: globalThis.MouseEvent) => {
    const drag = navigatorDragRef.current
    if (!drag) return
    const nextWidth = clampWorkspaceNavigatorWidth(
      drag.startWidth + event.clientX - drag.startX,
      getNavigatorMaximumWidth(),
    )
    navigatorWidthRef.current = nextWidth
    setNavigatorWidth(nextWidth)
  }, [getNavigatorMaximumWidth])

  const handleNavigatorResizeEnd = useCallback(() => {
    if (!navigatorDragRef.current) return
    navigatorDragRef.current = null
    persistWorkspaceNavigatorWidth(navigatorWidthRef.current)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    window.removeEventListener('mousemove', handleNavigatorResizeMove)
    window.removeEventListener('mouseup', handleNavigatorResizeEnd)
  }, [handleNavigatorResizeMove])

  const handleNavigatorResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const measuredWidth = navigatorRef.current?.getBoundingClientRect().width ?? 0
    navigatorDragRef.current = {
      startX: event.clientX,
      startWidth: measuredWidth > 0 ? measuredWidth : navigatorWidthRef.current,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleNavigatorResizeMove)
    window.addEventListener('mouseup', handleNavigatorResizeEnd)
  }, [handleNavigatorResizeEnd, handleNavigatorResizeMove])

  const resetNavigatorWidth = useCallback(() => {
    const nextWidth = clampWorkspaceNavigatorWidth(WORKSPACE_NAVIGATOR_DEFAULT_WIDTH, getNavigatorMaximumWidth())
    navigatorWidthRef.current = nextWidth
    setNavigatorWidth(nextWidth)
    persistWorkspaceNavigatorWidth(nextWidth)
  }, [getNavigatorMaximumWidth])

  const handleNavigatorResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = navigatorWidthRef.current - 16
    if (event.key === 'ArrowRight') nextWidth = navigatorWidthRef.current + 16
    if (event.key === 'Home') nextWidth = WORKSPACE_NAVIGATOR_MIN_WIDTH
    if (event.key === 'End') nextWidth = getNavigatorMaximumWidth()
    if (nextWidth === null) return
    event.preventDefault()
    const clampedWidth = clampWorkspaceNavigatorWidth(nextWidth, getNavigatorMaximumWidth())
    navigatorWidthRef.current = clampedWidth
    setNavigatorWidth(clampedWidth)
    persistWorkspaceNavigatorWidth(clampedWidth)
  }, [getNavigatorMaximumWidth])

  useEffect(() => () => {
    window.removeEventListener('mousemove', handleNavigatorResizeMove)
    window.removeEventListener('mouseup', handleNavigatorResizeEnd)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
  }, [handleNavigatorResizeEnd, handleNavigatorResizeMove])

  if (!shouldRender) return null

  const panelWidth = hasPreviewTabs ? width : Math.min(width, 520)
  const panelMaxWidth = hasPreviewTabs ? 'min(62%, calc(100% - 328px))' : '36%'
  const panelMinWidth = hasPreviewTabs ? 'min(420px, 54%)' : 'min(340px, 40%)'

  const findTabs = (tabIds: string[]) => previewTabs.filter((tab) => tabIds.includes(tab.id))

  const saveComparisonTabs = async (tabs: WorkspacePreviewTab[]) => {
    setComparisonSaving(true)
    setComparisonSaveError(null)
    try {
      for (const requestedTab of tabs) {
        const liveTab = useWorkspacePanelStore.getState().previewTabsBySession[sessionId]
          ?.find((tab) => tab.id === requestedTab.id)
        if (!liveTab?.comparisonSession || !isWorkspaceComparisonSessionDirty(liveTab.comparisonSession)) continue
        const outcome = await saveWorkspaceComparisonSession(liveTab.comparisonSession, (request) => (
          sessionsApi.writeWorkspaceFile(sessionId, request)
        ))
        setComparisonSession(sessionId, liveTab.id, outcome.session)
        if (outcome.state !== 'ok') {
          setComparisonSaveError(outcome.state === 'conflict'
            ? t('workspace.diffEdit.saveConflict')
            : t('workspace.diffEdit.saveFailed', { reason: outcome.error ?? outcome.state }))
          return false
        }
      }
      return true
    } finally {
      setComparisonSaving(false)
    }
  }

  const requestDirtyAction = (
    kind: WorkspaceDirtyActionKind,
    tabs: WorkspacePreviewTab[],
    proceed: () => void | Promise<void>,
  ) => {
    const dirtyTabs = tabs.filter((tab) => isWorkspaceComparisonSessionDirty(tab.comparisonSession))
    if (dirtyTabs.length === 0) {
      void proceed()
      return
    }
    setComparisonSaveError(null)
    setPendingDirtyAction({ kind, tabIds: dirtyTabs.map((tab) => tab.id), proceed })
  }

  const performRefresh = async () => {
    if (manualRefreshInFlightRef.current) return
    manualRefreshInFlightRef.current = true
    const requestId = ++manualRefreshRequestIdRef.current
    setManualRefreshPending(true)
    const requests: Promise<unknown>[] = [loadStatus(sessionId, { force: true })]
    if (activePreviewTab) {
      requests.push(openPreview(
        sessionId,
        activePreviewTab.path,
        activePreviewTab.kind,
        undefined,
        undefined,
        activePreviewTab.diffSource,
        activePreviewTab.textEncoding,
        activePreviewTab.comparisonEncodings,
        { force: true },
      ))
    }
    if (hasWorkspaceSearch) {
      setWorkspaceSearchRevision((revision) => revision + 1)
    } else if (navigatorView === 'all') {
      const pathsToRefresh = new Set(['', ...expandedPaths, ...mountedRoots.map((root) => root.path)])
      for (const path of pathsToRefresh) requests.push(loadTree(sessionId, path))
    }
    await Promise.allSettled(requests)
    if (manualRefreshRequestIdRef.current === requestId) {
      manualRefreshInFlightRef.current = false
      setManualRefreshPending(false)
    }
  }

  const handleRefresh = () => {
    requestDirtyAction('refresh', activePreviewTab ? [activePreviewTab] : [], performRefresh)
  }

  const handleComparisonEncodingChange = (
    sourceSide: WorkspaceComparisonSourceSide,
    encoding: WorkspaceTextEncoding,
  ) => {
    if (!activePreviewTab?.comparisonSession || activePreviewTab.kind !== 'diff') return
    if (activePreviewTab.comparisonSession[sourceSide].requestedEncoding === encoding) return
    const comparisonEncodings = {
      left: activePreviewTab.comparisonSession.left.requestedEncoding,
      right: activePreviewTab.comparisonSession.right.requestedEncoding,
      [sourceSide]: encoding,
    }
    const proceed = async () => {
      setEncodingChangingSide(sourceSide)
      try {
        await openPreview(
          sessionId,
          activePreviewTab.path,
          activePreviewTab.kind,
          undefined,
          undefined,
          activePreviewTab.diffSource,
          activePreviewTab.textEncoding,
          comparisonEncodings,
        )
      } finally {
        setEncodingChangingSide(null)
      }
    }
    requestDirtyAction('switch', [activePreviewTab], proceed)
  }

  const handleAddWorkspaceFolder = async () => {
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) {
      addToast({ type: 'error', message: '仅桌面版可以选择额外文件夹。' })
      return
    }
    try {
      const selected = await host.dialogs.open({
        directory: true,
        multiple: false,
        title: '加入文件视图',
      })
      if (typeof selected !== 'string' || !selected.trim()) return
      const root = await sessionsApi.registerWorkspaceRoot(sessionId, selected)
      addMountedRoot(root.path)
      await loadTree(sessionId, root.path)
    } catch (error) {
      addToast({ type: 'error', message: error instanceof Error ? error.message : t('workspace.addFolderFailed') })
    }
  }

  const focusPreviewAfterOpen = () => {
    window.setTimeout(() => previewHeaderRef.current?.focus(), 0)
  }

  const handleOpenFile = (path: string) => {
    const proceed = () => {
      if (!isVscodeLayout) setIsNavigatorOpen(false)
      void openPreview(sessionId, path, 'file')
      if (isHtmlFilePath(path)) {
        // HTML has a source tab in this workspace already, but its default view
        // must be the native browser surface. Unlike a renderer iframe, the
        // Electron WebContentsView is the proven path for local HTML, remote
        // pages, and their page-level scripts/styles. The workbench's 文件 tab
        // remains the explicit source-mode switch for this same loaded file.
        const absolutePath = status?.workDir && !/^(?:[A-Za-z]:[\\/]|\/)/.test(path)
          ? `${status.workDir.replace(/[\\/]+$/, '')}/${path.replace(/^[/\\]+/, '')}`
          : path
        openPreviewLink(absolutePath, sessionId)
      }
      focusPreviewAfterOpen()
    }
    requestDirtyAction('switch', activePreviewTab ? [activePreviewTab] : [], proceed)
  }

  const handleShowFileView = () => {
    if (!activePreviewTab || activePreviewTab.kind !== 'diff' || activePreviewTab.diffSource?.kind === 'turn') {
      setIsNavigatorOpen(false)
      return
    }

    const tab = activePreviewTab
    requestDirtyAction('switch', [tab], () => {
      setIsNavigatorOpen(false)
      const fileTabId = getWorkspacePreviewTabId(tab.path, 'file')
      if (previewTabs.some((candidate) => candidate.id === fileTabId)) {
        activatePreview(sessionId, fileTabId)
      } else {
        void openPreview(sessionId, tab.path, 'file', undefined, tab.reveal, { kind: 'workspace' }, tab.textEncoding)
      }
      focusPreviewAfterOpen()
    })
  }

  const handleShowWorkspaceComparison = () => {
    if (activePreviewIsWorkspaceComparison) {
      setIsNavigatorOpen(false)
      focusPreviewAfterOpen()
      return
    }

    const path = workspaceComparisonPath
    if (!path) return

    const proceed = () => {
      setIsNavigatorOpen(false)
      void openPreview(
        sessionId,
        path,
        'diff',
        undefined,
        activePreviewTab?.reveal,
        { kind: 'workspace' },
        activePreviewTab?.textEncoding,
      )
      focusPreviewAfterOpen()
    }
    requestDirtyAction('switch', activePreviewTab ? [activePreviewTab] : [], proceed)
  }

  const preloadWorkspaceComparison = () => {
    const path = workspaceComparisonPath
    if (!path || activePreviewIsWorkspaceComparison) return
    const samePathTab = activePreviewTab?.path === path ? activePreviewTab : null
    void preloadPreview(
      sessionId,
      path,
      'diff',
      { kind: 'workspace' },
      samePathTab?.textEncoding,
      samePathTab?.comparisonEncodings,
    ).catch(() => {
      // This is speculative. The real open owns the visible loading/error state.
    })
  }

  const handleTogglePreviewKind = () => {
    if (!activePreviewTab) return
    const tab = activePreviewTab
    requestDirtyAction('switch', [tab], () => {
      const previousTabId = tab.id
      const nextKind: WorkspacePreviewKind = tab.kind === 'file' ? 'diff' : 'file'
      const diffSource = tab.diffSource ?? { kind: 'workspace' as const }
      const nextTabId = getWorkspacePreviewTabId(tab.path, nextKind, diffSource)
      void openPreview(
        sessionId,
        tab.path,
        nextKind,
        undefined,
        tab.reveal,
        diffSource,
        tab.textEncoding,
      )
      if (nextTabId !== previousTabId) closePreview(sessionId, previousTabId)
    })
  }

  const clearWorkspaceSearch = () => {
    setFilterQuery('')
    window.requestAnimationFrame(() => filterInputRef.current?.focus())
  }

  const focusFirstSearchResult = () => {
    document.querySelector<HTMLButtonElement>(
      `[data-testid="workspace-panel"] [data-workspace-search-result]`,
    )?.focus()
  }

  const addWorkspacePathToChat = (path: string, isDirectory = false) => {
    addWorkspaceReference(sessionId, {
      kind: 'file',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: getWorkspaceReferenceName(path, isDirectory),
      isDirectory,
    })
  }

  const addLineCommentToChat = (
    path: string,
    lineStart: number,
    lineEnd: number,
    note: string,
    quote: string,
  ) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-comment',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart,
      lineEnd,
      note,
      quote,
    })
  }

  const addDiffCommentToChat = (
    path: string,
    selection: WorkspaceDiffCommentSelection,
    note: string,
  ) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-comment',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart: selection.lineStart,
      lineEnd: selection.lineEnd,
      diffSide: selection.side,
      hunkId: selection.hunkId,
      note,
      quote: selection.quote,
    })
    requestAnimationFrame(() => {
      const composer = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="chat-input-shell"]'),
      ).find((element) => element.dataset.sessionId === sessionId)
      composer?.querySelector<HTMLElement>('[data-composer-editor]')?.focus()
    })
  }

  const addSelectionToChat = (path: string, selection: WorkspaceTextSelection) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-selection',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart: selection.startLine,
      lineEnd: selection.endLine,
      quote: selection.text,
    })
  }

  const handleSetActiveView = (view: 'changed' | 'all') => {
    setActiveView(sessionId, view)
    setIsViewMenuOpen(false)
  }

  const handlePreviewTabContextMenu = (event: ReactMouseEvent, tabId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setFileContextMenu(null)
    setPreviewTabContextMenu({ tabId, x: event.clientX, y: event.clientY })
  }

  const handleFileContextMenu = (event: ReactMouseEvent, path: string, isDirectory = false) => {
    event.preventDefault()
    event.stopPropagation()
    setPreviewTabContextMenu(null)
    setFileContextMenu({ path, isDirectory, x: event.clientX, y: event.clientY })
  }

  const tabsClosedByScope = (tabId: string, scope: WorkspacePreviewCloseScope) => {
    const index = previewTabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return []
    if (scope === 'all') return previewTabs
    if (scope === 'others') return previewTabs.filter((_, candidateIndex) => candidateIndex !== index)
    if (scope === 'left') return previewTabs.slice(0, index)
    if (scope === 'right') return previewTabs.slice(index + 1)
    return [previewTabs[index]!]
  }

  const requestClosePreviewTabs = (tabId: string, scope: WorkspacePreviewCloseScope) => {
    const closingTabs = tabsClosedByScope(tabId, scope)
    requestDirtyAction('close', closingTabs, () => closePreviewTabs(sessionId, tabId, scope))
  }

  const handleClosePreviewTabs = (scope: WorkspacePreviewCloseScope) => {
    if (!previewTabContextMenu) return
    requestClosePreviewTabs(previewTabContextMenu.tabId, scope)
    setPreviewTabContextMenu(null)
  }

  const copyWorkspacePath = async (path: string, mode: 'relative' | 'absolute' = 'relative') => {
    const pathToCopy = mode === 'absolute' ? resolveWorkspaceAttachmentPath(status?.workDir, path) : path
    const copied = await copyTextToClipboard(pathToCopy)
    setFileContextMenu(null)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('workspace.pathCopied') : t('common.copyFailed'),
    })
  }

  const renderChangedView = () => {
    if (statusLoading && !status) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (status?.state === 'missing_workdir') {
      return <PanelMessage icon="folder_off" message={t('workspace.missingWorkdir')} />
    }

    if (status?.state === 'not_git_repo') {
      return <PanelMessage icon="account_tree" message={t('workspace.notGitRepo')} />
    }

    if (statusError || status?.state === 'error') {
      return (
        <PanelMessage
          icon="error"
          tone="error"
          message={statusError || status?.error || t('workspace.loadError')}
        />
      )
    }

    if (!status) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (status.changedFiles.length === 0) {
      return <PanelMessage icon="check_circle" message={t('workspace.noChanges')} />
    }

    if (filteredChangedFiles.length === 0) {
      return <PanelMessage icon="search_off" message={t('workspace.noMatchingFiles')} />
    }

    const rootEntries = changedTreeByPath['']?.state === 'ok'
      ? changedTreeByPath[''].entries
      : []

    return (
      <div className="space-y-1">
        {rootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            sessionId={sessionId}
            entry={entry}
            depth={0}
            expandedPaths={changedExpandedPathSet}
            treeByPath={changedTreeByPath}
            treeLoadingByPath={{}}
            treeErrorsByPath={{}}
            changedFilesByPath={visibleChangedFilesByPath}
            filterQuery=""
            onToggle={(path) => setChangedDirectoryOverrides((current) => {
              const next = new Set(current)
              if (next.has(path)) next.delete(path)
              else next.add(path)
              return next
            })}
            onOpenFile={handleOpenFile}
            onFileContextMenu={handleFileContextMenu}
            activePath={activeTreePath}
            variant="changed"
          />
        ))}
      </div>
    )
  }

  const renderAllFilesView = () => {
    if (hasWorkspaceSearch) {
      if (workspaceSearchLoading && !displayedWorkspaceSearch) {
        return <PanelMessage announce={false} icon="progress_activity" message={t('workspace.searching')} />
      }
      if (workspaceSearchError && !displayedWorkspaceSearch) {
        return (
          <div role="alert" className="mx-3 my-3 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-3 text-[12px] text-[var(--color-on-error-container)]">
            <div className="flex items-start gap-2">
              <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 leading-5">{workspaceSearchError}</span>
            </div>
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => setWorkspaceSearchRevision((revision) => revision + 1)}
              className="mt-2"
            >
              {t('common.retry')}
            </Button>
          </div>
        )
      }
      if (!displayedWorkspaceSearch) {
        return <PanelMessage announce={false} icon="progress_activity" message={t('workspace.searching')} />
      }
      if (!workspaceSearchLoading && activeWorkspaceSearch?.entries.length === 0) {
        return <PanelMessage announce={false} icon="search_off" message={t('workspace.noMatchingFiles')} />
      }

      return (
        <div
          role="list"
          aria-label={t('workspace.searchResults')}
          aria-busy={workspaceSearchLoading}
          data-workspace-search-results=""
          className="space-y-0.5 py-1"
        >
          {workspaceSearchError && (
            <div role="alert" className="mx-3 mb-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-2.5 py-2 text-[11px] text-[var(--color-on-error-container)]">
              <CircleAlert size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{workspaceSearchError}</span>
              <Button
                variant="danger-outline"
                size="xs"
                onClick={() => setWorkspaceSearchRevision((revision) => revision + 1)}
                className="shrink-0"
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {displayedWorkspaceSearch.entries.map((entry) => (
            <WorkspaceSearchResultRow
              key={entry.path}
              entry={entry}
              active={activeTreePath === entry.path}
              onOpen={() => handleOpenFile(entry.path)}
              onContextMenu={handleFileContextMenu}
              onClearSearch={clearWorkspaceSearch}
            />
          ))}
        </div>
      )
    }

    if (rootTreeLoading && !rootTree) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (rootTreeError) {
      return <PanelMessage icon="error" tone="error" message={rootTreeError} />
    }

    if (rootTree?.state === 'missing') {
      return <PanelMessage icon="folder_off" message={t('workspace.missingWorkdir')} />
    }

    if (rootTree?.state === 'error') {
      return <PanelMessage icon="error" tone="error" message={rootTree.error || t('workspace.loadError')} />
    }

    if (!rootTree) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (rootTree.entries.length === 0 && mountedRoots.length === 0) {
      return <PanelMessage icon="folder_open" message={t('workspace.noFiles')} />
    }

    if (filteredRootEntries.length === 0 && mountedRoots.length === 0) {
      return <PanelMessage icon="search_off" message={t('workspace.noMatchingFiles')} />
    }

    return (
      <div className="py-1">
        {filteredRootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            sessionId={sessionId}
            entry={entry}
            depth={0}
            expandedPaths={expandedPathSet}
            treeByPath={treeByPath}
            treeLoadingByPath={treeLoadingByPath}
            treeErrorsByPath={treeErrorsByPath}
            changedFilesByPath={changedFilesByPath}
            filterQuery={normalizedFilterQuery}
            onToggle={(path) => void toggleTreeNode(sessionId, path)}
            onOpenFile={handleOpenFile}
            onFileContextMenu={handleFileContextMenu}
            activePath={activeTreePath}
          />
        ))}
        {mountedRoots.map((root) => {
          const tree = treeByPath[root.path]
          const isLoading = treeLoadingByPath[makeTreeStateKey(sessionId, root.path)] ?? false
          const error = treeErrorsByPath[makeTreeStateKey(sessionId, root.path)] ?? null
          const entries = tree?.state === 'ok'
            ? tree.entries.filter((entry) => treeEntryMatchesFilter(entry, normalizedFilterQuery, treeByPath))
            : []
          return (
            <section key={root.path} className="mt-2 border-t border-[var(--color-border)] pt-1.5">
              <div className="group flex min-h-8 items-center gap-1.5 px-3 text-[11px] font-medium text-[var(--color-text-secondary)]" title={root.path}>
                <FolderOpen size={14} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{root.label}</span>
                <button
                  type="button"
                  aria-label={t('workspace.removeMountedFolder', { label: root.label })}
                  onClick={() => removeMountedRoot(root.path)}
                  className="hidden rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] group-hover:inline-flex"
                >
                  <X size={13} />
                </button>
              </div>
              {isLoading && !tree ? <PanelMessage compact icon="progress_activity" message={t('common.loading')} /> : null}
              {error ? <PanelMessage compact icon="error" tone="error" message={error} /> : null}
              {!isLoading && !error && tree?.state === 'missing' ? <PanelMessage compact icon="folder_off" message="文件夹不可用" /> : null}
              {!isLoading && !error && tree?.state === 'error' ? <PanelMessage compact icon="error" tone="error" message={tree.error || t('workspace.loadError')} /> : null}
              {!isLoading && !error && tree?.state === 'ok' && entries.map((entry) => (
                <TreeNode
                  key={entry.path}
                  sessionId={sessionId}
                  entry={entry}
                  depth={0}
                  expandedPaths={expandedPathSet}
                  treeByPath={treeByPath}
                  treeLoadingByPath={treeLoadingByPath}
                  treeErrorsByPath={treeErrorsByPath}
                  changedFilesByPath={changedFilesByPath}
                  filterQuery={normalizedFilterQuery}
                  onToggle={(path) => void toggleTreeNode(sessionId, path)}
                  onOpenFile={handleOpenFile}
                  onFileContextMenu={handleFileContextMenu}
                  activePath={activeTreePath}
                />
              ))}
            </section>
          )
        })}
      </div>
    )
  }

  const renderPreviewContent = () => {
    if (!activePreviewTab) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-[var(--color-text-tertiary)]">
          {t('workspace.previewEmpty')}
        </div>
      )
    }

    const state = activePreviewTab.state ?? 'loading'
    const refreshErrorMessage = activePreviewError
      || (activePreviewRefreshState ? getInlineStateMessage(t, activePreviewRefreshState) : null)

    return (
      <div
        data-testid="workspace-preview-content"
        aria-busy={activePreviewLoading}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={previewHeaderRef}
          tabIndex={-1}
          data-testid="workspace-preview-header"
          className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
        >
          <FileText size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="min-w-0 truncate font-mono font-medium text-[var(--color-text-primary)]">{activePreviewTab.path}</span>
          {activeChangedFile && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
              <span className="text-[var(--color-success)]">+{activeChangedFile.additions}</span>
              <span className="text-[var(--color-error)]">-{activeChangedFile.deletions}</span>
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {activePreviewTab.previewType !== 'image' && activePreviewTab.kind !== 'diff' && (
              <IconButton
                icon={activePreviewTab.kind === 'file'
                  ? <GitCompareArrows size={16} strokeWidth={1.9} aria-hidden="true" />
                  : <FileText size={16} strokeWidth={1.9} aria-hidden="true" />}
                label={activePreviewTab.kind === 'file'
                  ? t('workspace.openDiffView')
                  : t('workspace.openFileView')}
                onClick={handleTogglePreviewKind}
                size="md"
                tone="muted"
                showTooltip={false}
              />
            )}
            {activeMarkdownView && (
              <IconButton
                icon={activeMarkdownView === 'preview'
                  ? <Code2 size={16} strokeWidth={1.9} aria-hidden="true" />
                  : <Eye size={16} strokeWidth={1.9} aria-hidden="true" />}
                label={activeMarkdownView === 'preview'
                  ? t('workspace.openMarkdownSource')
                  : t('workspace.openMarkdownPreview')}
                onClick={() => setMarkdownSourceByTab((current) => ({
                  ...current,
                  [activePreviewTab.id]: activeMarkdownView === 'preview',
                }))}
                size="md"
                tone="muted"
                showTooltip={false}
              />
            )}
            {activeTableView && (
              <IconButton
                icon={activeTableView === 'preview'
                  ? <Code2 size={16} strokeWidth={1.9} aria-hidden="true" />
                  : <Eye size={16} strokeWidth={1.9} aria-hidden="true" />}
                label={activeTableView === 'preview'
                  ? t('workspace.openTableSource')
                  : t('workspace.openTablePreview')}
                onClick={() => setTableSourceByTab((current) => ({
                  ...current,
                  [activePreviewTab.id]: activeTableView === 'preview',
                }))}
                size="md"
                tone="muted"
                showTooltip={false}
              />
            )}
            {activePreviewTab.previewType !== 'image' && (
              <label className="hidden items-center gap-1 text-[10px] text-[var(--color-text-secondary)] min-[720px]:inline-flex">
                <span>{t('workspace.encoding')}</span>
                <select
                  aria-label={t('workspace.textEncoding')}
                  value={activePreviewTab.textEncoding ?? 'auto'}
                  onChange={(event) => {
                    const nextEncoding = event.target.value as 'auto' | 'utf8' | 'gbk'
                    requestDirtyAction('switch', [activePreviewTab], () => openPreview(
                      sessionId,
                      activePreviewTab.path,
                      activePreviewTab.kind,
                      undefined,
                      undefined,
                      activePreviewTab.diffSource,
                      nextEncoding,
                    ))
                  }}
                  className="h-7 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[10px] text-[var(--color-text-primary)]"
                >
                  <option value="auto">{t('workspace.encodingAuto')}</option>
                  <option value="utf8">UTF-8</option>
                  <option value="gbk">GBK</option>
                </select>
              </label>
            )}
            <Button
              variant="ghost"
              size="base"
              aria-label={t('workspace.addToChat')}
              onClick={() => addWorkspacePathToChat(activePreviewTab.path)}
              icon={<MessageCircle size={14} strokeWidth={1.8} aria-hidden="true" />}
              className="shrink-0"
            >
              <span className="hidden min-[960px]:inline">{t('workspace.addToChat')}</span>
            </Button>
            <IconButton
              icon={<RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" />}
              label={t('workspace.refresh')}
              onClick={() => void handleRefresh()}
              loading={workspaceRefreshLoading}
              size="md"
              tone="muted"
              showTooltip={false}
            />
            {!isVscodeLayout && (
              <IconButton
                icon={isNavigatorVisible
                  ? <PanelRightClose size={16} strokeWidth={1.9} aria-hidden="true" />
                  : <PanelRightOpen size={16} strokeWidth={1.9} aria-hidden="true" />}
                label={isNavigatorVisible ? t('workspace.hideNavigator') : t('workspace.showNavigator')}
                onClick={() => setIsNavigatorOpen((open) => {
                  const nextOpen = !open
                  if (nextOpen) window.requestAnimationFrame(() => filterInputRef.current?.focus())
                  return nextOpen
                })}
                size="md"
                tone="muted"
                pressed={isNavigatorVisible}
                showTooltip={false}
              />
            )}
            {!embedded && (
              <IconButton
                icon={<X size={16} strokeWidth={1.9} aria-hidden="true" />}
                label={t('workspace.closePanel')}
                onClick={() => closePanel(sessionId)}
                size="md"
                tone="muted"
                showTooltip={false}
              />
            )}
          </div>
        </div>

        {state === 'ok' && refreshErrorMessage && !activePreviewLoading && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-[11px] text-[var(--color-on-error-container)]"
          >
            <CircleAlert size={15} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{refreshErrorMessage}</span>
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => {
                requestDirtyAction('refresh', [activePreviewTab], () => openPreview(
                  sessionId,
                  activePreviewTab.path,
                  activePreviewTab.kind,
                  undefined,
                  undefined,
                  activePreviewTab.diffSource,
                  activePreviewTab.textEncoding,
                  activePreviewTab.comparisonEncodings,
                  { force: true },
                ))
              }}
              className="shrink-0"
            >
              {t('common.retry')}
            </Button>
          </div>
        )}

        {state === 'loading' || (activePreviewLoading && state !== 'ok') ? (
          <PanelMessage icon="progress_activity" message={t('workspace.previewState.loading')} />
        ) : state === 'ok' && activePreviewTab.previewType === 'image' ? (
          <ImagePreview tab={activePreviewTab} />
        ) : state === 'ok' && activePreviewTab.kind === 'diff' ? (
          <WorkspaceSideBySideDiffSurface
            value={activePreviewTab.diff ?? ''}
            comparison={activePreviewTab.comparison}
            comparisonSession={activePreviewTab.comparisonSession}
            path={activePreviewTab.path}
            hideSingleFileHeader
            onComparisonSessionChange={(comparisonSession) => {
              setComparisonSaveError(null)
              setComparisonSession(sessionId, activePreviewTab.id, comparisonSession)
            }}
            onSave={async () => {
              const saved = await saveComparisonTabs([activePreviewTab])
              if (saved) {
                await openPreview(
                  sessionId,
                  activePreviewTab.path,
                  activePreviewTab.kind,
                  undefined,
                  undefined,
                  activePreviewTab.diffSource,
                  activePreviewTab.textEncoding,
                  activePreviewTab.comparisonEncodings,
                  { force: true },
                )
              }
            }}
            saving={comparisonSaving}
            saveError={comparisonSaveError}
            onEncodingChange={handleComparisonEncodingChange}
            encodingChangingSide={encodingChangingSide}
            onAddComment={(selection, note) => addDiffCommentToChat(activePreviewTab.path, selection, note)}
          />
        ) : state === 'ok' && activeMarkdownView === 'preview' ? (
          <MarkdownSurface
            value={activePreviewTab.content ?? ''}
            path={activePreviewTab.path}
            sessionId={sessionId}
            workDir={status?.workDir}
            onAddSelection={(selection) => addSelectionToChat(activePreviewTab.path, selection)}
          />
        ) : state === 'ok' && activeTableView === 'preview' ? (
          <WorkspaceTableSurface
            value={activePreviewTab.content ?? ''}
            path={activePreviewTab.path}
          />
        ) : state === 'ok' ? (
          <CodeSurface
            value={activePreviewTab.content ?? ''}
            language={activePreviewTab.language ?? 'text'}
            reveal={activePreviewTab.reveal}
            onAddLineComment={(lineStart, lineEnd, note, quote) => (
              addLineCommentToChat(activePreviewTab.path, lineStart, lineEnd, note, quote)
            )}
            onAddSelection={(selection) => addSelectionToChat(activePreviewTab.path, selection)}
          />
        ) : (
          <PanelMessage
            icon="error"
            tone={state === 'error' ? 'error' : 'muted'}
            message={getInlineStateMessage(t, state, activePreviewError || activePreviewTab.error || null)}
          />
        )}
      </div>
    )
  }

  const renderPreviewTabs = () => (
    <>
      <div className="flex h-9 shrink-0 items-end border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3">
        <div
          role="tablist"
          aria-label={t('workspace.previewTabs')}
          className="flex min-w-0 flex-1 items-end gap-3 overflow-x-auto bg-[var(--color-surface)]"
        >
          {previewTabs.length === 0 ? (
            <div className="flex items-center gap-2 px-1.5 text-[12px] text-[var(--color-text-tertiary)]">
              <span className="material-symbols-outlined text-[15px]">docs</span>
              <span>{t('workspace.preview')}</span>
            </div>
          ) : (
            previewTabs.map((tab) => {
              const kindLabel = getPreviewKindLabel(t, tab.kind)
              const isActive = tab.id === activePreviewTab?.id

              return (
                <div
                  key={tab.id}
                  onContextMenu={(event) => handlePreviewTabContextMenu(event, tab.id)}
                  className={`group relative flex h-9 min-w-[96px] max-w-[220px] shrink-0 items-center gap-2 px-1 text-left text-[12px] transition-colors ${
                    isActive
                      ? 'text-[var(--color-text-primary)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--color-info)]'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => {
                      if (isActive) return
                      requestDirtyAction('switch', activePreviewTab ? [activePreviewTab] : [], () => {
                        activatePreview(sessionId, tab.id)
                      })
                    }}
                    className="min-w-0 flex flex-1 items-center gap-2 text-left"
                  >
                    {tab.kind === 'diff' ? (
                      <span className="material-symbols-outlined shrink-0 text-[15px] text-[var(--color-text-tertiary)]">difference</span>
                    ) : (
                      <FileTypeBadge name={tab.title} subtle={!isActive} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  </button>
                  <span className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                    <IconButton
                      icon="close"
                      label={`${t('workspace.closeTab')} ${tab.title} ${kindLabel}`}
                      onClick={() => {
                        requestClosePreviewTabs(tab.id, 'current')
                      }}
                      size="2xs"
                      tone="muted"
                      showTooltip={false}
                    />
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>

      {previewTabContextMenu && (
        <div
          ref={previewTabContextMenuRef}
          role="menu"
          className="glass-panel fixed z-[var(--z-dropdown)] min-w-[156px] rounded-[var(--radius-md)] py-1 text-[12px]"
          style={{ left: previewTabContextMenu.x, top: previewTabContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('current')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('others')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('left')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('right')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('all')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeAll')}
          </button>
        </div>
      )}
    </>
  )

  return (
    <aside
      data-testid="workspace-panel"
      className={
        embedded
          ? 'flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--color-surface)]'
          : 'flex h-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]'
      }
      style={embedded ? undefined : { width: panelWidth, maxWidth: panelMaxWidth, minWidth: panelMinWidth }}
    >
      <div
        ref={workspaceLayoutRef}
        data-testid="workspace-review-layout"
        data-layout={layout}
        className={`relative flex min-h-0 flex-1 overflow-hidden ${isVscodeLayout ? 'flex-row' : 'flex-col'}`}
      >
        {!isVscodeLayout && <div role="tablist" aria-label={t('workspace.viewTabs')} className="flex h-10 shrink-0 items-end gap-4 border-b border-[var(--color-border)] px-3">
          <button
            type="button"
            role="tab"
            aria-selected={isNavigatorVisible}
            onClick={() => setIsNavigatorOpen(true)}
            className={`relative h-10 px-1 text-[12px] font-medium ${isNavigatorVisible ? 'text-[var(--color-text-primary)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[var(--color-info)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >{t('workspace.fileTree')}</button>
          <button
            type="button"
            role="tab"
            aria-selected={!isNavigatorVisible && !isWorkspaceComparisonVisible}
            onClick={handleShowFileView}
            className={`relative h-10 px-1 text-[12px] font-medium ${!isNavigatorVisible && !isWorkspaceComparisonVisible ? 'text-[var(--color-text-primary)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[var(--color-info)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >{t('workspace.viewFiles')}{hasPreviewTabs ? ` (${previewTabs.length})` : ''}</button>
          <button
            type="button"
            role="tab"
            aria-selected={isWorkspaceComparisonVisible}
            disabled={!workspaceComparisonPath && !activePreviewIsWorkspaceComparison}
            onClick={handleShowWorkspaceComparison}
            onMouseEnter={preloadWorkspaceComparison}
            onFocus={preloadWorkspaceComparison}
            className={`relative h-10 px-1 text-[12px] font-medium disabled:cursor-not-allowed disabled:text-[var(--color-text-tertiary)] ${isWorkspaceComparisonVisible ? 'text-[var(--color-text-primary)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[var(--color-info)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >{t('workspace.compareWorkspace')}</button>
        </div>}

        {(hasPreviewTabs || isVscodeLayout) && <div data-testid="workspace-preview-column" className={`${isVscodeLayout || !isNavigatorVisible ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]`}>
            {renderPreviewTabs()}
            {renderPreviewContent()}
        </div>}

        <div
            ref={navigatorRef}
            data-testid="workspace-file-navigator"
            className={`${isVscodeLayout || isNavigatorVisible ? 'flex' : 'hidden'} min-h-0 flex-col bg-[var(--color-surface)] ${isVscodeLayout ? 'order-first min-w-[220px] max-w-[70%] shrink-0' : 'flex-1'}`}
            style={isVscodeLayout ? { width: navigatorWidth } : undefined}
          >
            <header
              data-testid="workspace-file-navigator-header"
              className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-3"
            >
              <div className="relative min-w-0">
              <button
                type="button"
                aria-label={activeView === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                aria-haspopup="menu"
                aria-expanded={isViewMenuOpen}
                onClick={() => setIsViewMenuOpen((open) => !open)}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[var(--radius-md)] px-1 py-1 text-[14px] font-semibold leading-5 text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              >
                <span className="truncate">
                  {activeView === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                </span>
                <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[15px] font-normal text-[var(--color-text-tertiary)]">expand_more</span>
              </button>
              {isViewMenuOpen && (
                <div
                  role="menu"
                  className="glass-panel absolute left-0 top-[calc(100%+4px)] z-[var(--z-dropdown)] min-w-[124px] overflow-hidden rounded-[var(--radius-md)] py-1"
                >
                  {(['changed', 'all'] as const).map((view) => {
                    const selected = activeView === view
                    return (
                      <button
                        key={view}
                        type="button"
                        role="menuitem"
                        onClick={() => handleSetActiveView(view)}
                        className={`flex h-7 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-left text-[12px] transition-colors ${
                          selected ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {view === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                        </span>
                        {selected && (
                          <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">check</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              </div>
              {activeView === 'all' && (
                <IconButton
                  icon={<FolderPlus size={16} strokeWidth={1.9} aria-hidden="true" />}
                  label={t('workspace.addFolder')}
                  onClick={() => void handleAddWorkspaceFolder()}
                  size="md"
                  tone="muted"
                  showTooltip={false}
                />
              )}
              {(!hasPreviewTabs || isVscodeLayout) && (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <IconButton
                    icon={<RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" />}
                    label={t('workspace.refresh')}
                    onClick={() => void handleRefresh()}
                    loading={workspaceRefreshLoading}
                    size="md"
                    tone="muted"
                    showTooltip={false}
                  />
                  {!embedded && (
                    <IconButton
                      icon={<X size={16} strokeWidth={1.9} aria-hidden="true" />}
                      label={t('workspace.closePanel')}
                      onClick={() => closePanel(sessionId)}
                      size="md"
                      tone="muted"
                      showTooltip={false}
                    />
                  )}
                </div>
              )}
            </header>

            <WorkspaceFilterInput
              value={filterQuery}
              onChange={setFilterQuery}
              summary={normalizedFilterQuery ? filterSummary : undefined}
              mode={navigatorView}
              loading={hasWorkspaceSearch && workspaceSearchLoading}
              inputRef={filterInputRef}
              onFocusFirstResult={hasWorkspaceSearch ? focusFirstSearchResult : undefined}
            />
            {navigatorView === 'changed' && (
              <ChangedFilesFilterBar
                plainTextOnly={plainTextOnly}
                versionFilter={changedVersionFilter}
                onPlainTextOnlyChange={setPlainTextOnly}
                onVersionFilterChange={setChangedVersionFilter}
              />
            )}

            <div className="min-h-0 flex-1 overflow-auto py-1.5">
              {navigatorView === 'changed' ? renderChangedView() : renderAllFilesView()}
            </div>
        </div>
        {isVscodeLayout && (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('workspace.resizeNavigator')}
            aria-valuemin={WORKSPACE_NAVIGATOR_MIN_WIDTH}
            aria-valuemax={Math.round(getNavigatorMaximumWidth())}
            aria-valuenow={navigatorWidth}
            data-testid="workspace-file-navigator-resize-handle"
            onMouseDown={handleNavigatorResizeStart}
            onDoubleClick={resetNavigatorWidth}
            onKeyDown={handleNavigatorResizeKeyDown}
            className="group relative order-[-1] w-px shrink-0 cursor-col-resize bg-[var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <div className="absolute inset-y-0 -left-[3px] z-10 w-[7px] transition-colors group-hover:bg-[var(--color-brand)]/20 group-focus-visible:bg-[var(--color-brand)]/20" />
          </div>
        )}
      </div>

      {fileContextMenu && (
        <div
          ref={fileContextMenuRef}
          role="menu"
          className="glass-panel fixed z-[var(--z-dropdown)] min-w-[156px] rounded-[var(--radius-md)] py-1 text-[12px]"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addWorkspacePathToChat(fileContextMenu.path, fileContextMenu.isDirectory)
              setFileContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">person_add</span>
            <span>{t('workspace.addToChat')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyWorkspacePath(fileContextMenu.path)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">content_copy</span>
            <span>{t('workspace.copyPath')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyWorkspacePath(fileContextMenu.path, 'absolute')}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">file_copy</span>
            <span>{t('workspace.copyAbsolutePath')}</span>
          </button>
          <WorkspaceFileOpenWith
            absolutePath={resolveWorkspaceAttachmentPath(status?.workDir, fileContextMenu.path)}
            sessionId={sessionId}
            workspacePath={fileContextMenu.isDirectory ? undefined : fileContextMenu.path}
            onAfterSelect={() => setFileContextMenu(null)}
          />
        </div>
      )}
      <ActionDialog
        open={Boolean(pendingDirtyAction)}
        onClose={() => {
          if (!comparisonSaving) setPendingDirtyAction(null)
        }}
        title={t('workspace.diffEdit.dirtyTitle')}
        body={pendingDirtyAction
          ? (
              <div className="space-y-2">
                <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                  {t('workspace.diffEdit.dirtyBody', {
                    action: t(`workspace.diffEdit.action.${pendingDirtyAction.kind}`),
                  })}
                </p>
                {comparisonSaveError && (
                  <p role="alert" className="text-sm leading-6 text-[var(--color-error)]">{comparisonSaveError}</p>
                )}
              </div>
            )
          : null}
        actions={[
          {
            label: t('common.cancel'),
            onClick: () => setPendingDirtyAction(null),
          },
          {
            label: t('workspace.diffEdit.discard'),
            variant: 'danger',
            onClick: async () => {
              if (!pendingDirtyAction) return
              for (const tab of findTabs(pendingDirtyAction.tabIds)) {
                if (tab.comparisonSession) {
                  setComparisonSession(sessionId, tab.id, discardWorkspaceComparisonSession(tab.comparisonSession))
                }
              }
              const proceed = pendingDirtyAction.proceed
              setPendingDirtyAction(null)
              setComparisonSaveError(null)
              await proceed()
            },
          },
          {
            label: t('common.save'),
            variant: 'primary',
            loading: comparisonSaving,
            onClick: async () => {
              if (!pendingDirtyAction) return
              const saved = await saveComparisonTabs(findTabs(pendingDirtyAction.tabIds))
              if (!saved) return
              const proceed = pendingDirtyAction.proceed
              setPendingDirtyAction(null)
              await proceed()
            },
          },
        ]}
      />
    </aside>
  )
}
