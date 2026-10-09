import { describe, expect, it } from 'bun:test'
import { WechatQuestions, withWechatInteractionHint } from '../questions.js'

const input = {
  questions: [{ question: '用哪种方案？', header: '方案', multiSelect: false,
    options: [{ label: '文字', description: '微信直接回答' }, { label: '卡片', description: '桌面选择' }] }],
  metadata: { source: 'test' },
}

describe('WeChat text questions', () => {
  it('presents the actual question/options and submits labels through updatedInput', () => {
    const questions = new WechatQuestions()
    expect(questions.add('ask', input)).toContain('微信直接回答')
    expect(questions.reply('2', true)).toEqual({ kind: 'answer', requestId: 'ask',
      updatedInput: { ...input, answers: { '用哪种方案？': '卡片' } } })
    expect(questions.has('ask')).toBe(true)
    questions.delete('ask')
    expect(questions.reply('2', true)).toEqual({ kind: 'unhandled' })
  })

  it('collects multiple questions in order, including multiple selections and free text', () => {
    const questions = new WechatQuestions()
    const multiple = { questions: [{ ...input.questions[0]!, multiSelect: true },
      { ...input.questions[0]!, question: '补充说明？' }] }
    questions.add('ask', multiple)
    expect(questions.reply('1，2', true).kind).toBe('text')
    expect(questions.reply('请保留 H5 卡片', true)).toEqual({ kind: 'answer', requestId: 'ask',
      updatedInput: { ...multiple, answers: { '用哪种方案？': '文字, 卡片', '补充说明？': '请保留 H5 卡片' } } })
    // Failed send can retry without losing the earlier answer.
    expect(questions.reply('请保留 H5 卡片', true).kind).toBe('answer')
  })

  it('rejects invalid selections without advancing or guessing an answer', () => {
    const questions = new WechatQuestions()
    questions.add('ask', input)
    for (const value of ['0', '3', '1,2']) {
      const result = questions.reply(value, true)
      expect(result.kind).toBe('text')
      if (result.kind === 'text') expect(result.text).toContain('编号无效')
    }
    expect(questions.reply('/answer ask 自定义答案', true).kind).toBe('answer')
  })

  it('requires request IDs when approvals or other questions are also pending', () => {
    const questions = new WechatQuestions()
    questions.add('ask', input)
    expect(questions.reply('1', false).kind).toBe('text')
    questions.add('other', input)
    expect(questions.reply('1', true).kind).toBe('text')
    expect(questions.reply('/answer other 1', false).kind).toBe('answer')
    expect(questions.reply('/allow ask', true).kind).toBe('unhandled')
    expect(questions.reply('/deny ask', true).kind).toBe('unhandled')
    expect(questions.reply('/answer missing 1', true).kind).toBe('text')
  })

  it('reconciles desktop answers and reset snapshots without consuming later chat', () => {
    const questions = new WechatQuestions()
    questions.add('old', input)
    questions.add('live', input)
    questions.reconcile(new Set(['live']))
    expect(questions.has('old')).toBe(false)
    questions.reconcile(new Set())
    expect(questions.reply('继续', true).kind).toBe('unhandled')
  })

  it('fails closed on malformed questions instead of granting an empty answer', () => {
    const questions = new WechatQuestions()
    expect(questions.add('broken', { questions: [{}] })).toContain('/deny broken')
    expect(questions.has('broken')).toBe(true)
    expect(questions.reply('/answer broken 1', true).kind).toBe('text')
  })

  it('scopes the channel hint to the current turn and preserves server slash commands', () => {
    expect(withWechatInteractionHint('我要选择方案')).toContain('不要调用 AskUserQuestion')
    expect(withWechatInteractionHint('我要选择方案')).toEndWith('我要选择方案')
    expect(withWechatInteractionHint('/clear')).toBe('/clear')
    expect(withWechatInteractionHint('/compact 补充要求')).toBe('/compact 补充要求')
  })
})
