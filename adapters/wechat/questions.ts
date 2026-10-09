/** Text-only presentation of AskUserQuestion; the underlying tool stays intact. */
export function withWechatInteractionHint(content: string): string {
  // Local slash commands must reach the server unchanged.
  if (content.trimStart().startsWith('/')) return content
  return `<wechat-interaction-context>
本条消息来自微信文字接入，当前轮次不支持交互卡片。需要澄清、选择或确认时，用纯文字写出问题、编号选项和建议，然后结束本轮等待用户文字回复；不要调用 AskUserQuestion 或其他依赖卡片点击的提问工具。权限审批仍按原有安全规则处理，不得自动批准或猜测用户答案。此约束仅适用于这条微信消息及其当前轮次，不改变 PC、远程网关或 H5 的卡片能力。
</wechat-interaction-context>\n\n${content}`
}

type Question = {
  question: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}
type PendingQuestion = {
  input: Record<string, unknown>
  questions: Question[]
  answers: Record<string, string>
  index: number
}
export type TextQuestionReply =
  | { kind: 'unhandled' }
  | { kind: 'text'; text: string }
  | { kind: 'answer'; requestId: string; updatedInput: Record<string, unknown> }

export class WechatQuestions {
  private pending = new Map<string, PendingQuestion>()
  private invalid = new Set<string>()

  has(requestId: string): boolean { return this.pending.has(requestId) || this.invalid.has(requestId) }
  delete(requestId: string): void { this.pending.delete(requestId); this.invalid.delete(requestId) }
  reconcile(requestIds: Set<string>): void {
    for (const id of [...this.pending.keys(), ...this.invalid]) {
      if (!requestIds.has(id)) this.delete(id)
    }
  }

  add(requestId: string, input: Record<string, unknown>): string {
    if (!this.pending.has(requestId)) {
      const questions = input?.questions as Question[]
      if (!Array.isArray(questions) || !questions.length || questions.some(q =>
        !q || typeof q.question !== 'string' || !q.question.trim() ||
        !Array.isArray(q.options) || q.options.some(o => !o || typeof o.label !== 'string'),
      )) {
        this.invalid.add(requestId)
        return `提问格式无法解析，请回复 /deny ${requestId} 让助手改用文字重新提问。`
      }
      this.pending.set(requestId, { input, questions, answers: {}, index: 0 })
    }
    return this.format(requestId)
  }

  private format(requestId: string): string {
    const pending = this.pending.get(requestId)!
    const q = pending.questions[pending.index]!
    return [
      `问题 ${pending.index + 1}/${pending.questions.length}：${q.question}`,
      ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? `：${o.description}` : ''}`),
      q.multiSelect ? '可多选，编号用逗号分隔；也可直接输入自定义答案。' : '回复选项编号或直接输入自定义答案。',
      `有多个待确认请求时，请用 /answer ${requestId} <答案>。`,
      `取消提问：/deny ${requestId}。此处的编号是答案，不是权限审批。`,
    ].join('\n\n')
  }

  reply(text: string, allowBareAnswer: boolean): TextQuestionReply {
    const command = text.trim().match(/^\/answer\s+(\S+)\s+([\s\S]+)$/i)
    if (!command && text.trim().startsWith('/')) return { kind: 'unhandled' }
    if (!command && this.pending.size === 0) return { kind: 'unhandled' }
    if (!command && (!allowBareAnswer || this.pending.size !== 1)) {
      return { kind: 'text', text: '当前有多个待确认请求，请用 /answer <requestId> <答案> 回答问题，或用带 requestId 的权限命令审批。' }
    }
    const requestId = command?.[1] ?? this.pending.keys().next().value!
    const pending = this.pending.get(requestId)
    if (!pending) return { kind: 'text', text: this.invalid.has(requestId)
      ? `提问格式无法解析，请回复 /deny ${requestId} 让助手改用文字重新提问。`
      : `未找到待回答的问题：${requestId}` }
    const answer = (command?.[2] ?? text).trim()
    if (!answer) return { kind: 'text', text: this.format(requestId) }
    const q = pending.questions[pending.index]!
    let value = answer
    if (/^\d+(?:\s*[,，、]\s*\d+)*$/.test(answer)) {
      const indices = [...new Set(answer.split(/[,，、]/).map(n => Number(n.trim())))]
      if ((!q.multiSelect && indices.length !== 1) || indices.some(n => n < 1 || n > q.options.length)) {
        return { kind: 'text', text: `选项编号无效，请重新回答。\n\n${this.format(requestId)}` }
      }
      value = indices.map(n => q.options[n - 1]!.label).join(', ')
    }
    pending.answers[q.question] = value
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      return { kind: 'text', text: this.format(requestId) }
    }
    // Retain until the server acknowledges; a failed socket write can be retried.
    return { kind: 'answer', requestId, updatedInput: { ...pending.input, answers: { ...pending.answers } } }
  }
}
