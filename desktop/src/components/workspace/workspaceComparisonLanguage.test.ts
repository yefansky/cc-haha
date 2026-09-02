import { describe, expect, it } from 'vitest'
import { lexWorkspaceCpp, prepareWorkspaceComparisonInputs } from './workspaceComparisonLanguage'
import { createDefaultWorkspaceComparisonSettings } from './workspaceComparisonSettings'

describe('workspaceComparisonLanguage', () => {
  it('classifies C/C++ input into the frozen eight lexical categories without gaps or overlap', () => {
    const value = '#define N 42\\\n\nint main() { /* c */ const char* s = "x"; return N + 1; } // tail\n'
    const result = lexWorkspaceCpp(value)
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return
    expect(new Set(result.tokens.map((token) => token.scope))).toEqual(new Set([
      'keyword', 'identifier', 'number', 'string', 'preprocessor', 'comment', 'operator', 'whitespace',
    ]))
    expect(result.tokens.map((token) => value.slice(token.start, token.end)).join('')).toBe(value)
  })

  it('changes only equivalence keys for global whitespace/case ignores', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.ignoreWhitespace = true
    settings.ignoreCase = true
    const result = prepareWorkspaceComparisonInputs('Hello,   WORLD\n', ' hello, world \n', settings)
    expect(result.left[0]).toMatchObject({ text: 'Hello,   WORLD', equivalenceKey: 'hello,world' })
    expect(result.right[0]).toMatchObject({ text: ' hello, world ', equivalenceKey: 'hello,world' })
  })

  it('ignores line endings and Unicode whitespace without changing raw text', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.ignoreWhitespace = true
    const result = prepareWorkspaceComparisonInputs(
      'A\u00a0B\u2003C\u3000D\r\n',
      'ABCD\n',
      settings,
    )

    expect(result.left[0]).toMatchObject({
      text: 'A\u00a0B\u2003C\u3000D',
      ending: '\r\n',
      equivalenceKey: 'ABCD',
    })
    expect(result.right[0]).toMatchObject({ text: 'ABCD', ending: '\n', equivalenceKey: 'ABCD' })
  })

  it('uses locale-independent Unicode simple case folding', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.ignoreCase = true
    const result = prepareWorkspaceComparisonInputs('ΟΣ\n', 'Ος\n', settings)

    expect(result.left[0]!.equivalenceKey).toBe(result.right[0]!.equivalenceKey)
    expect(result.left[0]!.text).toBe('ΟΣ')
    expect(result.right[0]!.text).toBe('Ος')
  })

  it('tokenizes C++ operators longest-first', () => {
    const value = 'a >>= b::c->d && e;\n'
    const result = lexWorkspaceCpp(value)
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return
    expect(result.tokens
      .filter((token) => token.scope === 'operator')
      .map((token) => value.slice(token.start, token.end)))
      .toEqual(['>>=', '::', '->', '&&', ';'])
  })

  it.each([
    ['ordinary string', 'const char* s = "never closed\n'],
    ['block comment', 'int value; /* never closed\n'],
    ['raw string', 'auto value = R"tag(never closed\n'],
  ])('reports an unterminated %s and falls the whole comparison back to text', (_, value) => {
    expect(lexWorkspaceCpp(value)).toMatchObject({ state: 'error' })

    const settings = createDefaultWorkspaceComparisonSettings('a.cpp')
    const prepared = prepareWorkspaceComparisonInputs(value, 'int other = 1;\n', settings)
    expect(prepared.diagnostics).toContain('lexer_fallback')
    expect(prepared.left.flatMap((line) => line.tokens)).toEqual([])
    expect(prepared.right.flatMap((line) => line.tokens)).toEqual([])
  })

  it('applies higher priority span ownership first and preserves important text against global ignores', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.ignoreCase = true
    settings.rules = [
      { id: 'important', name: 'important id', enabled: true, pattern: 'ID', caseSensitive: true, scope: 'line', effect: 'important', priority: 20 },
      { id: 'ignore', name: 'ignore line', enabled: true, pattern: 'ID=\\d+', caseSensitive: true, scope: 'line', effect: 'ignore', priority: 10 },
    ]
    const result = prepareWorkspaceComparisonInputs('ID=12\n', 'id=99\n', settings)
    expect(result.left[0]!.equivalenceKey).not.toBe(result.right[0]!.equivalenceKey)
  })

  it('discards all custom-rule effects when the global runtime budget is exceeded', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.rules = [{ id: 'r', name: 'r', enabled: true, pattern: 'a+', caseSensitive: true, scope: 'line', effect: 'ignore', priority: 1 }]
    const result = prepareWorkspaceComparisonInputs('a'.repeat(200), 'b', settings, { transitions: 8 })
    expect(result.diagnostics).toContain('rules_skipped_budget')
    expect(result.left[0]!.equivalenceKey).toBe('a'.repeat(200))
  })

  it('discards all custom-rule effects when one target has 129 matches', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.rules = [{ id: 'r', name: 'r', enabled: true, pattern: 'a', caseSensitive: true, scope: 'line', effect: 'ignore', priority: 1 }]
    const result = prepareWorkspaceComparisonInputs('a'.repeat(129), 'b', settings)

    expect(result.diagnostics).toContain('rules_skipped_budget')
    expect(result.left[0]!.equivalenceKey).toBe('a'.repeat(129))
  })
})
