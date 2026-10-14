import { expect, test } from 'bun:test'
import { collectProcessDiagnostics, projectProcessTree } from './processDiagnostics.js'

test('keeps Git credential ancestry without raw paths, arguments, unrelated names or cyclic loops', () => {
  const tree = projectProcessTree([
    { Name: 'git-credential-manager.exe', ProcessId: 30, ParentProcessId: 20, CommandLine: 'Bearer PRIVATE_TOKEN', ExecutablePath: 'C:\\private\\secret.exe' },
    { Name: 'git.exe', ProcessId: 20, ParentProcessId: 10 },
    { Name: 'private-project-runner.exe', ProcessId: 10, ParentProcessId: 10 },
    { Name: 'private-unrelated.exe', ProcessId: 40, ParentProcessId: 0 },
    { Name: 'git.exe', ProcessId: 'bad', ParentProcessId: 1 },
  ])
  expect(tree).toEqual([{ name: 'other_process', pid: 10, ppid: 10 }, { name: 'git.exe', pid: 20, ppid: 10 }, { name: 'git-credential-manager.exe', pid: 30, ppid: 20 }])
  expect(JSON.stringify(tree)).not.toContain('PRIVATE_TOKEN')
  expect(JSON.stringify(tree)).not.toContain('private')
})

test('records collection failure and unsupported platforms without breaking export', async () => {
  expect((await collectProcessDiagnostics('win32', async () => { throw new Error('private failure') })).status).toBe('unavailable')
  expect((await collectProcessDiagnostics('linux', async () => { throw new Error('must not run') })).status).toBe('unsupported_platform')
  const snapshot = await collectProcessDiagnostics('win32', async () => JSON.stringify([{ Name: 'git.exe', ProcessId: 10, ParentProcessId: 0 }]))
  expect(snapshot.status).toBe('captured')
  expect(snapshot.processes).toEqual([{ name: 'git.exe', pid: 10, ppid: 0 }])
})
