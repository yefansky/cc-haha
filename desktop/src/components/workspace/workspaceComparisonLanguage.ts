import {
  WORKSPACE_COMPARISON_RULE_LIMITS,
  simpleWorkspaceCaseFold,
  validateWorkspaceComparisonSettings,
  type WorkspaceComparisonRuleScope,
  type WorkspaceComparisonSettings,
} from './workspaceComparisonSettings'

export type WorkspaceComparisonTokenScope = Exclude<WorkspaceComparisonRuleScope, 'line'>
export type WorkspaceCppTokenScope = WorkspaceComparisonTokenScope

export interface WorkspaceComparisonToken {
  scope: WorkspaceComparisonTokenScope
  start: number
  end: number
}

export type WorkspaceCppLexResult =
  | { state: 'ok'; tokens: WorkspaceComparisonToken[] }
  | { state: 'error'; message: string; offset: number }

export type WorkspaceLanguageLexResult = WorkspaceCppLexResult

export interface PreparedWorkspaceComparisonLine {
  text: string
  ending: string
  lineNumber: number
  equivalenceKey: string
  comparisonEnding: string
  tokens: WorkspaceComparisonToken[]
}

export interface PreparedWorkspaceComparisonInputs {
  left: PreparedWorkspaceComparisonLine[]
  right: PreparedWorkspaceComparisonLine[]
  diagnostics: string[]
  transitions: number
}

const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
  'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit',
  'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long',
  'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public', 'register',
  'reinterpret_cast', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template',
  'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void',
  'volatile', 'wchar_t', 'while',
])

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
])

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if',
  'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
])

function isIdentifierStart(value: string) {
  const code = value.charCodeAt(0)
  return value === '_' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 128
}

function isIdentifierPart(value: string) {
  const code = value.charCodeAt(0)
  return isIdentifierStart(value) || (code >= 48 && code <= 57)
}

function isWhitespace(value: string) {
  const code = value.codePointAt(0) ?? -1
  return (code >= 0x0009 && code <= 0x000d)
    || code === 0x0020
    || code === 0x0085
    || code === 0x00a0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
}

function quotedEnd(value: string, index: number, quote: string) {
  let cursor = index + 1
  while (cursor < value.length) {
    if (value[cursor] === '\\') cursor += 2
    else if (value[cursor] === quote) return cursor + 1
    else cursor += 1
  }
  return -1
}

function tripleQuotedEnd(value: string, index: number, quote: string) {
  const delimiter = quote.repeat(3)
  let cursor = index + delimiter.length
  while (cursor < value.length) {
    if (value[cursor] === '\\') cursor += 2
    else if (value.startsWith(delimiter, cursor)) return cursor + delimiter.length
    else cursor += 1
  }
  return -1
}

function luaLongBracketEnd(value: string, index: number) {
  if (value[index] !== '[') return null
  let cursor = index + 1
  while (value[cursor] === '=') cursor += 1
  if (value[cursor] !== '[') return null
  const closing = `]${'='.repeat(cursor - index - 1)}]`
  const end = value.indexOf(closing, cursor + 1)
  return end < 0 ? -1 : end + closing.length
}

function rawStringEnd(value: string, index: number) {
  const delimiterStart = index + 2
  const paren = value.indexOf('(', delimiterStart)
  if (paren < 0 || paren - delimiterStart > 16) return -1
  const delimiter = value.slice(delimiterStart, paren)
  const closing = `)${delimiter}"`
  const end = value.indexOf(closing, paren + 1)
  return end < 0 ? -1 : end + closing.length
}

const CPP_OPERATORS = [
  '<=>', '>>=', '<<=', '->*', '...',
  '::', '->', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<', '>>', '.*', '##',
] as const

const PYTHON_OPERATORS = [
  '**=', '//=', '>>=', '<<=', '...',
  ':=', '==', '!=', '<=', '>=', '->', '+=', '-=', '*=', '/=', '%=', '@=', '&=', '|=', '^=',
  '**', '//', '<<', '>>',
] as const

