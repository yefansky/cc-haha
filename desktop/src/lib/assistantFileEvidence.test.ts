import { describe, expect, it } from 'vitest'
import { AssistantFileEvidenceIndex } from './assistantFileEvidence'

describe('chronological file evidence index', () => {
  it('uses cutoffs instead of copying accumulated files and appends incrementally', () => {
    const index = new AssistantFileEvidenceIndex()
    const messages = Array.from({ length: 1000 }, (_, n) => ({ id: `${n}`, revision: '1', files: [`G:/repo/${n}/index.md`] }))
    index.update(messages)
    expect(index.lookup('index.md', index.cutoff('0')!, true)).toEqual({ state: 'resolved', candidates: ['G:/repo/0/index.md'] })
    expect(index.lookup('index.md', 999, true).candidates).toHaveLength(1000)
    const originalMessageRevision = index.revisionFor('0')
    index.update([...messages, { id: '1000', revision: '1', files: ['G:/repo/next/readme.md'] }])
    expect(index.revisionFor('0')).toBe(originalMessageRevision)
    expect(index.metrics).toEqual({ rebuilds: 0, appendedMessages: 1001, indexedFiles: 1001 })
    index.update([...messages, { id: '1000', revision: '2', files: ['G:/repo/fixed/readme.md'] }])
    expect(index.metrics.rebuilds).toBe(1)
    expect(index.revisionFor('0')).not.toBe(originalMessageRevision)
    expect(index.lookup('next/readme.md', 1000, true).state).toBe('unresolved')
  })

  it('does not turn relative evidence into absolute paths or discard directory evidence', () => {
    const index = new AssistantFileEvidenceIndex()
    index.update([{ id: '1', revision: '1', files: ['lilin1/收件/a.md', 'G:/repo/yefan1/收件/a.md'] }])
    expect(index.size).toBe(1)
    expect(index.lookup('lilin1/收件/a.md', 0, true).state).toBe('unresolved')
    expect(index.lookup('G:/other/a.md', 0, true).state).toBe('unresolved')
    expect(index.lookup('a.md', 0, true).state).toBe('resolved')
  })

  it('preserves POSIX case and deduplicates Windows case', () => {
    const index = new AssistantFileEvidenceIndex()
    index.update([{ id: '1', revision: '1', files: ['/tmp/A.md', '/tmp/a.md', 'G:/repo/B.md', 'g:/REPO/b.md'] }])
    expect(index.size).toBe(3)
    expect(index.lookup('A.md', 0, false).candidates).toEqual(['/tmp/A.md'])
    expect(index.lookup('b.md', 0, true).candidates).toEqual(['G:/repo/B.md'])
  })

  it('does not rebuild for a streaming content revision when path evidence is unchanged', () => {
    const index = new AssistantFileEvidenceIndex()
    const messages = [{ id: '1', revision: 'paths-v1', files: ['G:/repo/a.md'] }]
    index.update(messages)
    const revision = index.revision
    for (let n = 0; n < 100; n++) index.update([{ ...messages[0]!, revision: `${n}` }])
    expect(index.revision).toBe(revision)
    expect(index.metrics.appendedMessages).toBe(1)
  })
})
