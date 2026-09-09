import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'

/** Stage completely before touching an installed bundle; never delete it first. */
export async function stageGatewayBundle(source: string, destination: string, move: typeof rename = rename) {
  const parent = path.dirname(destination)
  await mkdir(parent, { recursive: true })
  const work = await mkdtemp(path.join(parent, '.gateway-stage-'))
  const prepared = path.join(work, 'prepared')
  const previous = path.join(work, 'previous')
  let keepRecovery = false
  let movedPrevious = false
  try {
    await cp(source, prepared, { recursive: true, errorOnExist: true, force: false })
    try {
      await move(destination, previous)
      movedPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await move(prepared, destination)
    } catch (error) {
      if (movedPrevious) {
        try { await move(previous, destination) } catch {
          keepRecovery = true
          throw new Error(`Bundle switch failed; previous bundle retained at ${previous}`, { cause: error })
        }
      }
      throw error
    }
  } finally {
    if (!keepRecovery) {
      // A locked old bundle may remain as a recoverable backup. Do not force
      // a running process to stop just to remove its previous installation.
      await rm(work, { recursive: true, force: true }).catch(() => {
        console.warn(`Gateway staging backup retained at ${work}`)
      })
    }
  }
}
