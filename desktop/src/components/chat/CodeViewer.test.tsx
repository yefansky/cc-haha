import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeViewer } from './CodeViewer'
import { isTreeCode } from './TreeCodeContent'

describe('CodeViewer', () => {
  const tree = '项目/\n├── src/\n│   └── 文件.ts\n└── README.md\n'

  it('preserves tree source, whitespace and blank lines while drawing prefix connectors', () => {
    const { container } = render(<CodeViewer code={tree} />)
    const content = container.querySelector('[data-highlight-engine="tree"]')!
    expect(content.textContent).toBe(tree)
    expect(content.querySelectorAll('.tree-code-line')).toHaveLength(5)
    expect(content.querySelectorAll('[data-connector="│"]')).toHaveLength(1)
    expect(content.querySelectorAll('[data-connector="└"]')).toHaveLength(2)
  })

  it('keeps tree rendering stable when the collapsed portion has no branches yet', () => {
    const { container } = render(<CodeViewer code={tree} maxLines={1} />)
    expect(container.querySelector('[data-highlight-engine="tree"]')?.textContent).toBe('项目/')
    fireEvent.click(container.querySelector('button.w-full')!)
    expect(container.querySelector('[data-highlight-engine="tree"]')?.textContent).toBe(tree)
  })

  it('retains tabs, label box characters, wrapping and line numbering', () => {
    const code = '根/\n\t├── 文件│名\n\t└── 第二个'
    const { container } = render(<CodeViewer code={code} language="tree" showLineNumbers wrapLongLines />)
    expect(container.querySelector('pre')?.textContent).toBe(code)
    expect(container.querySelector('.tree-code-label')?.getAttribute('style')).toContain('pre-wrap')
    expect(container.querySelectorAll('[data-connector="│"]')).toHaveLength(0)
    expect(container.querySelectorAll('.tree-code-line[data-line-number]')).toHaveLength(3)
    expect((container.querySelectorAll('.tree-code-cell')[0] as HTMLElement).style.width).toBe('8ch')
  })

  it('does not classify normal code, isolated branches or tables as trees', () => {
    expect(isTreeCode(tree)).toBe(true)
    expect(isTreeCode(tree, 'text')).toBe(true)
    expect(isTreeCode(tree, 'typescript')).toBe(false)
    expect(isTreeCode('├── one')).toBe(false)
    expect(isTreeCode('┌───┐\n│ a │\n└───┘')).toBe(false)
    expect(isTreeCode('a | b\nc | d')).toBe(false)
  })
  it('keeps the same inner padding for highlighted code content', () => {
    const { container } = render(
      <CodeViewer code={'cd testb\nnpm run dev'} language="bash" showLineNumbers />,
    )

    expect(screen.getByText('cd testb')).toBeTruthy()
    expect(screen.getByText('npm run dev')).toBeTruthy()

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.padding).toBe('0.5rem 12px')
    expect(contentWrapper?.style.whiteSpace).toBe('pre')
    expect(contentWrapper?.style.wordBreak).toBe('normal')

    const codeArea = container.querySelector('.code-viewer-area') as HTMLElement | null
    expect(codeArea?.getAttribute('data-has-line-numbers')).toBe('true')
    expect(container.querySelector('[data-line-number="1"]')).toBeTruthy()
    expect(container.querySelector('[data-line-number="2"]')).toBeTruthy()
  })

  it('can wrap long highlighted code content when requested', () => {
    const { container } = render(
      <CodeViewer code={'{"command":"cat << EOF > /tmp/index.html"}'} language="json" wrapLongLines />,
    )

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.whiteSpace).toBe('pre-wrap')
    expect(contentWrapper?.style.wordBreak).toBe('break-word')
  })
})
