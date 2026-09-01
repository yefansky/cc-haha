import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAssistantOutputFileHref } from '../../lib/assistantOutputTargets'

const WORK_DIR = 'G:/workspace'
const VERIFIED_FILE = 'G:/workspace/星河项目/reports/session/航行纪要.md'
const ENCODED_ROOT_HREF = '/reports/session/%E8%88%AA%E8%A1%8C%E7%BA%AA%E8%A6%81.md'

const testDoubles = vi.hoisted(() => ({
  openPreviewLink: vi.fn(() => true),
  workspaceState: {
    statusBySession: {
      'session-orbit': { workDir: 'G:/workspace' },
    },
  },
}))

vi.mock('../../lib/openPreviewLink', () => ({
  openPreviewLink: testDoubles.openPreviewLink,
}))

vi.mock('../../stores/workspacePanelStore', () => ({
  useWorkspacePanelStore: Object.assign(
    (selector: (state: typeof testDoubles.workspaceState) => unknown) => selector(testDoubles.workspaceState),
    { getState: () => testDoubles.workspaceState },
  ),
}))

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
  useTranslation: () => (key: string) => key,
}))

vi.mock('./AssistantOutputTargetCard', () => ({ AssistantOutputTargetCard: () => null }))
vi.mock('./InlineImageGallery', () => ({ InlineImageGallery: () => null }))
vi.mock('./InlineVideoGallery', () => ({ InlineVideoGallery: () => null }))
vi.mock('./MessageActionBar', () => ({ MessageActionBar: () => null }))
vi.mock('./TurnCompletionStamp', () => ({ TurnCompletionStamp: () => null }))
vi.mock('@/components/composite/OpenWithMenu', () => ({ OpenWithMenu: () => null }))

import { AssistantMessage } from './AssistantMessage'

function resolve(
  href: string,
  referencedFiles: string[] | undefined,
  workDir = WORK_DIR,
) {
  return resolveAssistantOutputFileHref(href, { workDir, referencedFiles })
}

afterEach(() => {
  cleanup()
  testDoubles.openPreviewLink.mockReset().mockReturnValue(true)
})

describe('root-relative assistant file links use verified evidence conservatively', () => {
  it('re-anchors an encoded Chinese href to the sole verified full-suffix match', () => {
    expect(resolve(ENCODED_ROOT_HREF, [VERIFIED_FILE]))
      .toBe('星河项目/reports/session/航行纪要.md')
  })

  it('keeps a root-relative href when there is no verified file evidence', () => {
    const href = '/notes/launch/启动说明.md'

    expect(resolve(href, undefined)).toBe(href)
  })

  it('keeps a root-relative href when the complete suffix is ambiguous', () => {
    const href = '/briefs/release/验收清单.md'

    expect(resolve(href, [
      'G:/workspace/北区/briefs/release/验收清单.md',
      'G:/workspace/南区/briefs/release/验收清单.md',
    ])).toBe(href)
  })

  it('does not promote a basename-only root href into a unique nested-file guess', () => {
    const href = '/孤本.md'

    expect(resolve(href, ['G:/workspace/档案馆/深层目录/孤本.md'])).toBe(href)
  })

  it.each([
    '//fileserver/share/reports/session/航行纪要.md',
    '\\\\fileserver\\share\\reports\\session\\航行纪要.md',
  ])('preserves forward- or backslash UNC input: %s', (href) => {
    expect(resolve(href, [VERIFIED_FILE])).toBe(href)
  })

  it.each([
    '/reports%2Fsession/%E8%88%AA%E8%A1%8C%E7%BA%AA%E8%A6%81.md',
    '/reports%5Csession%5C%E8%88%AA%E8%A1%8C%E7%BA%AA%E8%A6%81.md',
  ])('does not give an encoded separator new path semantics: %s', (href) => {
    expect(resolve(href, [VERIFIED_FILE])).toBe(href)
  })

  it.each([
    '/%2e%2e/reports/session/%E8%88%AA%E8%A1%8C%E7%BA%AA%E8%A6%81.md',
    '/%252e%252e/reports/session/%E8%88%AA%E8%A1%8C%E7%BA%AA%E8%A6%81.md',
  ])('does not reconcile encoded traversal input: %s', (href) => {
    expect(resolve(href, [VERIFIED_FILE])).toBe(href)
  })
})

describe('AssistantMessage root-relative link click boundary', () => {
  it('passes the evidence-resolved path to the shared preview opener', () => {
    render(
      <AssistantMessage
        sessionId="session-orbit"
        content={`[打开航行纪要](${ENCODED_ROOT_HREF})`}
        turnReferencedFiles={[VERIFIED_FILE]}
      />,
    )

    fireEvent.click(screen.getByRole('link', { name: '打开航行纪要' }))

    expect(testDoubles.openPreviewLink)
      .toHaveBeenCalledWith('星河项目/reports/session/航行纪要.md', 'session-orbit')
  })
})
