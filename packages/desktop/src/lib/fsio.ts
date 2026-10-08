// Mediabunny reads and writes files through Rust handles, so a multi-gigabyte recording
// never has to fit in memory on either side of the bridge.

import { CustomSource, type Source, type StreamTargetChunk } from 'mediabunny'

import {
  fsClose,
  fsCommit,
  fsCreate,
  fsDiscard,
  fsOpen,
  fsRead,
  fsWrite,
  type CommitResult,
  type ReadTarget,
  type WriteTarget,
} from './ipc.ts'

/** Largest single fs_read; bigger requests are streamed in pieces of this size. */
const READ_PIECE = 8 * 1024 * 1024
/** Bytes queued in a writable before Mediabunny is made to wait. */
const WRITE_HIGH_WATER = 16 * 1024 * 1024
/** Chunk size for StreamTargets created here; one fs_write per chunk. */
export const TARGET_CHUNK = 4 * 1024 * 1024

export interface FileSource {
  source: Source
  size: number
  /** Absolute path of the file being read. */
  path: string
  /** Releases the Rust handle; safe to call more than once. */
  close(): Promise<void>
}

export async function openSource(target: ReadTarget): Promise<FileSource> {
  const { handle, size, path } = await fsOpen(target)

  let closed: Promise<void> | null = null
  const close = () => (closed ??= fsClose(handle).catch(() => {}))

  const readExactly = async (start: number, end: number): Promise<Uint8Array> => {
    const bytes = new Uint8Array(await fsRead(handle, start, end - start))
    if (bytes.byteLength !== end - start) {
      throw new Error(
        'The file ended earlier than expected. It may have been changed while in use.',
      )
    }
    return bytes
  }

  const source = new CustomSource({
    getSize: () => size,
    read: (start, end) => {
      if (end - start <= READ_PIECE) return readExactly(start, end)
      let position = start
      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          const next = Math.min(end, position + READ_PIECE)
          controller.enqueue(await readExactly(position, next))
          position = next
          if (position >= end) controller.close()
        },
      })
    },
    dispose: () => void close(),
    // Each read is an IPC round trip, so sequential reads are worth prefetching aggressively.
    prefetchProfile: 'network',
    maxCacheSize: 32 * 1024 * 1024,
  })

  return { source, size, path, close }
}

export interface FileWriter {
  write(data: Uint8Array, position: number): Promise<void>
  /** Syncs and moves the file into place. */
  commit(): Promise<CommitResult>
  /** Deletes the partial file; safe to call after a failed commit. */
  discard(): Promise<void>
}

export async function createWriter(target: WriteTarget): Promise<FileWriter> {
  const { handle } = await fsCreate(target)
  let settled = false
  return {
    write: (data, position) => fsWrite(handle, position, data),
    commit: async () => {
      const result = await fsCommit(handle)
      settled = true
      return result
    },
    discard: async () => {
      if (settled) return
      settled = true
      await fsDiscard(handle).catch(() => {})
    },
  }
}

/**
 * A positioned-write stream for Mediabunny's StreamTarget. Closing it does not commit:
 * Mediabunny closes the stream on failure as well as on success, so the caller commits
 * once the muxer has finished and discards otherwise.
 */
export function writableFor(writer: FileWriter): WritableStream<StreamTargetChunk> {
  return new WritableStream<StreamTargetChunk>(
    { write: (chunk) => writer.write(chunk.data, chunk.position) },
    { highWaterMark: WRITE_HIGH_WATER, size: (chunk) => chunk.data.byteLength },
  )
}

/** Runs `produce` against a fresh writer, committing on success and discarding on failure. */
export async function writeFile(
  target: WriteTarget,
  produce: (writer: FileWriter) => Promise<void>,
): Promise<CommitResult> {
  const writer = await createWriter(target)
  try {
    await produce(writer)
    return await writer.commit()
  } catch (error) {
    await writer.discard()
    throw error
  }
}

/** Streams one file into another without holding it in memory. */
export async function copyFile(
  from: ReadTarget,
  to: WriteTarget,
  onProgress?: (fraction: number) => void,
): Promise<CommitResult> {
  const { handle, size } = await fsOpen(from)
  try {
    return await writeFile(to, async (writer) => {
      for (let offset = 0; offset < size; offset += READ_PIECE) {
        const bytes = new Uint8Array(
          await fsRead(handle, offset, Math.min(READ_PIECE, size - offset)),
        )
        if (bytes.byteLength === 0) break
        await writer.write(bytes, offset)
        onProgress?.(Math.min(1, (offset + bytes.byteLength) / size))
      }
    })
  } finally {
    await fsClose(handle).catch(() => {})
  }
}