const LUA_OPERATORS = ['...', '::', '//', '==', '~=', '<=', '>=', '<<', '>>', '..'] as const

type WorkspaceNumericLanguage = 'cpp' | 'python' | 'lua'

function isDecimalDigit(value: string) {
  return value >= '0' && value <= '9'
}

function isHexDigit(value: string) {
  return isDecimalDigit(value)
    || (value >= 'a' && value <= 'f')
    || (value >= 'A' && value <= 'F')
}

function scanDigitSequence(value: string, index: number, accepts: (character: string) => boolean) {
  let cursor = index
  while (cursor < value.length && (accepts(value[cursor]!) || value[cursor] === '_')) cursor += 1
  return cursor
}

function scanExponent(value: string, index: number, markers: string) {
  const marker = value[index]
  if (!marker || !markers.includes(marker)) return index
  let cursor = index + 1
  if (value[cursor] === '+' || value[cursor] === '-') cursor += 1
  if (!isDecimalDigit(value[cursor] ?? '')) return index
  return scanDigitSequence(value, cursor, isDecimalDigit)
}

function numericLiteralEnd(value: string, index: number, language: WorkspaceNumericLanguage) {
  let cursor = index
  let hexadecimal = false
  if (value[cursor] === '.') {
    cursor = scanDigitSequence(value, cursor + 1, isDecimalDigit)
  } else if (value.startsWith('0x', cursor) || value.startsWith('0X', cursor)) {
    hexadecimal = true
    cursor = scanDigitSequence(value, cursor + 2, isHexDigit)
    if (value[cursor] === '.' && value[cursor + 1] !== '.') {
      cursor = scanDigitSequence(value, cursor + 1, isHexDigit)
    }
  } else if (value.startsWith('0b', cursor) || value.startsWith('0B', cursor)) {
    cursor = scanDigitSequence(value, cursor + 2, (character) => character === '0' || character === '1')
  } else if (value.startsWith('0o', cursor) || value.startsWith('0O', cursor)) {
    cursor = scanDigitSequence(value, cursor + 2, (character) => character >= '0' && character <= '7')
  } else {
    cursor = scanDigitSequence(value, cursor, isDecimalDigit)
    if (value[cursor] === '.' && value[cursor + 1] !== '.') {
      cursor = scanDigitSequence(value, cursor + 1, isDecimalDigit)
    }
  }

  cursor = scanExponent(value, cursor, hexadecimal ? 'pP' : 'eE')
  if (language === 'cpp') {
    while (/[uUlLfFzZ]/.test(value[cursor] ?? '')) cursor += 1
  } else if (language === 'python' && /[jJ]/.test(value[cursor] ?? '')) {
    cursor += 1
  }
  return cursor
}

function cppDirectiveEnd(value: string, index: number) {
  let end = index
  while (end < value.length) {
    const newline = value.indexOf('\n', end)
    if (newline < 0) return value.length
    let cursor = newline - 1
    if (value[cursor] === '\r') cursor -= 1
    while (value[cursor] === ' ' || value[cursor] === '\t') cursor -= 1
    end = newline + 1
    if (value[cursor] !== '\\') return end
  }
  return end
}

function containsLineBreak(value: string, start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    if (value[index] === '\r' || value[index] === '\n') return true
  }
  return false
}

