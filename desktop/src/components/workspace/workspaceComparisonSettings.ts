export type WorkspaceComparisonProfile = 'fast' | 'balanced' | 'precise'
export type WorkspaceComparisonLanguage = 'text' | 'cpp'
export type WorkspaceComparisonRuleScope =
  | 'line'
  | 'keyword'
  | 'identifier'
  | 'number'
  | 'string'
  | 'preprocessor'
  | 'comment'
  | 'operator'
  | 'whitespace'
export type WorkspaceComparisonRuleEffect = 'important' | 'ignore'

export interface WorkspaceComparisonRule {
  id: string
  name: string
  enabled: boolean
  pattern: string
  caseSensitive: boolean
  scope: WorkspaceComparisonRuleScope
  effect: WorkspaceComparisonRuleEffect
  priority: number
}

export interface WorkspaceComparisonSettings {
  schemaVersion: 1
  profile: WorkspaceComparisonProfile
  ignoreWhitespace: boolean
  ignoreCase: boolean
  language: WorkspaceComparisonLanguage
  rules: WorkspaceComparisonRule[]
}

export const WORKSPACE_COMPARISON_RULE_LIMITS = {
  maxRules: 32,
  maxNameLength: 80,
  maxPatternLength: 256,
  maxStatesPerRule: 256,
  maxEnabledStates: 4096,
  maxRepeat: 32,
  maxTargetLength: 16 * 1024,
  maxScopedTargetLength: 2 * 1024 * 1024,
  maxMatchesPerTarget: 128,
  maxTransitions: 5_000_000,
} as const

export function simpleWorkspaceCaseFold(value: string): string {
  return [...value].map((character) => {
    const upper = character.toUpperCase()
    if ([...upper].length === 1) {
      const folded = upper.toLowerCase()
      if ([...folded].length === 1) return folded
    }
    const lower = character.toLowerCase()
    return [...lower].length === 1 ? lower : character
  }).join('')
}

export function createDefaultWorkspaceComparisonSettings(path = ''): WorkspaceComparisonSettings {
  return {
    schemaVersion: 1,
    profile: 'balanced',
    ignoreWhitespace: false,
    ignoreCase: false,
    language: /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm)$/i.test(path) ? 'cpp' : 'text',
    rules: [],
  }
}

type CharacterTest = (value: string) => boolean
type Ast =
  | { kind: 'empty' }
  | { kind: 'consume'; test: CharacterTest }
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'sequence'; children: Ast[] }
  | { kind: 'alternate'; children: Ast[] }
  | { kind: 'repeat'; child: Ast; min: number; max: number | null }

interface PatchPoint { state: number; slot: 'out' | 'out1' | 'out2' }
type NfaState =
  | { kind: 'consume'; test: CharacterTest; out: number }
  | { kind: 'split'; out1: number; out2: number }
  | { kind: 'start' | 'end'; out: number }
  | { kind: 'match' }
interface Fragment { start: number; outs: PatchPoint[] }

class PatternParser {
  private index = 0
  constructor(private readonly value: string, private readonly caseSensitive: boolean) {}

  parse(): Ast {
    const ast = this.alternate()
    if (this.index !== this.value.length) this.fail('unexpected token')
    return ast
  }

  private alternate(): Ast {
    const children = [this.sequence()]
    while (this.peek() === '|') {
      this.index += 1
      children.push(this.sequence())
    }
    return children.length === 1 ? children[0]! : { kind: 'alternate', children }
  }

  private sequence(): Ast {
    const children: Ast[] = []
    while (this.index < this.value.length && this.peek() !== ')' && this.peek() !== '|') {
      children.push(this.quantified())
    }
    if (children.length === 0) return { kind: 'empty' }
    return children.length === 1 ? children[0]! : { kind: 'sequence', children }
  }

  private quantified(): Ast {
    const child = this.atom()
    const token = this.peek()
    if (token === '*' || token === '+' || token === '?') {
      this.index += 1
      return {
        kind: 'repeat', child,
        min: token === '+' ? 1 : 0,
        max: token === '?' ? 1 : null,
      }
    }
    if (token !== '{') return child
    const start = this.index
    this.index += 1
    const min = this.integer()
    let max: number | null = min
    if (this.peek() === ',') {
      this.index += 1
      max = this.peek() === '}' ? null : this.integer()
    }
    if (this.peek() !== '}') this.fail('unterminated repeat', start)
    this.index += 1
    if (min > WORKSPACE_COMPARISON_RULE_LIMITS.maxRepeat || (max !== null && max > WORKSPACE_COMPARISON_RULE_LIMITS.maxRepeat)) {
      this.fail('repeat exceeds limit', start)
    }
    if (max !== null && max < min) this.fail('invalid repeat range', start)
    return { kind: 'repeat', child, min, max }
  }

