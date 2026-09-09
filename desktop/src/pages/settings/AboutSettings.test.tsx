import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { AboutSettings } from './AboutSettings'
import { UpdateChecker } from '../../components/layout/UpdateChecker'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUpdateStore } from '../../stores/updateStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

const installed = '当前版本支持断网查看更新说明。'
const upcoming = '修复下载中断后无法重新下载的问题。'
const initial = useUpdateStore.getState()

describe('update notes before and after installation', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh', updateProxy: { mode: 'system', url: '' } })
    useUpdateStore.setState({ ...initial, initialize: vi.fn().mockResolvedValue(undefined) })
    window.localStorage.clear()
    vi.stubGlobal('__PACKAGED_CHANGELOG__', { version: '1.2.3', markdown: installed })
    vi.stubGlobal('__PACKAGED_CHANGELOG_HISTORY__', Array.from({ length: 8 }, (_, index) => ({
      version: `1.0.${8 - index}`, date: '2026-09-01T00:00:00Z', source: 'backfilled',
      markdown: `历史改动第 ${8 - index} 项：修复文件对比内容显示不完整的问题。`,
    })))
    window.desktopHost = {
      ...browserHost,
      kind: 'electron', isDesktop: true,
      capabilities: { ...browserHost.capabilities, updates: true },
      app: { ...browserHost.app, getVersion: vi.fn().mockResolvedValue('1.2.3') },
      shell: { ...browserHost.shell, open: vi.fn().mockResolvedValue(undefined) },
      updates: {
        ...browserHost.updates,
        check: vi.fn().mockResolvedValue({
          version: '1.2.4', body: upcoming,
          download: vi.fn(async (emit) => { emit({ event: 'Finished' }) }),
          install: vi.fn(), close: vi.fn(),
        }),
      },
    }
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.desktopHost })

  it('keeps installed notes offline, displays checked/downloaded release notes, then keeps new installed notes after restart', async () => {
    const view = render(<><AboutSettings /><UpdateChecker /></>)
    expect(await screen.findByText(installed)).toBeInTheDocument()
    expect(window.desktopHost!.updates.check).not.toHaveBeenCalled()
    await act(async () => { await useUpdateStore.getState().checkForUpdates({ autoDownload: false }) })
    expect(screen.getByText('新版 1.2.4 更新内容')).toBeInTheDocument()
    expect(screen.getByText(upcoming)).toBeInTheDocument()
    expect(screen.getByText(installed)).toBeInTheDocument()
    await act(async () => { await useUpdateStore.getState().downloadUpdate() })
    expect(screen.getAllByText(upcoming)).toHaveLength(2)
    expect(useUpdateStore.getState().status).toBe('downloaded')

    // A restarted app gets its own bundled notes, not the previous process's store.
    view.unmount()
    useUpdateStore.setState({ ...initial, initialize: vi.fn().mockResolvedValue(undefined) })
    vi.stubGlobal('__PACKAGED_CHANGELOG__', { version: '1.2.4', markdown: upcoming })
    vi.mocked(window.desktopHost!.app.getVersion).mockResolvedValue('1.2.4')
    vi.mocked(window.desktopHost!.updates.check).mockResolvedValue(null)
    render(<AboutSettings />)
    expect(await screen.findByText('当前版本 1.2.4 更新内容')).toBeInTheDocument()
    await act(async () => { await useUpdateStore.getState().checkForUpdates({ autoDownload: false }) })
    expect(useUpdateStore.getState().status).toBe('up-to-date')
    expect(screen.getByText(upcoming)).toBeInTheDocument()
    expect(screen.queryByText(installed)).not.toBeInTheDocument()
    expect(screen.queryByText('新版 1.2.4 更新内容')).not.toBeInTheDocument()
  })

  it('opens the in-app current-version notes from the changelog link', async () => {
    render(<AboutSettings />)
    const button = await screen.findByRole('button', { name: '更新日志' })
    fireEvent.click(button)
    expect(document.getElementById('installed-changelog')).toHaveFocus()
  })

  it('browses and searches offline history in the app without opening a website', async () => {
    render(<AboutSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '查看所有版本的更新记录' }))
    expect(document.getElementById('changelog-history')).toHaveFocus()
    expect(screen.getByText('共 8 个版本')).toBeInTheDocument()
    expect(screen.queryByText('1.0.1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示更多版本' }))
    expect(screen.getByText('1.0.1')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'v1.0.1' } })
    expect(screen.getByText('共 1 个版本')).toBeInTheDocument()
    expect(screen.getByText('历史改动第 1 项：修复文件对比内容显示不完整的问题。')).toBeVisible()
    expect(screen.queryByText('1.0.8')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在的改动' } })
    expect(screen.getByText('没有找到符合条件的版本。')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '文件对比' } })
    expect(screen.getByText('共 8 个版本')).toBeInTheDocument()
    expect(window.desktopHost!.shell.open).not.toHaveBeenCalled()
    expect(window.desktopHost!.updates.check).not.toHaveBeenCalled()
  })

  it('does not mislabel another version’s bundled notes and explains missing remote notes', async () => {
    vi.stubGlobal('__PACKAGED_CHANGELOG__', { version: '9.9.9', markdown: '这不是当前版本的改动。' })
    vi.mocked(window.desktopHost!.updates.check).mockResolvedValue({
      version: '1.2.4', body: null, download: vi.fn(), install: vi.fn(), close: vi.fn(),
    })
    render(<AboutSettings />)
    await waitFor(() => expect(screen.getByText('当前版本 1.2.3 更新内容')).toBeInTheDocument())
    expect(screen.queryByText('这不是当前版本的改动。')).not.toBeInTheDocument()
    expect(screen.getByText(/此安装包未附带更新说明/)).toBeInTheDocument()
    await act(async () => { await useUpdateStore.getState().checkForUpdates({ autoDownload: false }) })
    expect(screen.getByText(/此版本暂未提供更新说明/)).toBeInTheDocument()
    expect(window.desktopHost!.shell.open).not.toHaveBeenCalled()
  })
})
