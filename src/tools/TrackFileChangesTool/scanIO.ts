import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve } from 'node:path'

// Shared across tool calls. Each traversal submits at most one operation at a
// time; a bounded queue prevents parallel command bursts from flooding the disk.
const CONCURRENCY = 2
const MAX_PENDING = 128
let active = 0
const queue: Array<() => void> = []
export function withScanIO<T>(operation: () => Promise<T>): Promise<T> {
  if (queue.length >= MAX_PENDING) return Promise.reject(new Error('File scan queue is busy; retry registration after pending scans finish'))
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++
      void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        active--
        queue.shift()?.()
      })
    }
    if (active < CONCURRENCY) run()
    else queue.push(run)
  })
}

const directoryReads = new Map<string, Promise<Dirent[]>>()
export function readScanDirectory(directory: string): Promise<Dirent[]> {
  const absolute = resolve(directory)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const pending = directoryReads.get(key)
  if (pending) return pending
  const request = withScanIO(() => readdir(directory, { withFileTypes: true }))
  directoryReads.set(key, request)
  void request.finally(() => { if (directoryReads.get(key) === request) directoryReads.delete(key) }).catch(() => {})
  return request
}