  private atom(): Ast {
    const start = this.index
    const token = this.value[this.index++]
    if (token === undefined) this.fail('missing atom', start)
    if (token === '(') {
      if (this.value.startsWith('?:', this.index)) this.index += 2
      else if (this.peek() === '?') this.fail('lookaround and special groups are not supported', start)
      const child = this.alternate()
      if (this.peek() !== ')') this.fail('unterminated group', start)
      this.index += 1
      return child
    }
    if (token === '[') return this.characterClass(start)
    if (token === '.') return { kind: 'consume', test: () => true }
    if (token === '^') return { kind: 'start' }
    if (token === '$') return { kind: 'end' }
    if (token === '\\') return { kind: 'consume', test: this.escape(start) }
    if ('*+?{})'.includes(token)) this.fail('unexpected quantifier', start)
    return { kind: 'consume', test: this.literalTest(token) }
  }

  private characterClass(start: number): Ast {
    let negate = false
    if (this.peek() === '^') { negate = true; this.index += 1 }
    const tests: CharacterTest[] = []
    let sawValue = false
    while (this.index < this.value.length && this.peek() !== ']') {
      sawValue = true
      const first = this.classCharacter(start)
      if (this.peek() === '-' && this.value[this.index + 1] !== ']') {
        this.index += 1
        const last = this.classCharacter(start)
        const left = this.normalize(first)
        const right = this.normalize(last)
        if (left.codePointAt(0)! > right.codePointAt(0)!) this.fail('invalid character range', start)
        tests.push((value) => {
          const code = this.normalize(value).codePointAt(0)!
          return code >= left.codePointAt(0)! && code <= right.codePointAt(0)!
        })
      } else {
        tests.push(this.literalTest(first))
      }
    }
    if (!sawValue || this.peek() !== ']') this.fail('unterminated character class', start)
    this.index += 1
    return { kind: 'consume', test: (value) => negate !== tests.some((test) => test(value)) }
  }

  private classCharacter(start: number) {
    const value = this.value[this.index++]
    if (value === undefined) this.fail('unterminated character class', start)
    if (value !== '\\') return value
    const escaped = this.value[this.index++]
    if (escaped === undefined || 'dDsSwW'.includes(escaped)) this.fail('class escapes are not supported inside ranges', start)
    return escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped
  }

  private escape(start: number): CharacterTest {
    const value = this.value[this.index++]
    if (value === undefined) this.fail('dangling escape', start)
    if (/^[1-9]$/.test(value)) this.fail('backreferences are not supported', start)
    if (value === 'd') return (character) => character >= '0' && character <= '9'
    if (value === 'D') return (character) => character < '0' || character > '9'
    if (value === 's') return (character) => character === ' ' || character === '\t' || character === '\r' || character === '\n'
    if (value === 'S') return (character) => character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n'
    if (value === 'w') return (character) => /[A-Za-z0-9_]/.test(character)
    if (value === 'W') return (character) => !/[A-Za-z0-9_]/.test(character)
    return this.literalTest(value === 'n' ? '\n' : value === 'r' ? '\r' : value === 't' ? '\t' : value)
  }

  private integer() {
    const start = this.index
    while (/\d/.test(this.peek() ?? '')) this.index += 1
    if (start === this.index) this.fail('repeat count required', start)
    return Number(this.value.slice(start, this.index))
  }

  private literalTest(expected: string): CharacterTest {
    const normalized = this.normalize(expected)
    return (value) => this.normalize(value) === normalized
  }

  private normalize(value: string) { return this.caseSensitive ? value : simpleWorkspaceCaseFold(value) }
  private peek() { return this.value[this.index] }
  private fail(message: string, offset = this.index): never {
    const error = new Error(message) as Error & { offset: number }
    error.offset = offset
    throw error
  }
}

function nullable(ast: Ast): boolean {
  if (ast.kind === 'empty' || ast.kind === 'start' || ast.kind === 'end') return true
  if (ast.kind === 'consume') return false
  if (ast.kind === 'sequence') return ast.children.every(nullable)
  if (ast.kind === 'alternate') return ast.children.some(nullable)
  return ast.min === 0 || nullable(ast.child)
}

class NfaCompiler {
  readonly states: NfaState[] = []