export function lexWorkspaceCpp(value: string): WorkspaceCppLexResult {
  const tokens: WorkspaceComparisonToken[] = []
  let index = 0
  let directivePrefixOnly = true
  const add = (scope: WorkspaceCppTokenScope, start: number, end: number) => {
    if (end <= start) return
    tokens.push({ scope, start, end })
    index = end
  }
  while (index < value.length) {
    const start = index
    const character = value[index]!
    if (directivePrefixOnly && (character === '#' || value.startsWith('%:', index))) {
      const end = cppDirectiveEnd(value, index)
      add('preprocessor', start, end)
      directivePrefixOnly = end > start && (value[end - 1] === '\n' || value[end - 1] === '\r')
      continue
    }
    if (value.startsWith('//', index)) {
      const newline = value.indexOf('\n', index + 2)
      add('comment', start, newline < 0 ? value.length : newline)
      continue
    }
    if (value.startsWith('/*', index)) {
      const closing = value.indexOf('*/', index + 2)
      if (closing < 0) return { state: 'error', message: 'unterminated block comment', offset: start }
      add('comment', start, closing + 2)
      if (containsLineBreak(value, start, closing + 2)) directivePrefixOnly = true
      continue
    }
    if (value.startsWith('R"', index)) {
      const end = rawStringEnd(value, index)
      if (end > 0) { add('string', start, end); directivePrefixOnly = false; continue }
      return { state: 'error', message: 'unterminated raw string', offset: start }
    }
    if (character === '"' || character === '\'') {
      const end = quotedEnd(value, index, character)
      if (end < 0) return { state: 'error', message: 'unterminated string', offset: start }
      add('string', start, end)
      directivePrefixOnly = false
      continue
    }
    if (isWhitespace(character)) {
      let end = index + 1
      while (end < value.length && isWhitespace(value[end]!)) end += 1
      add('whitespace', start, end)
      if (containsLineBreak(value, start, end)) directivePrefixOnly = true
      continue
    }
    if (isIdentifierStart(character)) {
      let end = index + 1
      while (end < value.length && isIdentifierPart(value[end]!)) end += 1
      const word = value.slice(start, end)
      add(CPP_KEYWORDS.has(word) ? 'keyword' : 'identifier', start, end)
      directivePrefixOnly = false
      continue
    }
    const code = character.charCodeAt(0)
    if ((code >= 48 && code <= 57) || (character === '.' && /[0-9]/.test(value[index + 1] ?? ''))) {
      const end = numericLiteralEnd(value, index, 'cpp')
      add('number', start, end)
      directivePrefixOnly = false
      continue
    }
    const operator = CPP_OPERATORS.find((candidate) => value.startsWith(candidate, index))
    add('operator', start, index + (operator?.length ?? 1))
    directivePrefixOnly = false
  }
  return { state: 'ok', tokens }
}

export function lexWorkspacePython(value: string): WorkspaceLanguageLexResult {
  const tokens: WorkspaceComparisonToken[] = []
  let index = 0
  const add = (scope: WorkspaceComparisonTokenScope, start: number, end: number) => {
    if (end <= start) return
    tokens.push({ scope, start, end })
    index = end
  }
  while (index < value.length) {
    const start = index
    const character = value[index]!
    if (character === '#') {
      const newline = value.indexOf('\n', index + 1)
      add('comment', start, newline < 0 ? value.length : newline)
      continue
    }
    if ((character === '"' || character === '\'') && value.startsWith(character.repeat(3), index)) {
      const end = tripleQuotedEnd(value, index, character)
      if (end < 0) return { state: 'error', message: 'unterminated triple string', offset: start }
      add('string', start, end)
      continue
    }
    if (character === '"' || character === '\'') {
      const end = quotedEnd(value, index, character)
      if (end < 0) return { state: 'error', message: 'unterminated string', offset: start }
      add('string', start, end)
      continue
    }
    if (isWhitespace(character)) {
      let end = index + 1
      while (end < value.length && isWhitespace(value[end]!)) end += 1
      add('whitespace', start, end)
      continue
    }
    if (isIdentifierStart(character)) {
      let end = index + 1
      while (end < value.length && isIdentifierPart(value[end]!)) end += 1
      const word = value.slice(start, end)
      add(PYTHON_KEYWORDS.has(word) ? 'keyword' : 'identifier', start, end)
      continue
    }
    const code = character.charCodeAt(0)
    if ((code >= 48 && code <= 57) || (character === '.' && /[0-9]/.test(value[index + 1] ?? ''))) {
      const end = numericLiteralEnd(value, index, 'python')
      add('number', start, end)
      continue
    }
    const operator = PYTHON_OPERATORS.find((candidate) => value.startsWith(candidate, index))
    add('operator', start, index + (operator?.length ?? 1))
  }
  return { state: 'ok', tokens }
}

