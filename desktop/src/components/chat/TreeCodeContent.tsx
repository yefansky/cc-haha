import { Fragment } from 'react'

// Only prefixes are geometry. Labels (including box characters in filenames)
// remain literal text, and copying always uses the original CodeViewer source.
const TREE_PREFIX = /^[ \t│├└─]+/
const TREE_BRANCH = /^[ \t│]*(?:├|└)─+/

export function isTreeCode(code: string, language?: string): boolean {
  if (language && !['text', 'plaintext', 'plain', 'tree', 'directory'].includes(language.toLowerCase())) return false
  return code.split('\n').filter(line => TREE_BRANCH.test(line)).length >= 2
}

export function TreeCodeContent({ code, wrapLongLines, showLineNumbers }: { code: string; wrapLongLines: boolean; showLineNumbers: boolean }) {
  return (
    <pre data-code-viewer-content="" data-highlight-engine="tree" className="tree-code-content">
      <code>
        {code.split('\n').map((line, index) => {
          const prefix = TREE_PREFIX.exec(line)?.[0] ?? ''
          let column = 0
          return (
            <Fragment key={index}>
              {index > 0 && '\n'}
              <span className="tree-code-line" data-line-number={showLineNumbers ? index + 1 : undefined}>
                <span className="tree-code-prefix">
                  {Array.from(prefix).map((char, offset) => {
                    const width = char === '\t' ? 8 - column % 8 : 1
                    column += width
                    return (
                      <span key={offset} className="tree-code-cell" data-connector={'│├└─'.includes(char) ? char : undefined} style={{ width: `${width}ch` }}>
                        {char}
                      </span>
                    )
                  })}
                </span>
                <span className="tree-code-label" style={{ whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre', overflowWrap: wrapLongLines ? 'anywhere' : undefined }}>{line.slice(prefix.length)}</span>
              </span>
            </Fragment>
          )
        })}
      </code>
    </pre>
  )
}