  compile(ast: Ast): { states: NfaState[]; start: number } {
    const fragment = this.fragment(ast)
    const match = this.push({ kind: 'match' })
    this.patch(fragment.outs, match)
    return { states: this.states, start: fragment.start }
  }

  private fragment(ast: Ast): Fragment {
    if (ast.kind === 'empty') {
      const state = this.push({ kind: 'split', out1: -1, out2: -1 })
      return { start: state, outs: [{ state, slot: 'out1' }] }
    }
    if (ast.kind === 'consume') {
      const state = this.push({ kind: 'consume', test: ast.test, out: -1 })
      return { start: state, outs: [{ state, slot: 'out' }] }
    }
    if (ast.kind === 'start' || ast.kind === 'end') {
      const state = this.push({ kind: ast.kind, out: -1 })
      return { start: state, outs: [{ state, slot: 'out' }] }
    }
    if (ast.kind === 'sequence') return this.sequence(ast.children.map((child) => this.fragment(child)))
    if (ast.kind === 'alternate') {
      const fragments = ast.children.map((child) => this.fragment(child))
      let result = fragments[0]!
      for (const next of fragments.slice(1)) {
        const state = this.push({ kind: 'split', out1: result.start, out2: next.start })
        result = { start: state, outs: [...result.outs, ...next.outs] }
      }
      return result
    }
    const required = Array.from({ length: ast.min }, () => this.fragment(ast.child))
    let result = required.length > 0 ? this.sequence(required) : this.fragment({ kind: 'empty' })
    if (ast.max === null) {
      const repeated = this.fragment(ast.child)
      const split = this.push({ kind: 'split', out1: repeated.start, out2: -1 })
      this.patch(result.outs, split)
      this.patch(repeated.outs, split)
      result = { start: result.start, outs: [{ state: split, slot: 'out2' }] }
    } else {
      for (let index = ast.min; index < ast.max; index += 1) {
        const optional = this.fragment(ast.child)
        const split = this.push({ kind: 'split', out1: optional.start, out2: -1 })
        this.patch(result.outs, split)
        result = { start: result.start, outs: [...optional.outs, { state: split, slot: 'out2' }] }
      }
    }
    return result
  }

  private sequence(fragments: Fragment[]): Fragment {
    if (fragments.length === 0) return this.fragment({ kind: 'empty' })
    for (let index = 0; index < fragments.length - 1; index += 1) {
      this.patch(fragments[index]!.outs, fragments[index + 1]!.start)
    }
    return { start: fragments[0]!.start, outs: fragments.at(-1)!.outs }
  }

  private push(state: NfaState) {
    if (this.states.length >= WORKSPACE_COMPARISON_RULE_LIMITS.maxStatesPerRule) throw new Error('pattern state limit exceeded')
    return this.states.push(state) - 1
  }

  private patch(points: PatchPoint[], target: number) {
    for (const point of points) (this.states[point.state] as unknown as Record<string, number>)[point.slot] = target
  }
}

export interface WorkspaceRuleMatchSpan { start: number; end: number }
export type WorkspaceRuleMatchResult =
  | { state: 'ok'; spans: WorkspaceRuleMatchSpan[]; transitions: number }
  | { state: 'budget_exceeded'; spans: []; transitions: number }

export interface CompiledWorkspaceRulePattern {
  stateCount: number
  findMatches(value: string, budget?: { transitions: number; matches: number }): WorkspaceRuleMatchResult
}

