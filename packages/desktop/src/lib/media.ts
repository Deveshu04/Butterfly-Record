// Local media work on files in the library: finalizing recordings, probing imports,
// posters, and the audio plumbing around transcription and dubbing.

import { probeMedia, remuxToWebm } from '@butterfly-record/core/finalize'
import { extractAudio } from '@butterfly-record/core/transcribe'
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  CanvasSink,
  Conversion,
  ConversionCanceledError,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  UnsupportedInputFormatError,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  type InputAudioTrack,
  type InputFormat,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny'

import {
  TARGET_CHUNK,
  copyFile,
  openSource,
  writableFor,
  writeFile,
  type FileSource,
} from './fsio.ts'
import {
  fsUncommit,
  isIpcError,
  libraryInfo,
  sidecarRemove,
  sidecarWriteBytes,
  type CommitResult,
  type DesktopManifest,
  type ReadTarget,
  type WriteTarget,
} from './ipc.ts'
import { checkFinalizeSpace } from './library-rules.ts'
import { PART_NAME, POSTER_NAME, readManifest, updateManifest } from './manifests.ts'
import { splitIntoParts } from './timing.ts'
import { mediaBaseName } from './titles.ts'

export interface JobHooks {
  signal?: AbortSignal
  /** 0..1 */
  onProgress?: (fraction: number) => void
}

export interface MediaInfo {
  /** Absolute path of the probed file. */
  path: string
  size: number
  /** Short container name: webm, mp4, mov, mkv, mp3, wav, ogg, flac, aac. */
  container: string
  /** Seconds; 0 when unknown. */
  duration: number
  video: { codec: string; width: number; height: number; frameRate: number | null } | null
  audio: { codec: string; sampleRate: number; channels: number } | null
}

const CONTAINERS: Record<string, string> = {
  WebM: 'webm',
  MP4: 'mp4',
  'QuickTime File Format': 'mov',
  Matroska: 'mkv',
  MP3: 'mp3',
  WAVE: 'wav',
  Ogg: 'ogg',
  FLAC: 'flac',
  ADTS: 'aac',
}

interface OpenedInput {
  input: Input
  file: FileSource
  dispose(): Promise<void>
}

async function openInput(target: ReadTarget): Promise<OpenedInput> {
  const file = await openSource(target)
  const input = new Input({ source: file.source, formats: ALL_FORMATS })
  return {
    input,
    file,
    dispose: async () => {
      input.dispose()
      await file.close()
    },
  }
}

async function withInput<T>(
  target: ReadTarget,
  use: (input: Input, file: FileSource) => Promise<T>,
): Promise<T> {
  const opened = await openInput(target)
  try {
    return await use(opened.input, opened.file)
  } finally {
    await opened.dispose()
  }
}

async function durationOf(input: Input): Promise<number> {
  const fromMetadata = await input.getDurationFromMetadata().catch(() => null)
  if (fromMetadata !== null && Number.isFinite(fromMetadata) && fromMetadata > 0) {
    return fromMetadata
  }
  const computed = await input.computeDuration().catch(() => 0)
  return Number.isFinite(computed) ? computed : 0
}

function containerName(format: InputFormat): string {
  return CONTAINERS[format.name] ?? format.name.toLowerCase()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
}

