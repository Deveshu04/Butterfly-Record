/*
  Chunked MediaRecorder WebM has no Duration and no Cues, so it is unseekable
  (fragmented MP4 is no better: its mvhd duration is 0). This remuxes through
  Mediabunny without transcoding, rebuilding only the container index.
*/

import {
  ALL_FORMATS,
  Conversion,
  Input,
  Output,
  StreamTarget,
  UnsupportedInputFormatError,
  WebMOutputFormat,
  type Source,
  type StreamTargetChunk,
} from 'mediabunny'

import { InsufficientSpaceError } from './library.ts'
import {
  NEXT_SOURCE_FILE,
  PART_FILE,
  SOURCE_FILE,
  fileHandle,
  removeFile,
  sessionPath,
  storageBudget,
  uncommittedTarget,
  writeScratchFile,
} from './opfs.ts'
import { sourceForFile } from './source.ts'

export interface FinalizeResult {
  /** Seconds; 0 when unindexed. */
  duration: number
  bytes: number
  /** False when the remux failed and the unindexed raw capture was kept instead. */
  indexed: boolean
}

export interface FinalizeOptions {
  /** 0..1. Fires often; throttle before putting it on screen. */
  onProgress?: (progress: number) => void
}

export interface MediaProbe {
  /** Seconds; 0 when it cannot be determined. */
  duration: number
  /** Tracks this platform can decode. */
  tracks: number
}

/** The remux writes a full second copy next to the capture before the capture is deleted. */
const SPACE_HEADROOM = 1.1

/**
 * Packet-copy remux into an indexed WebM. Mediabunny closes `target` when it gives up as well
 * as when it finishes, so `target` must not commit on close: the caller commits once this
 * resolves and discards if it rejects.
 */
export async function remuxToWebm(
  input: Source,
  target: WritableStream<StreamTargetChunk>,
  options: { onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  const media = new Input({ source: input, formats: ALL_FORMATS })

  // Checked first, so a capture fault is not reported as a remux error.
  const tracks = await media.getTracks().catch(() => [])
  if (tracks.length === 0) {
    throw new Error('The recording could not be read back (no decodable tracks).')
  }

  const output = new Output({
    format: new WebMOutputFormat(),
    target: new StreamTarget(target, { chunked: true, chunkSize: 1 << 20 }),
  })

  const conversion = await Conversion.init({ input: media, output })
  if (!conversion.isValid) {
    await conversion.cancel().catch(() => {})
    const reasons = conversion.discardedTracks.map((track) => track.reason).join(', ')
    throw new Error(`The recording cannot be remuxed (${reasons || 'no usable tracks'}).`)
  }

  const { onProgress } = options
  if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction)

  await conversion.execute()
}

export async function probeMedia(input: Source): Promise<MediaProbe> {
  const media = new Input({ source: input, formats: ALL_FORMATS })

  const tracks = await media.getTracks().catch((error: unknown) => {
    if (error instanceof UnsupportedInputFormatError) {
      throw new Error('This file is not in a video or audio format that can be read.')
    }
    throw error
  })

  const decodable = await Promise.all(tracks.map((track) => track.canDecode()))
  return {
    duration: await durationOf(media),
    tracks: decodable.filter(Boolean).length,
  }
}

/**
 * Remuxes the session's part file into source.webm. The part file is deleted only once
 * source.webm is verified and in place; on any failure it is kept for recovery.
 */
export async function finalizeRecording(
  sessionId: string,
  options: FinalizeOptions = {},
): Promise<FinalizeResult> {
  const partPath = sessionPath(sessionId, PART_FILE)
  const nextPath = sessionPath(sessionId, NEXT_SOURCE_FILE)

  const partFile = await (await fileHandle(partPath)).getFile()
  if (partFile.size === 0) {
    throw new Error(`finalize: ${sessionId} captured no data`)
  }

  const required = Math.ceil(partFile.size * SPACE_HEADROOM)
  const { available } = await storageBudget()
  if (available < required) throw new InsufficientSpaceError(required, available)

  console.info(`[butterfly-record] finalizing ${sessionId}: ${partFile.size} bytes`)

  const remuxed = await writeScratchFile(nextPath, (writable) =>
    remuxToWebm(sourceForFile(partFile), uncommittedTarget(writable), options),
  )

  // Verify the output is playable before it replaces anything.
  const finished = new Input({ source: sourceForFile(remuxed), formats: ALL_FORMATS })
  const outputTracks = await finished.getTracks().catch(() => [])
  const duration = await durationOf(finished)

  if (remuxed.size === 0 || outputTracks.length === 0 || !(duration > 0)) {
    console.error('[butterfly-record] remux produced an unusable file', {
      bytes: remuxed.size,
      tracks: outputTracks.length,
      duration,
    })
    // Fall back to the raw capture: unseekable, but playable.
    const bytes = await salvageRawCapture(sessionId, partFile)
    await discardPart(partPath)
    return { duration: 0, bytes, indexed: false }
  }

  await promote(sessionId)
  console.info(
    `[butterfly-record] finalized ${sessionId}: ${remuxed.size} bytes, ${duration.toFixed(2)}s`,
  )
  await discardPart(partPath)

  return { duration, bytes: remuxed.size, indexed: true }
}

async function durationOf(media: Input): Promise<number> {
  const fromMetadata = await media.getDurationFromMetadata().catch(() => null)
  if (fromMetadata !== null && Number.isFinite(fromMetadata) && fromMetadata > 0) {
    return fromMetadata
  }
  return media.computeDuration().catch(() => 0)
}

async function salvageRawCapture(sessionId: string, partFile: File): Promise<number> {
  const nextPath = sessionPath(sessionId, NEXT_SOURCE_FILE)
  const copy = await writeScratchFile(nextPath, (writable) =>
    partFile.stream().pipeTo(writable, { preventClose: true }),
  )
  if (copy.size !== partFile.size) {
    await removeFile(nextPath).catch(() => {})
    throw new Error(
      `finalize: copying the raw capture of ${sessionId} stopped at ${copy.size} of ${partFile.size} bytes`,
    )
  }
  await promote(sessionId)
  return copy.size
}

/** FileSystemFileHandle.move() ships in Chromium but is missing from lib.dom. */
interface MovableFileHandle extends FileSystemFileHandle {
  move(newName: string): Promise<void>
}

async function promote(sessionId: string): Promise<void> {
  const nextPath = sessionPath(sessionId, NEXT_SOURCE_FILE)
  try {
    const next = (await fileHandle(nextPath)) as MovableFileHandle
    // An empty source.webm left by an interrupted finalize must not block the rename.
    await removeFile(sessionPath(sessionId, SOURCE_FILE))
    await next.move(SOURCE_FILE)
  } catch (error) {
    await removeFile(nextPath).catch(() => {})
    throw error
  }
}

/** source.webm is already in place, so a part file that will not delete only wastes space. */
async function discardPart(partPath: string[]): Promise<void> {
  try {
    await removeFile(partPath)
  } catch (error) {
    console.warn('[butterfly-record] could not delete the raw capture', error)
  }
}