export function lexWorkspaceLua(value: string): WorkspaceLanguageLexResult {
  const tokens: WorkspaceComparisonToken[] = []
  let index = 0
  const add = (scope: WorkspaceComparisonTokenScope, start: number, end: number) => {
    if (end <= start) return
    tokens.push({ scope, start, end })
    index = end
  }
  while (index < value.length) {
    const start = index
    const character = value[index]!
    if (value.startsWith('--', index)) {
      const longEnd = luaLongBracketEnd(value, index + 2)
      if (longEnd === -1) return { state: 'error', message: 'unterminated long comment', offset: start }
      if (longEnd !== null) {
        add('comment', start, longEnd)
      } else {
        const newline = value.indexOf('\n', index + 2)
        add('comment', start, newline < 0 ? value.length : newline)
      }
      continue
    }
    const longEnd = luaLongBracketEnd(value, index)
    if (longEnd === -1) return { state: 'error', message: 'unterminated long string', offset: start }
    if (longEnd !== null) {
      add('string', start, longEnd)
      continue
    }
    if (character === '"' || character === '\'') {
      const end = quotedEnd(value, index, character)
      if (end < 0) return { state: 'error', message: 'unterminated string', offset: start }
      add('string', start, end)
      continue
    }
    if (isWhitespace(character)) {
      let end = index + 1
      while (end < value.length && isWhitespace(value[end]!)) end += 1
      add('whitespace', start, end)
      continue
    }
    if (isIdentifierStart(character)) {
      let end = index + 1
      while (end < value.length && isIdentifierPart(value[end]!)) end += 1
      const word = value.slice(start, end)
      add(LUA_KEYWORDS.has(word) ? 'keyword' : 'identifier', start, end)
      continue
    }
    const code = character.charCodeAt(0)
    if ((code >= 48 && code <= 57) || (character === '.' && /[0-9]/.test(value[index + 1] ?? ''))) {
      const end = numericLiteralEnd(value, index, 'lua')
      add('number', start, end)
      continue
    }
    const operator = LUA_OPERATORS.find((candidate) => value.startsWith(candidate, index))
    add('operator', start, index + (operator?.length ?? 1))
  }
  return { state: 'ok', tokens }
}

interface RawLine { text: string; ending: string; lineNumber: number; start: number }

function splitContent(value: string): RawLine[] {
  const lines: RawLine[] = []
  let index = 0
  let lineNumber = 1
  while (index < value.length) {
    const start = index
    while (index < value.length && value[index] !== '\r' && value[index] !== '\n') index += 1
    const text = value.slice(start, index)
    let ending = ''
    if (value[index] === '\r' && value[index + 1] === '\n') { ending = '\r\n'; index += 2 }
    else if (value[index] === '\r' || value[index] === '\n') { ending = value[index]!; index += 1 }
    lines.push({ text, ending, lineNumber, start })
    lineNumber += 1
  }
  return lines
}

function lineTokens(lines: RawLine[], tokens: WorkspaceComparisonToken[]) {
  const groups = lines.map(() => [] as WorkspaceComparisonToken[])
  let lineIndex = 0
  for (const token of tokens) {
    while (lineIndex < lines.length) {
      const line = lines[lineIndex]!
      if (line.start + line.text.length + line.ending.length > token.start) break
      lineIndex += 1
    }
    let targetLine = lineIndex
    while (targetLine < lines.length && lines[targetLine]!.start < token.end) {
      const line = lines[targetLine]!
      const start = Math.max(token.start, line.start)
      const end = Math.min(token.end, line.start + line.text.length)
      if (end > start) groups[targetLine]!.push({
        scope: token.scope,
        start: start - line.start,
        end: end - line.start,
      })
      targetLine += 1
    }
    lineIndex = Math.max(lineIndex, targetLine - 1)
  }
  return groups
}