/** Ties a Conversion to an AbortSignal, reporting cancellation as an AbortError. */
async function runConversion(
  conversion: Conversion,
  hooks: JobHooks,
  scale = { from: 0, to: 1 },
): Promise<void> {
  if (!conversion.isValid) {
    await conversion.cancel().catch(() => {})
    const reasons = conversion.discardedTracks.map((track) => track.reason).join(', ')
    throw new Error(`The audio could not be converted (${reasons || 'no usable audio'}).`)
  }
  const { signal, onProgress } = hooks
  if (onProgress) {
    const span = scale.to - scale.from
    conversion.onProgress = (fraction) => onProgress(scale.from + span * fraction)
  }
  const abort = () => void conversion.cancel()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    throwIfAborted(signal)
    await conversion.execute()
  } catch (error) {
    if (error instanceof ConversionCanceledError) throw new DOMException('Cancelled', 'AbortError')
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

/** Builds a file with a Mediabunny Output; the file only appears once `build` finalizes it. */
function produce(
  target: WriteTarget,
  format: OutputFormat,
  build: (output: Output) => Promise<void>,
): Promise<CommitResult> {
  return writeFile(target, async (writer) => {
    const output = new Output({
      format,
      target: new StreamTarget(writableFor(writer), { chunked: true, chunkSize: TARGET_CHUNK }),
    })
    try {
      await build(output)
    } catch (error) {
      if (output.state !== 'finalized') await output.cancel().catch(() => {})
      throw error
    }
  })
}

// Probing

export async function probeFile(target: ReadTarget): Promise<MediaInfo> {
  return withInput(target, async (input, file) => {
    let format: InputFormat
    try {
      format = await input.getFormat()
    } catch (error) {
      if (error instanceof UnsupportedInputFormatError) {
        throw new Error('This file is not in a video or audio format Butterfly Record can read.')
      }
      throw error
    }

    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()
    const video =
      videoTrack && (await videoTrack.canDecode())
        ? {
            codec: (await videoTrack.getCodec()) ?? 'unknown',
            width: await videoTrack.getDisplayWidth(),
            height: await videoTrack.getDisplayHeight(),
            frameRate: await videoTrack
              .computePacketStats(120)
              .then(({ averagePacketRate: rate }) =>
                rate > 0 ? Math.round(rate * 100) / 100 : null,
              )
              .catch(() => null),
          }
        : null
    const audio =
      audioTrack && (await audioTrack.canDecode())
        ? {
            codec: (await audioTrack.getCodec()) ?? 'unknown',
            sampleRate: await audioTrack.getSampleRate(),
            channels: await audioTrack.getNumberOfChannels(),
          }
        : null

    if (!video && !audio) {
      throw new Error(
        videoTrack || audioTrack
          ? 'This file uses a codec this PC cannot play.'
          : 'This file has no video or audio in it.',
      )
    }

    return {
      path: file.path,
      size: file.size,
      container: containerName(format),
      duration: await durationOf(input),
      video,
      audio,
    }
  })
}

// Finalizing recordings

export interface FinalizedMedia {
  duration: number
  bytes: number
  /** Absolute path of the finished file. */
  path: string
  /** False when the remux failed and the raw capture was saved as-is (plays, seeks poorly). */
  indexed: boolean
}

const finalizing = new Map<string, Promise<FinalizedMedia>>()

/** True while a recording or a recovery is being written out for `id`. */
export function isFinalizing(id: string): boolean {
  return finalizing.has(id)
}

export function anyFinalizing(): boolean {
  return finalizing.size > 0
}

const DISK_FILLED =
  'The disk filled up while saving this recording. The recording was kept. ' +
  'Free up space, then recover it from the library.'

function isDiskFull(error: unknown): boolean {
  return isIpcError(error) && error.code === 'disk_full'
}

/** Tracks this PC can decode, reading only as much of the file as identifying them takes. */
function decodableTracks(target: ReadTarget): Promise<number> {
  return withInput(target, async (input) => {
    const tracks = await input.getTracks().catch(() => [])
    const decodable = await Promise.all(tracks.map((track) => track.canDecode()))
    return decodable.filter(Boolean).length
  })
}

interface FinalizeOptions extends JobHooks {
  /** Merged into the manifest together with the media fields. */
  patch?: Partial<DesktopManifest>
  /** Seconds to record when the duration cannot be read from the file. */
  fallbackDuration?: number
}

/**
 * Turns <session>\source.part into the finished <title>.webm in the library root. The
 * manifest is updated before the part file is deleted, so a crash at any point leaves
 * either a recoverable part or a finished recording, never neither. Concurrent calls for
 * one id share a single run.
 */
export function finalizeSession(
  id: string,
  options: FinalizeOptions = {},
): Promise<FinalizedMedia> {
  const running = finalizing.get(id)
  if (running) return running
  const run = writeFinished(id, options).finally(() => finalizing.delete(id))
  finalizing.set(id, run)
  return run
}

async function writeFinished(id: string, options: FinalizeOptions): Promise<FinalizedMedia> {
  const manifest = await readManifest(id)
  if (!manifest) throw new Error('This recording has no readable manifest.')
  const baseName = mediaBaseName(options.patch?.title ?? manifest.title)
  const target: WriteTarget = { kind: 'media', id, baseName, ext: 'webm' }

  const part = await openSource({ kind: 'part', id })
  const partSize = part.size
  await part.close()
  if (partSize === 0) throw new Error('Nothing was recorded.')
  checkFinalizeSpace(partSize, await libraryInfo().then((info) => info.freeBytes, () => 0))

  let committed: CommitResult
  let indexed = true
  try {
    const source = await openSource({ kind: 'part', id })
    try {
      const progress = options.onProgress ? { onProgress: options.onProgress } : {}
      committed = await writeFile(target, (writer) =>
        remuxToWebm(source.source, writableFor(writer), progress),
      )
    } finally {
      await source.close()
    }
  } catch (error) {
    // A raw copy needs the same space again.
    if (isDiskFull(error)) throw new Error(DISK_FILLED)
    console.warn('[butterfly-record] remux failed; keeping the raw capture', error)
    // Copying a capture nothing can read would only leave an unplayable file in the folder.
    if ((await decodableTracks({ kind: 'part', id })) === 0) {
      throw new Error('This capture is damaged: no video or audio could be read from it.')
    }
    indexed = false
    committed = await copyFile({ kind: 'part', id }, target, options.onProgress).catch(
      (copyError: unknown) => {
        throw isDiskFull(copyError) ? new Error(DISK_FILLED) : copyError
      },
    )
  }

  let duration: number
  try {
    const probe = await openSource({ kind: 'path', path: committed.path })
    let verified
    try {
      verified = await probeMedia(probe.source)
    } finally {
      await probe.close()
    }
    if (verified.tracks === 0) {
      throw new Error('The finished recording could not be read back. The original capture was kept.')
    }
    duration = verified.duration > 0 ? verified.duration : (options.fallbackDuration ?? 0)
    await updateManifest(id, (current) => ({
      ...current,
      ...options.patch,
      status: 'ready',
      duration,
      bytes: committed.bytes,
      media: { path: committed.relPath ?? committed.path, external: false },
    }))
  } catch (error) {
    // The capture is kept for recovery, so a file no manifest points to would only be a duplicate.
    await fsUncommit(id, committed.path).catch((cleanup: unknown) =>
      console.warn('[butterfly-record] could not remove the unverified file', cleanup),
    )
    throw error
  }
  // The finished file is in place, so a part that will not delete only wastes space.
  await sidecarRemove(id, PART_NAME).catch((error: unknown) =>
    console.warn('[butterfly-record] could not delete the raw capture', error),
  )

  return { duration, bytes: committed.bytes, path: committed.path, indexed }
}

export async function recoverSession(id: string, hooks: JobHooks = {}): Promise<void> {
  // Already finished, e.g. by an earlier Recover: there is nothing to rebuild.
  if ((await readManifest(id))?.media) return
  await finalizeSession(id, hooks)
}

// Posters

const POSTER_FRACTION = 0.1
const POSTER_MAX_WIDTH = 640
const POSTER_QUALITY = 0.8

async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality: POSTER_QUALITY })
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', POSTER_QUALITY))
}

