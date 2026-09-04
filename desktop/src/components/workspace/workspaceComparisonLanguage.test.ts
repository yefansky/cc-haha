import { describe, expect, it } from 'vitest'
import {
  lexWorkspaceCpp,
  lexWorkspaceLua,
  lexWorkspacePython,
  prepareWorkspaceComparisonInputs,
} from './workspaceComparisonLanguage'
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

  it('ignores text trailing whitespace and case without removing substantive word spacing', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.ignoreWhitespace = true
    settings.ignoreCase = true
    const result = prepareWorkspaceComparisonInputs('Hello,   WORLD\u00a0\n', 'hello,   world\t\n', settings)
    expect(result.left[0]).toMatchObject({ text: 'Hello,   WORLD\u00a0', equivalenceKey: 'hello,   world' })
    expect(result.right[0]).toMatchObject({ text: 'hello,   world\t', equivalenceKey: 'hello,   world' })

    const boundary = prepareWorkspaceComparisonInputs('a b\n', 'ab\n', settings)
    expect(boundary.left[0]!.equivalenceKey).not.toBe(boundary.right[0]!.equivalenceKey)
  })

  it('ignores line endings and trailing Unicode whitespace without changing raw text', () => {
    const settings = createDefaultWorkspaceComparisonSettings('a.txt')
    settings.ignoreWhitespace = true
    const result = prepareWorkspaceComparisonInputs(
      'ABCD\u00a0\u2003\u3000\r\n',
      'ABCD\n',
      settings,
    )

    expect(result.left[0]).toMatchObject({
      text: 'ABCD\u00a0\u2003\u3000',
      ending: '\r\n',
      equivalenceKey: 'ABCD',
    })
    expect(result.right[0]).toMatchObject({ text: 'ABCD', ending: '\n', equivalenceKey: 'ABCD' })
  })

  it('ignores only C++ lexer whitespace while preserving token boundaries and protected scopes', () => {
    const settings = createDefaultWorkspaceComparisonSettings('main.cpp')
    settings.ignoreWhitespace = true
    const equivalent = prepareWorkspaceComparisonInputs(
      'int value = call(a, b) + 1;\n',
      'int   value=call( a,b )+1;\n',
      settings,
    )
    expect(equivalent.left[0]!.equivalenceKey).toBe(equivalent.right[0]!.equivalenceKey)

    for (const [left, right] of [
      ['const char* value = "a b";\n', 'const char* value = "ab";\n'],
      ['int value; // a b\n', 'int value; // ab\n'],
      ['#define CALL(a, b) a + b\n', '#define CALL(a,b) a+b\n'],
      ['int value;\n', 'intvalue;\n'],
    ] as const) {
      const prepared = prepareWorkspaceComparisonInputs(left, right, settings)
      expect(prepared.left[0]!.equivalenceKey).not.toBe(prepared.right[0]!.equivalenceKey)
    }
  })

  it.each([
    ['main.cpp', 'int f(){ return x + ++y; }\n', 'int f(){ return x+++y; }\n'],
    ['main.lua', 'return a - -b\n', 'return a--b\n'],
    ['check.py', 'x < < y\n', 'x << y\n'],
  ])('does not collide token boundaries after ignoring whitespace for %s', (path, left, right) => {
    const settings = createDefaultWorkspaceComparisonSettings(path)
    settings.ignoreWhitespace = true
    const prepared = prepareWorkspaceComparisonInputs(left, right, settings)

    expect(prepared.left[0]!.equivalenceKey).not.toBe(prepared.right[0]!.equivalenceKey)
  })

  it.each([
    ['comments before hash', '/* lead */ #define F(x) x\n', '/* lead */ #define F (x) x\n'],
    ['the percent-colon digraph', '/* lead */ %:define F(x) x\n', '/* lead */ %:define F (x) x\n'],
    ['a conservatively continued directive', '#define F(x) \\   \n  x\n', '#define F(x) \\   \n x\n'],
  ])('keeps whitespace substantive in C++ preprocessor directives with %s', (_, left, right) => {
    const settings = createDefaultWorkspaceComparisonSettings('main.cpp')
    settings.ignoreWhitespace = true
    const prepared = prepareWorkspaceComparisonInputs(left, right, settings)

    expect(prepared.left.map((line) => line.equivalenceKey)).not.toEqual(prepared.right.map((line) => line.equivalenceKey))
    expect(prepared.left.flatMap((line) => line.tokens).some((token) => token.scope === 'preprocessor')).toBe(true)
  })

  it.each([
    ['C++', lexWorkspaceCpp],
    ['Python', lexWorkspacePython],
    ['Lua', lexWorkspaceLua],
  ] as const)('does not consume binary plus into a %s number token', (_, lexer) => {
    const value = 'x=1+2\n'
    const result = lexer(value)
    expect(result.state).toBe('ok')
    if (result.state !== 'ok') return

    expect(result.tokens
      .filter((token) => token.scope === 'number')
      .map((token) => value.slice(token.start, token.end)))
      .toEqual(['1', '2'])
    expect(result.tokens
      .filter((token) => token.scope === 'operator')
      .map((token) => value.slice(token.start, token.end)))
      .toContain('+')
  })

  it('keeps Python indentation and string whitespace substantive while ignoring safe code spacing', () => {
    const settings = createDefaultWorkspaceComparisonSettings('check.py')
    settings.ignoreWhitespace = true
    const safe = prepareWorkspaceComparisonInputs('value = call(a, b) + 1  \n', 'value=call( a,b)+1\n', settings)
    expect(safe.left[0]!.equivalenceKey).toBe(safe.right[0]!.equivalenceKey)

    const indentation = prepareWorkspaceComparisonInputs('if ready:\n    run()\n', 'if ready:\n\trun()\n', settings)
    expect(indentation.left[1]!.equivalenceKey).not.toBe(indentation.right[1]!.equivalenceKey)

    for (const [left, right, line] of [
      ['value = "a b"\n', 'value = "ab"\n', 0],
      ['value = """a\n b"""\n', 'value = """a\nb"""\n', 1],
      ['value = 1  # a b\n', 'value = 1 # ab\n', 0],
    ] as const) {
      const prepared = prepareWorkspaceComparisonInputs(left, right, settings)
      expect(prepared.left[line]!.equivalenceKey).not.toBe(prepared.right[line]!.equivalenceKey)
    }
  })

  it('keeps Lua string, long-string, and comment whitespace substantive while ignoring safe code spacing', () => {
    const settings = createDefaultWorkspaceComparisonSettings('main.lua')
    settings.ignoreWhitespace = true
    const safe = prepareWorkspaceComparisonInputs('local value = call(a, b) + 1  \n', 'local   value=call( a,b)+1\n', settings)
    expect(safe.left[0]!.equivalenceKey).toBe(safe.right[0]!.equivalenceKey)

    for (const [left, right, line] of [
      ['local value = "a b"\n', 'local value = "ab"\n', 0],
      ['local value = [[a\n b]]\n', 'local value = [[a\nb]]\n', 1],
      ['local value = 1 -- a b\n', 'local value = 1 -- ab\n', 0],
      ['--[[a\n b]]\n', '--[[a\nb]]\n', 1],
    ] as const) {
      const prepared = prepareWorkspaceComparisonInputs(left, right, settings)
      expect(prepared.left[line]!.equivalenceKey).not.toBe(prepared.right[line]!.equivalenceKey)
    }
  })

  it.each([
    ['main.cpp', 'int  value; /*\n', 'int value; /*\n'],
    ['check.py', 'value  = """unterminated\n', 'value = """unterminated\n'],
    ['main.lua', 'local  value = [[unterminated\n', 'local value = [[unterminated\n'],
  ])('fails whitespace comparison closed when %s lexing fails', (path, left, right) => {
    const settings = createDefaultWorkspaceComparisonSettings(path)
    settings.ignoreWhitespace = true
    const prepared = prepareWorkspaceComparisonInputs(left, right, settings)

    expect(prepared.diagnostics).toContain('lexer_fallback')
    expect(prepared.left[0]!.equivalenceKey).not.toBe(prepared.right[0]!.equivalenceKey)
    expect(prepared.left[0]!.comparisonEnding).toBe('\n')
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