function trailingWhitespaceStart(text: string) {
  let index = text.length
  while (index > 0 && isWhitespace(text[index - 1]!)) index -= 1
  return index
}

function comparisonCharacter(
  character: string,
  effect: 'important' | 'ignore' | null,
  settings: WorkspaceComparisonSettings,
  globallyIgnored: boolean,
) {
  if (effect === 'ignore' || (effect !== 'important' && globallyIgnored)) return ''
  if (effect === 'important' || !settings.ignoreCase) return character
  return simpleWorkspaceCaseFold(character)
}

function buildEquivalenceKey(
  text: string,
  settings: WorkspaceComparisonSettings,
  tokens: WorkspaceComparisonToken[],
  effects: Array<'important' | 'ignore' | null> | null,
  allowWhitespaceIgnore: boolean,
) {
  const effectAt = (index: number) => effects?.[index] ?? null
  if (settings.ignoreWhitespace && allowWhitespaceIgnore && settings.language !== 'text') {
    let result = ''
    for (const token of tokens) {
      const safeWhitespace = token.scope === 'whitespace'
        && !(settings.language === 'python' && token.start === 0)
      let content = ''
      for (let index = token.start; index < token.end; index += 1) {
        content += comparisonCharacter(text[index]!, effectAt(index), settings, safeWhitespace)
      }
      if (!content) continue
      result += `${token.scope.length}:${token.scope}${content.length}:${content}`
    }
    return result
  }

  const trailingStart = settings.ignoreWhitespace && allowWhitespaceIgnore && settings.language === 'text'
    ? trailingWhitespaceStart(text)
    : text.length
  let result = ''
  for (let index = 0; index < text.length; index += 1) {
    result += comparisonCharacter(text[index]!, effectAt(index), settings, index >= trailingStart)
  }
  return result
}

function prepareSide(
  value: string,
  settings: WorkspaceComparisonSettings,
  tokenGroups: WorkspaceComparisonToken[][],
  compiledRules: ReturnType<typeof validateWorkspaceComparisonSettings> & { state: 'ok' },
  budget: { remaining: number; targetRemaining: number },
  allowWhitespaceIgnore: boolean,
) {
  const rawLines = splitContent(value)
  const prepared: PreparedWorkspaceComparisonLine[] = []
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const line = rawLines[lineIndex]!
    const tokens = tokenGroups[lineIndex] ?? []
    const owner = new Array<number>(line.text.length).fill(-1)
    const effect = new Array<'important' | 'ignore' | null>(line.text.length).fill(null)
    const ordered = settings.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.enabled)
      .sort((left, right) => right.rule.priority - left.rule.priority || left.index - right.index)
    for (const { rule, index: ruleIndex } of ordered) {
      const compiled = compiledRules.compiledRules.get(rule.id)
      if (!compiled) continue
      const targets = rule.scope === 'line'
        ? [{ start: 0, end: line.text.length }]
        : tokens.filter((token) => token.scope === rule.scope)
      for (const target of targets) {
        const targetLength = target.end - target.start
        if (targetLength > WORKSPACE_COMPARISON_RULE_LIMITS.maxTargetLength || targetLength > budget.targetRemaining) throw new Error('rule_budget')
        budget.targetRemaining -= targetLength
        const match = compiled.findMatches(line.text.slice(target.start, target.end), {
          transitions: budget.remaining,
          matches: WORKSPACE_COMPARISON_RULE_LIMITS.maxMatchesPerTarget,
        })
        budget.remaining -= match.transitions
        if (match.state === 'budget_exceeded' || budget.remaining < 0) throw new Error('rule_budget')
        for (const span of match.spans) {
          for (let offset = target.start + span.start; offset < target.start + span.end; offset += 1) {
            if (owner[offset] !== -1) continue
            owner[offset] = ruleIndex
            effect[offset] = rule.effect
          }
        }
      }
    }
    const equivalenceKey = buildEquivalenceKey(line.text, settings, tokens, effect, allowWhitespaceIgnore)
    prepared.push({
      ...line,
      equivalenceKey,
      comparisonEnding: settings.ignoreWhitespace && allowWhitespaceIgnore ? '' : line.ending,
      tokens,
    })
  }
  return prepared
}