/** Writes poster.jpg from the frame at 10 %. Resolves false when there is no picture to take. */
export async function generatePoster(id: string): Promise<boolean> {
  try {
    const jpeg = await withInput({ kind: 'media', id }, async (input) => {
      const track = await input.getPrimaryVideoTrack()
      if (!track || !(await track.canDecode())) return null
      const width = Math.min(POSTER_MAX_WIDTH, await track.getDisplayWidth())
      const sink = new CanvasSink(track, { width })
      const start = await track.getFirstTimestamp()
      const end = await durationOf(input)
      const at = start + Math.max(0, end - start) * POSTER_FRACTION
      const frame = (await sink.getCanvas(at)) ?? (await sink.getCanvas(start))
      return frame ? canvasToJpeg(frame.canvas) : null
    })
    if (!jpeg) return false
    await sidecarWriteBytes(id, POSTER_NAME, new Uint8Array(await jpeg.arrayBuffer()))
    return true
  } catch (error) {
    console.warn('[butterfly-record] poster failed', error)
    return false
  }
}

// Audio for transcription

/** Saaras batch accepts up to two hours per file; parts stay comfortably below that. */
const STT_PART_SECONDS = 7000
const STT_BITRATE = 48_000

export interface SttAudio {
  /** Sidecar names, one per part. */
  files: string[]
  /** Start of each part on the source timeline, in seconds. */
  offsets: number[]
  duration: number
}

function sttPartName(index: number): string {
  return `tmp-stt-${index}.webm`
}

/**
 * Audio-only WebM/Opus parts for Saaras. Opus audio (every recording) is packet-copied;
 * anything else is transcoded to mono 48 kHz Opus.
 */
export async function extractSttAudio(id: string, hooks: JobHooks = {}): Promise<SttAudio> {
  return withInput({ kind: 'media', id }, async (input) => {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This video has no audio to transcribe.')
    const duration = await durationOf(input)
    const parts = splitIntoParts(duration, STT_PART_SECONDS)
    const files = parts.map((_, index) => sttPartName(index))

    try {
      if ((await track.getCodec()) === 'opus') {
        await copyOpusParts(id, track, parts, files, duration, hooks)
      } else {
        await transcodeParts(id, input, parts, files, hooks)
      }
    } catch (error) {
      // Parts finished before the failure are scratch files nobody will use.
      for (const name of files) await sidecarRemove(id, name).catch(() => {})
      throw error
    }

    return { files, offsets: parts.map((part) => part.start), duration }
  })
}

