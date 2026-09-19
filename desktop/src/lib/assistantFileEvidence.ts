/** A single chronological index. Message snapshots are integer cutoffs, never
 * copies of the accumulated files. This module performs no I/O. */
export type FileEvidenceMessage = { id: string; revision: string; files: readonly string[] }
export type FileEvidenceRecord = { path: string; firstSeen: number }
export type FileEvidenceMatch = { state: 'resolved' | 'ambiguous' | 'unresolved'; candidates: string[] }
export type MessageFileEvidence = { index: AssistantFileEvidenceIndex; cutoff: number; revision: string }

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
const absolute = (path: string) => /^(?:[A-Za-z]:\/|\/)/.test(path)
const key = (path: string) => /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path

export class AssistantFileEvidenceIndex {
  private messages: FileEvidenceMessage[] = []
  private records = new Map<string, FileEvidenceRecord>()
  private suffixes = new Map<string, FileEvidenceRecord[]>()
  private cutoffs = new Map<string, number>()
  private serial = 0
  private rebuildEpoch = 0
  /** Diagnostic work counters make quadratic snapshot regressions testable. */
  readonly metrics = { rebuilds: 0, appendedMessages: 0, indexedFiles: 0 }

  get revision() { return this.serial }
  get size() { return this.records.size }
  cutoff(messageId: string) { return this.cutoffs.get(messageId) }
  knownFiles(cutoff: number): string[] {
    return [...this.records.values()].filter((record) => record.firstSeen <= cutoff).map((record) => record.path)
  }
  /** Cache identity for one historical message. Appending future evidence does
   * not invalidate it; an edit/deletion that rebuilds the past does. */
  revisionFor(messageId: string): string | undefined {
    const cutoff = this.cutoffs.get(messageId)
    return cutoff === undefined ? undefined : `${this.rebuildEpoch}:${cutoff}`
  }

  update(messages: readonly FileEvidenceMessage[]): void {
    let prefix = 0
    while (prefix < this.messages.length && prefix < messages.length) {
      const old = this.messages[prefix]!
      const next = messages[prefix]!
      if (old.id !== next.id
        || old.files.length !== next.files.length
        || old.files.some((file, index) => file !== next.files[index])) break
      old.revision = next.revision
      prefix++
    }
    if (prefix === messages.length && prefix === this.messages.length) return
    // Edits/deletions can remove earlier evidence. Rebuild once, not once per
    // message. The normal append-only transcript only indexes the new suffix.
    if (prefix < this.messages.length) {
      this.records.clear(); this.suffixes.clear(); this.cutoffs.clear()
      this.messages = []
      prefix = 0
      this.metrics.rebuilds++
      this.rebuildEpoch++
    }
    this.serial++
    for (let ordinal = prefix; ordinal < messages.length; ordinal++) {
      const message = messages[ordinal]!
      this.cutoffs.set(message.id, ordinal)
      this.messages.push({ ...message, files: [...message.files] })
      this.metrics.appendedMessages++
      for (const raw of message.files) {
        const path = normalize(raw)
        if (!absolute(path) || this.records.has(key(path))) continue
        const record = { path, firstSeen: ordinal }
        this.records.set(key(path), record)
        this.metrics.indexedFiles++
        const parts = path.split('/').filter(Boolean)
        // Bounded suffix depth; absolute lookup remains exact at any depth.
        for (let length = 1; length <= Math.min(parts.length, 16); length++) {
          const suffix = parts.slice(-length).join('/')
          const suffixKey = /^[A-Za-z]:\//.test(path) ? suffix.toLowerCase() : suffix
          const entries = this.suffixes.get(suffixKey) ?? []
          entries.push(record)
          this.suffixes.set(suffixKey, entries)
        }
      }
    }
  }

  lookup(reference: string, cutoff: number, windows: boolean): FileEvidenceMatch {
    const path = normalize(reference).replace(/^\.\//, '')
    let records: FileEvidenceRecord[]
    if (absolute(path)) {
      const record = this.records.get(key(path))
      records = record ? [record] : []
    } else if (!path || path.startsWith('~') || path.split('/').includes('..')) {
      records = []
    } else {
      records = this.suffixes.get(windows ? path.toLowerCase() : path) ?? []
    }
    const candidates = records.filter((record) => record.firstSeen <= cutoff).map((record) => record.path)
    return { state: candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unresolved', candidates }
  }
}