function emptyTokens(value: string) {
  return splitContent(value).map(() => [] as WorkspaceComparisonToken[])
}

function tokensForBoth(leftValue: string, rightValue: string, settings: WorkspaceComparisonSettings) {
  if (settings.language === 'text') {
    return {
      left: emptyTokens(leftValue),
      right: emptyTokens(rightValue),
      diagnostics: [] as string[],
      allowWhitespaceIgnore: true,
    }
  }
  const lexer = settings.language === 'cpp'
    ? lexWorkspaceCpp
    : settings.language === 'python'
      ? lexWorkspacePython
      : lexWorkspaceLua
  const left = lexer(leftValue)
  const right = lexer(rightValue)
  if (left.state === 'error' || right.state === 'error') {
    return {
      left: emptyTokens(leftValue),
      right: emptyTokens(rightValue),
      diagnostics: ['lexer_fallback'],
      allowWhitespaceIgnore: false,
    }
  }
  return {
    left: lineTokens(splitContent(leftValue), left.tokens),
    right: lineTokens(splitContent(rightValue), right.tokens),
    diagnostics: [] as string[],
    allowWhitespaceIgnore: true,
  }
}

function withoutRules(
  value: string,
  settings: WorkspaceComparisonSettings,
  tokens: WorkspaceComparisonToken[][],
  allowWhitespaceIgnore: boolean,
) {
  return splitContent(value).map((line, index) => ({
    ...line,
    equivalenceKey: buildEquivalenceKey(
      line.text,
      settings,
      tokens[index] ?? [],
      null,
      allowWhitespaceIgnore,
    ),
    comparisonEnding: settings.ignoreWhitespace && allowWhitespaceIgnore ? '' : line.ending,
    tokens: tokens[index] ?? [],
  }))
}

export function prepareWorkspaceComparisonInputs(
  leftValue: string,
  rightValue: string,
  settings: WorkspaceComparisonSettings,
  limits: { transitions?: number; targetLength?: number } = {},
): PreparedWorkspaceComparisonInputs {
  const tokenized = tokensForBoth(leftValue, rightValue, settings)
  const leftTokens = tokenized.left
  const rightTokens = tokenized.right
  const allowWhitespaceIgnore = tokenized.allowWhitespaceIgnore
  const validation = validateWorkspaceComparisonSettings(settings)
  if (validation.state === 'error') {
    return {
      left: withoutRules(leftValue, settings, leftTokens, allowWhitespaceIgnore),
      right: withoutRules(rightValue, settings, rightTokens, allowWhitespaceIgnore),
      diagnostics: [...tokenized.diagnostics, 'rules_invalid'],
      transitions: 0,
    }
  }
  const initialTransitions = limits.transitions ?? WORKSPACE_COMPARISON_RULE_LIMITS.maxTransitions
  const budget = {
    remaining: initialTransitions,
    targetRemaining: limits.targetLength ?? WORKSPACE_COMPARISON_RULE_LIMITS.maxScopedTargetLength,
  }
  try {
    const left = prepareSide(leftValue, settings, leftTokens, validation, budget, allowWhitespaceIgnore)
    const right = prepareSide(rightValue, settings, rightTokens, validation, budget, allowWhitespaceIgnore)
    return { left, right, diagnostics: tokenized.diagnostics, transitions: initialTransitions - budget.remaining }
  } catch {
    return {
      left: withoutRules(leftValue, settings, leftTokens, allowWhitespaceIgnore),
      right: withoutRules(rightValue, settings, rightTokens, allowWhitespaceIgnore),
      diagnostics: [...tokenized.diagnostics, 'rules_skipped_budget'],
      transitions: initialTransitions - Math.max(0, budget.remaining),
    }
  }
}