async function transcodeParts(
  id: string,
  input: Input,
  parts: { start: number; end: number }[],
  files: string[],
  hooks: JobHooks,
): Promise<void> {
  const track = await input.getPrimaryAudioTrack()
  if (!track || !(await track.canDecode())) {
    throw new Error('The audio in this file cannot be decoded on this PC.')
  }
  for (const [index, part] of parts.entries()) {
    const scale = { from: index / parts.length, to: (index + 1) / parts.length }
    const target: WriteTarget = { kind: 'sidecar', id, name: files[index]! }
    await produce(target, new WebMOutputFormat(), async (output) => {
      const conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        video: { discard: true },
        audio: {
          codec: 'opus',
          numberOfChannels: 1,
          sampleRate: 48_000,
          quality: new Quality({ bitrate: STT_BITRATE }),
        },
        // The last part runs to the real end, whatever the metadata claimed.
        trim: index === parts.length - 1 ? { start: part.start } : part,
        showWarnings: false,
      })
      await runConversion(conversion, hooks, scale)
    })
  }
}

async function copyOpusParts(
  id: string,
  track: InputAudioTrack,
  parts: { start: number; end: number }[],
  files: string[],
  duration: number,
  hooks: JobHooks,
): Promise<void> {
  const decoderConfig = await track.getDecoderConfig()
  if (!decoderConfig) throw new Error('The audio track is missing its codec setup.')
  const packets = new EncodedPacketSink(track).packets()

  try {
    let next = await packets.next()
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1
      const target: WriteTarget = { kind: 'sidecar', id, name: files[index]! }
      await produce(target, new WebMOutputFormat(), async (output) => {
        const source = new EncodedAudioPacketSource('opus')
        output.addAudioTrack(source)
        await output.start()
        let first = true
        while (!next.done && (last || next.value.timestamp < part.end)) {
          throwIfAborted(hooks.signal)
          const packet = next.value
          // Opus pre-skip makes the first packet start slightly before zero; muxers reject that.
          const shifted = packet.clone({ timestamp: Math.max(0, packet.timestamp - part.start) })
          await source.add(shifted, first ? { decoderConfig } : undefined)
          first = false
          if (duration > 0) hooks.onProgress?.(Math.min(1, packet.timestamp / duration))
          next = await packets.next()
        }
        source.close()
        await output.finalize()
      })
    }
  } finally {
    await packets.return(undefined)
  }
}

/** 16 kHz mono samples for on-device transcription; an hour of audio is about 230 MB. */
export async function extractSpeechSamples(
  id: string,
  hooks: JobHooks = {},
): Promise<{ samples: Float32Array; duration: number }> {
  const file = await openSource({ kind: 'media', id })
  try {
    return await extractAudio(file.source, {
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
    })
  } finally {
    await file.close()
  }
}

// Audio for Sarvam Dubbing

const DUB_UPLOAD_NAME = 'tmp-dub-source.wav'

/** Mono 16-bit 48 kHz WAV of the media's audio, so the video itself never leaves the PC. */
export async function extractDubUploadAudio(id: string, hooks: JobHooks = {}): Promise<string> {
  await withInput({ kind: 'media', id }, async (input) => {
    if (!(await input.getPrimaryAudioTrack())) throw new Error('This video has no audio to dub.')
    const target: WriteTarget = { kind: 'sidecar', id, name: DUB_UPLOAD_NAME }
    await produce(target, new WavOutputFormat(), async (output) => {
      const conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        video: { discard: true },
        audio: { codec: 'pcm-s16', numberOfChannels: 1, sampleRate: 48_000 },
        showWarnings: false,
      })
      await runConversion(conversion, hooks)
    })
  })
  return DUB_UPLOAD_NAME
}

// Muxing a dubbed audio track onto the original video

interface DubContainer {
  format: OutputFormat
  ext: string
  audioCodec: 'opus' | 'aac'
}

/** WebM for the royalty-free codecs; H.264/HEVC go to MP4 when the platform encodes AAC. */
async function dubContainer(videoCodec: VideoCodec | null): Promise<DubContainer> {
  if (videoCodec === null || videoCodec === 'vp8' || videoCodec === 'vp9' || videoCodec === 'av1') {
    return { format: new WebMOutputFormat(), ext: 'webm', audioCodec: 'opus' }
  }
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48_000 })) {
    return { format: new Mp4OutputFormat(), ext: 'mp4', audioCodec: 'aac' }
  }
  return { format: new MkvOutputFormat(), ext: 'mkv', audioCodec: 'opus' }
}

