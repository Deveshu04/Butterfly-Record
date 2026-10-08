/// <reference lib="webworker" />
// createSyncAccessHandle() exists only in dedicated workers, and its blocking
// writes must stay off the thread running MediaRecorder.

import type { WriterRequest, WriterResponse } from '../writer-protocol.ts'

let handle: FileSystemSyncAccessHandle | null = null
let path: string[] | null = null
let offset = 0

function reply(response: WriterResponse): void {
  ;(self as DedicatedWorkerGlobalScope).postMessage(response)
}

function fail(id: number, error: unknown): void {
  const name = error instanceof DOMException || error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  reply({ id, type: 'error', name, message, bytesWritten: offset })
}

async function open(request: Extract<WriterRequest, { type: 'open' }>): Promise<void> {
  let dir = await navigator.storage.getDirectory()
  for (const segment of request.path.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: true })
  }
  const file = await dir.getFileHandle(request.path[request.path.length - 1]!, { create: true })
  handle = await file.createSyncAccessHandle()
  // A leftover part file from a crashed session must not be appended to.
  handle.truncate(0)
  path = request.path
  offset = 0
}

async function removePartFile(): Promise<void> {
  if (!path) return
  try {
    let dir = await navigator.storage.getDirectory()
    for (const segment of path.slice(0, -1)) dir = await dir.getDirectoryHandle(segment)
    await dir.removeEntry(path[path.length - 1]!)
  } catch {
    // Discarding anyway; the orphan scan sweeps stale part files.
  }
}

self.onmessage = async (event: MessageEvent<WriterRequest>) => {
  const request = event.data

  try {
    switch (request.type) {
      case 'open': {
        await open(request)
        break
      }

      case 'write': {
        if (!handle) throw new Error('writer: write before open')
        // Throws QuotaExceededError when the disk fills; the sink maps it to SinkFullError.
        const written = handle.write(new Uint8Array(request.buffer), { at: offset })
        offset += written
        break
      }

      case 'flush': {
        if (!handle) throw new Error('writer: flush before open')
        handle.flush()
        break
      }

      case 'close': {
        if (handle) {
          handle.flush()
          handle.close()
          handle = null
        }
        break
      }

      case 'abort': {
        if (handle) {
          // No flush: the bytes are being thrown away.
          handle.close()
          handle = null
        }
        await removePartFile()
        offset = 0
        break
      }
    }

    reply({ id: request.id, type: 'ok', bytesWritten: offset })
  } catch (error) {
    // OPFS allows one sync access handle per file; a leaked one blocks finalize.
    if (request.type !== 'write' && handle) {
      try {
        handle.close()
      } catch {
        /* already closed */
      }
      handle = null
    }
    fail(request.id, error)
  }
}
