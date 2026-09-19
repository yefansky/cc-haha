import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { openLocalIndexDatabase } from './database.js'
import { createSessionIndex } from './sessionIndex.js'
import { createSessionProjector } from './sessionProjector.js'

test('actual existing SQLite index returns at most two scope rows and maps source identity with workdir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-sqlite-independent-'))
  const database = openLocalIndexDatabase({ path: path.join(root, 'index.sqlite') })
  try {
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: root })
    const sessionId = '98765432-1234-4234-8234-123456789abc'
    for (let i = 0; i < 4; i++) {
      const project = `project-${i}`
      const file = path.join(root, 'projects', project, `${sessionId}.jsonl`)
      const workDir = path.join(root, `work-${i}`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: `u-${i}`, sessionId, cwd: workDir, timestamp: '2026-09-18T00:00:00.000Z', message: { role: 'user', content: 'fixture' } }) + '\n')
      const stat = await fs.stat(file)
      await projector.projectSource({ path: file, sessionId, projectPath: project, fallbackCreatedAt: stat.birthtime.toISOString(), fallbackModifiedAt: stat.mtime.toISOString(), fallbackWorkDir: workDir, modifiedAtMs: stat.mtimeMs })
    }
    expect(index.findSessionFiles(sessionId)).toHaveLength(4)
    const snapshots = index.getWorkspaceSnapshots!(sessionId)!
    expect(snapshots).toHaveLength(2)
    for (const row of snapshots) {
      expect(row.projectDir).toBe(path.basename(path.dirname(row.filePath)))
      expect(row.workDir).toBe(path.join(root, row.projectDir.replace('project-', 'work-')))
      expect(row.source.path).toBe(row.filePath)
      expect(row.source.state).toBe('ready')
      expect(row.source.fingerprint).toStartWith('cc-haha-source-fingerprint:v2:')
      expect(row.source.indexedBytes).toBe(row.source.size)
    }
    expect(index.getWorkspaceSnapshots!('absent')).toEqual([])
    const plan = database.read(operation => operation.all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT source_files.*, sessions.work_dir FROM sessions JOIN source_files ON source_files.path = sessions.transcript_path WHERE sessions.session_id = ? LIMIT 2', sessionId))
    expect(plan.some(row => /SEARCH sessions USING INDEX/.test(row.detail))).toBe(true)
    expect(plan.some(row => /SCAN sessions/.test(row.detail))).toBe(false)
  } finally {
    database.close()
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('scope-sqlite-independent-')) throw new Error('Unsafe cleanup')
    await fs.rm(resolved, { recursive: true, force: true })
  }
})