/**
 * Copies the original video packets and encodes `audio` as the only audio track, writing
 * {kind: 'output'} "<baseName>.<ext>". Both tracks are fed in timestamp order so the muxer
 * never has to buffer one while waiting for the other.
 */
export async function muxDub(
  id: string,
  audio: ReadTarget,
  baseName: string,
  audioMetadata: { languageCode?: string; name?: string },
  hooks: JobHooks = {},
): Promise<CommitResult> {
  const original = await openInput({ kind: 'media', id })
  try {
    const dubbed = await openInput(audio)
    try {
      const videoTrack = await original.input.getPrimaryVideoTrack()
      const dubTrack = await dubbed.input.getPrimaryAudioTrack()
      if (!dubTrack) throw new Error('The dubbed audio has no audio track.')
      if (!(await dubTrack.canDecode())) {
        throw new Error('The dubbed audio cannot be decoded on this PC.')
      }

      const videoCodec = videoTrack ? await videoTrack.getCodec() : null
      if (videoTrack && !videoCodec) {
        throw new Error('The video codec of this file is not recognised.')
      }
      const decoderConfig = videoTrack ? await videoTrack.getDecoderConfig() : null
      if (videoTrack && !decoderConfig) {
        throw new Error('The video track is missing its codec setup.')
      }

      const container = await dubContainer(videoCodec)
      const channels = Math.min(2, await dubTrack.getNumberOfChannels())
      const total = Math.max(await durationOf(original.input), await durationOf(dubbed.input))
      // Some MP4s start at a negative time; shift both tracks so nothing lands before zero.
      const offset = videoTrack ? Math.max(0, -(await videoTrack.getFirstTimestamp())) : 0

      return await produce(
        { kind: 'output', id, baseName, ext: container.ext },
        container.format,
        async (output) => {
          const videoSource = videoCodec ? new EncodedVideoPacketSource(videoCodec) : null
          if (videoSource && videoTrack) {
            output.addVideoTrack(videoSource, { rotation: await videoTrack.getRotation() })
          }
          const audioSource = new AudioSampleSource({
            codec: container.audioCodec,
            quality: new Quality({ bitrate: channels === 1 ? 96_000 : 128_000 }),
            transform: { sampleRate: 48_000, numberOfChannels: channels },
          })
          output.addAudioTrack(audioSource, audioMetadata)
          await output.start()

          const packets = videoTrack
            ? new EncodedPacketSink(videoTrack).packets(undefined, undefined, {
                verifyKeyPackets: true,
              })
            : null
          const samples = new AudioSampleSink(dubTrack).samples()
          try {
            let packet = packets ? await packets.next() : null
            let sample = await samples.next()
            let firstPacket = true
            for (;;) {
              throwIfAborted(hooks.signal)
              const videoTime = packet && !packet.done ? packet.value.timestamp : Infinity
              const audioTime = sample.done ? Infinity : sample.value.timestamp
              if (videoTime === Infinity && audioTime === Infinity) break

              if (packets && videoSource && packet && !packet.done && videoTime <= audioTime) {
                await videoSource.add(
                  packet.value.clone({ timestamp: packet.value.timestamp + offset }),
                  firstPacket && decoderConfig ? { decoderConfig } : undefined,
                )
                firstPacket = false
                packet = await packets.next()
              } else if (!sample.done) {
                const value = sample.value
                try {
                  if (offset > 0) value.setTimestamp(value.timestamp + offset)
                  await audioSource.add(value)
                } finally {
                  value.close()
                }
                sample = await samples.next()
              }
              if (total > 0) hooks.onProgress?.(Math.min(1, Math.min(videoTime, audioTime) / total))
            }
          } finally {
            await packets?.return(undefined)
            await samples.return(undefined)
          }

          videoSource?.close()
          audioSource.close()
          await output.finalize()
        },
      )
    } finally {
      await dubbed.dispose()
    }
  } finally {
    await original.dispose()
  }
}

/** Copies a downloaded sidecar (e.g. a dubbed video export) into the library as an output. */
export function saveSidecarAsOutput(
  id: string,
  name: string,
  baseName: string,
  ext: string,
  hooks: JobHooks = {},
): Promise<CommitResult> {
  const from: ReadTarget = { kind: 'sidecar', id, name }
  return copyFile(from, { kind: 'output', id, baseName, ext }, hooks.onProgress)
}