function createMatcher(states: NfaState[], startState: number): CompiledWorkspaceRulePattern {
  return {
    stateCount: states.length,
    findMatches(value, budget = { transitions: WORKSPACE_COMPARISON_RULE_LIMITS.maxTransitions, matches: WORKSPACE_COMPARISON_RULE_LIMITS.maxMatchesPerTarget }) {
      let transitions = 0
      const spans: WorkspaceRuleMatchSpan[] = []
      const closure = (initial: number[], position: number) => {
        const result: number[] = []
        const pending = [...initial]
        const seen = new Set<number>()
        while (pending.length > 0) {
          const index = pending.pop()!
          if (seen.has(index)) continue
          seen.add(index)
          transitions += 1
          if (transitions > budget.transitions) return null
          const state = states[index]!
          if (state.kind === 'split') {
            if (state.out2 >= 0) pending.push(state.out2)
            if (state.out1 >= 0) pending.push(state.out1)
          } else if (state.kind === 'start') {
            if (position === 0) pending.push(state.out)
          } else if (state.kind === 'end') {
            if (position === value.length) pending.push(state.out)
          } else result.push(index)
        }
        return result
      }
      let from = 0
      while (from < value.length) {
        let active = closure([startState], from)
        if (!active) return { state: 'budget_exceeded', spans: [], transitions }
        let bestEnd = active.some((index) => states[index]!.kind === 'match') ? from : -1
        let position = from
        while (active.length > 0 && position < value.length) {
          const next: number[] = []
          for (const index of active) {
            const state = states[index]!
            transitions += 1
            if (transitions > budget.transitions) return { state: 'budget_exceeded', spans: [], transitions }
            if (state.kind === 'consume' && state.test(value[position]!)) next.push(state.out)
          }
          position += 1
          active = closure(next, position)
          if (!active) return { state: 'budget_exceeded', spans: [], transitions }
          if (active.some((index) => states[index]!.kind === 'match')) bestEnd = position
        }
        if (bestEnd > from) {
          if (spans.length >= budget.matches) {
            return { state: 'budget_exceeded', spans: [], transitions }
          }
          spans.push({ start: from, end: bestEnd })
          from = bestEnd
        } else from += 1
      }
      return { state: 'ok', spans, transitions }
    },
  }
}

export type WorkspaceRuleCompileResult =
  | { state: 'ok'; compiled: CompiledWorkspaceRulePattern }
  | { state: 'error'; message: string; offset: number }

export function compileWorkspaceRulePattern(pattern: string, caseSensitive: boolean): WorkspaceRuleCompileResult {
  if (pattern.length === 0) return { state: 'error', message: 'pattern is empty', offset: 0 }
  if (pattern.length > WORKSPACE_COMPARISON_RULE_LIMITS.maxPatternLength) {
    return { state: 'error', message: 'pattern is too long', offset: WORKSPACE_COMPARISON_RULE_LIMITS.maxPatternLength }
  }
  try {
    const ast = new PatternParser(pattern, caseSensitive).parse()
    if (nullable(ast)) return { state: 'error', message: 'pattern must consume text', offset: 0 }
    const compiler = new NfaCompiler()
    const { states, start } = compiler.compile(ast)
    return { state: 'ok', compiled: createMatcher(states, start) }
  } catch (error) {
    return {
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
      offset: typeof (error as { offset?: unknown })?.offset === 'number' ? (error as { offset: number }).offset : 0,
    }
  }
}

export type WorkspaceComparisonSettingsValidation =
  | { state: 'ok'; compiledRules: Map<string, CompiledWorkspaceRulePattern> }
  | { state: 'error'; code: 'too_many_rules' | 'invalid_rule'; ruleId?: string; message: string; offset?: number }

export function validateWorkspaceComparisonSettings(settings: WorkspaceComparisonSettings): WorkspaceComparisonSettingsValidation {
  if (settings.rules.length > WORKSPACE_COMPARISON_RULE_LIMITS.maxRules) {
    return { state: 'error', code: 'too_many_rules', message: `at most ${WORKSPACE_COMPARISON_RULE_LIMITS.maxRules} rules are allowed` }
  }
  const compiledRules = new Map<string, CompiledWorkspaceRulePattern>()
  let states = 0
  for (const rule of settings.rules) {
    if (!rule.enabled) continue
    if (!rule.name.trim() || rule.name.length > WORKSPACE_COMPARISON_RULE_LIMITS.maxNameLength) {
      return { state: 'error', code: 'invalid_rule', ruleId: rule.id, message: 'invalid rule name' }
    }
    const compiled = compileWorkspaceRulePattern(rule.pattern, rule.caseSensitive)
    if (compiled.state === 'error') return { state: 'error', code: 'invalid_rule', ruleId: rule.id, message: compiled.message, offset: compiled.offset }
    states += compiled.compiled.stateCount
    if (states > WORKSPACE_COMPARISON_RULE_LIMITS.maxEnabledStates) {
      return { state: 'error', code: 'invalid_rule', ruleId: rule.id, message: 'enabled rule state budget exceeded' }
    }
    compiledRules.set(rule.id, compiled.compiled)
  }
  return { state: 'ok', compiledRules }
}

export function cloneWorkspaceComparisonSettings(settings: WorkspaceComparisonSettings): WorkspaceComparisonSettings {
  return { ...settings, rules: settings.rules.map((rule) => ({ ...rule })) }
}

export function normalizeWorkspaceComparisonRulePriorities(rules: WorkspaceComparisonRule[]) {
  return rules.map((rule, index) => ({ ...rule, priority: rules.length - index }))
}
