// Exports an EDL by remuxing packets with shifted timestamps. A segment starting mid-GOP has
// its head re-encoded; if that fails it starts at the preceding keyframe instead.

import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedVideoPacketSource,
  EncodedPacketSink,
  Input,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny'

import { outputDuration, type Edl, type EditSegment } from './edl.ts'
import {
  EXPORT_FILE,
  SOURCE_FILE,
  fileHandle,
  removeFile,
  sessionPath,
  uncommittedTarget,
  writeScratchFile,
} from './opfs.ts'
import { reencodeRange, type BoundaryGop } from './reencode.ts'
import { sourceForFile } from './source.ts'

export interface ExportProgress {
  /** 0..1 over the whole export. */
  progress: number
  /** Which kept segment is being written, 1-based. */
  segment: number
  segmentCount: number
}

export interface ExportOptions {
  onProgress?: (progress: ExportProgress) => void
}

/** A keyframe this close to the requested start counts as exact: under one frame at any rate. */
export const SPLICE_EPSILON = 0.01

/** Used when the source bitrate is unknown; high, so the splice shows no quality step. */
const FALLBACK_BITRATE = 8_000_000

/** Enough packets for a stable bitrate estimate without scanning the file. */
const BITRATE_SAMPLE_PACKETS = 200

/** VP8/VP9 only: H.264 and AV1 keep parameter sets out of band, so encoders cannot be mixed. */
export function canSpliceCodec(codec: string | null): boolean {
  return codec === 'vp8' || codec === 'vp9'
}

/**
 * The segment head to re-encode for a frame-exact cut, or null when the keyframe already
 * lands on the start. `nextKeyTimestamp` is null in the last GOP; the window never passes
 * the segment end.
 */
export function reencodeWindow(
  segment: EditSegment,
  keyTimestamp: number | null,
  nextKeyTimestamp: number | null,
): { from: number; to: number } | null {
  if (keyTimestamp === null) return null
  if (keyTimestamp >= segment.start - SPLICE_EPSILON) return null

  const to = Math.min(nextKeyTimestamp ?? segment.end, segment.end)
  if (!(to > segment.start)) return null
  return { from: segment.start, to }
}

export function spliceBitrate(measured: number | null | undefined): number {
  if (measured === null || measured === undefined) return FALLBACK_BITRATE
  if (!Number.isFinite(measured) || measured <= 0) return FALLBACK_BITRATE
  return Math.round(measured)
}

/**
 * Where a source packet of `segment` lands in the output. Packets from before the segment
 * start (the frame showing at the cut, a keyframe's run-up, the audio packet spanning it)
 * land on `outputStart`, so a segment never reaches back past the end of the one before:
 * the muxer rejects any packet older than the previous GOP.
 */
export function outputTimestamp(
  timestamp: number,
  segment: EditSegment,
  outputStart: number,
): number {
  return outputStart + Math.max(0, timestamp - segment.start)
}

/** The keyframe the copy-only path would start each cut at, for snapping editor handles. */
export async function snapToKeyframes(id: string, times: number[]): Promise<number[]> {
  const file = await (await fileHandle(sessionPath(id, SOURCE_FILE))).getFile()
  const input = new Input({ source: sourceForFile(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) return times

  const sink = new EncodedPacketSink(track)
  return Promise.all(
    times.map(async (time) => {
      if (time <= 0) return 0
      const key = await sink.getKeyPacket(time)
      return key ? key.timestamp : time
    }),
  )
}

export async function keyframeTimes(id: string, limit = 4000): Promise<number[]> {
  const file = await (await fileHandle(sessionPath(id, SOURCE_FILE))).getFile()
  const input = new Input({ source: sourceForFile(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) return []

  const sink = new EncodedPacketSink(track)
  const times: number[] = []
  let packet = await sink.getFirstKeyPacket()
  while (packet && times.length < limit) {
    times.push(packet.timestamp)
    packet = await sink.getNextKeyPacket(packet)
  }
  return times
}

export async function exportEdited(
  id: string,
  edl: Edl,
  options: ExportOptions = {},
): Promise<File> {
  if (edl.segments.length === 0) {
    throw new Error('Nothing to export — every part of this recording has been cut.')
  }

  const file = await (await fileHandle(sessionPath(id, SOURCE_FILE))).getFile()
  const input = new Input({ source: sourceForFile(file), formats: ALL_FORMATS })

  const videoTrack = await input.getPrimaryVideoTrack()
  const audioTrack = await input.getPrimaryAudioTrack()
  if (!videoTrack && !audioTrack) throw new Error('This recording has no usable tracks.')

  // Streamed to an OPFS scratch file, not memory: the result can be gigabytes.
  // The caller downloads it, then calls discardExport(). A failed export leaves no file.
  return writeScratchFile(sessionPath(id, EXPORT_FILE), async (writable) => {
    const target = new StreamTarget(uncommittedTarget(writable), {
      chunked: true,
      chunkSize: 1 << 20,
    })
    const output = new Output({ format: new WebMOutputFormat(), target })

    try {
      const video = videoTrack ? await addVideoTrack(output, videoTrack) : null
      const audio = audioTrack ? await addAudioTrack(output, audioTrack) : null

      await output.start()

      const total = outputDuration(edl)
      let cursor = 0

      for (const [index, segment] of edl.segments.entries()) {
        if (video) await copyVideoSegment(video, segment, cursor)
        if (audio) await copyAudioSegment(audio, segment, cursor)

        cursor += segment.end - segment.start
        options.onProgress?.({
          progress: total > 0 ? Math.min(1, cursor / total) : 1,
          segment: index + 1,
          segmentCount: edl.segments.length,
        })
      }

      await output.finalize()
    } catch (error) {
      await output.cancel().catch(() => {})
      throw error
    }
  })
}

export async function discardExport(id: string): Promise<void> {
  await removeFile(sessionPath(id, EXPORT_FILE))
}

interface VideoCopier {
  track: InputVideoTrack
  codec: string
  sink: EncodedPacketSink
  /** Measured once, on the first boundary re-encode, then reused. */
  bitrate: number | null
  /** Only the first write carries a decoder config: `override` if given, else the source's. */
  write: (packet: EncodedPacket, override: VideoDecoderConfig | null) => Promise<void>
}

interface AudioCopier {
  sink: EncodedPacketSink
  write: (packet: EncodedPacket) => Promise<void>
}

async function addVideoTrack(output: Output, track: InputVideoTrack): Promise<VideoCopier> {
  const codec = track.codec
  if (!codec) throw new Error('Unrecognised video codec in this recording.')

  const source = new EncodedVideoPacketSource(codec)
  output.addVideoTrack(source)
  const decoderConfig = await track.getDecoderConfig()

  let started = false
  return {
    track,
    codec,
    bitrate: null,
    sink: new EncodedPacketSink(track),
    // The decoder config must accompany the first packet, or the output track is undescribed.
    write: (packet, override) => {
      const config = started ? null : (override ?? decoderConfig)
      started = true
      return source.add(packet, config ? { decoderConfig: config } : undefined)
    },
  }
}

async function addAudioTrack(output: Output, track: InputAudioTrack): Promise<AudioCopier> {
  const codec = track.codec
  if (!codec) throw new Error('Unrecognised audio codec in this recording.')

  const source = new EncodedAudioPacketSource(codec)
  output.addAudioTrack(source)
  const decoderConfig = await track.getDecoderConfig()

  let started = false
  return {
    sink: new EncodedPacketSink(track),
    write: (packet) => {
      const config = started ? null : decoderConfig
      started = true
      return source.add(packet, config ? { decoderConfig: config } : undefined)
    },
  }
}

async function copyPackets(
  sink: EncodedPacketSink,
  start: EncodedPacket,
  segment: EditSegment,
  outputStart: number,
  write: (packet: EncodedPacket) => Promise<void>,
): Promise<void> {
  let packet: EncodedPacket | null = start
  while (packet && packet.timestamp < segment.end) {
    await write(
      packet.clone({ timestamp: outputTimestamp(packet.timestamp, segment, outputStart) }),
    )
    packet = await sink.getNextPacket(packet)
  }
}

/** Audio packets are independent, so the copy starts exactly where asked. */
async function copyAudioSegment(
  copier: AudioCopier,
  segment: EditSegment,
  outputStart: number,
): Promise<void> {
  const entry =
    (await copier.sink.getPacket(segment.start)) ?? (await copier.sink.getFirstPacket())
  if (!entry) return
  await copyPackets(copier.sink, entry, segment, outputStart, (packet) => copier.write(packet))
}

async function copyVideoSegment(
  copier: VideoCopier,
  segment: EditSegment,
  outputStart: number,
): Promise<void> {
  const key = await copier.sink.getKeyPacket(segment.start)

  if (key && canSpliceCodec(copier.codec)) {
    const nextKey = await copier.sink.getNextKeyPacket(key)
    const window = reencodeWindow(segment, key.timestamp, nextKey?.timestamp ?? null)
    if (window) {
      // Only the re-encode may fall back; once packets are written, a failure is real.
      let gop: BoundaryGop | null = null
      try {
        copier.bitrate ??= spliceBitrate(await measuredBitrate(copier.track))
        gop = await reencodeRange(copier.track, window.from, window.to, {
          bitrate: copier.bitrate,
        })
      } catch {
        // Fall back to the keyframe-aligned copy below.
      }

      if (gop) {
        for (const packet of gop.packets) {
          await copier.write(
            packet.clone({ timestamp: outputTimestamp(packet.timestamp, segment, outputStart) }),
            gop.decoderConfig,
          )
        }
        if (nextKey && nextKey.timestamp < segment.end) {
          await copyPackets(copier.sink, nextKey, segment, outputStart, (packet) =>
            copier.write(packet, null),
          )
        }
        return
      }
    }
  }

  // Copy-only path from the preceding keyframe. The frames before the requested start are
  // only there to be decoded; they share its timestamp, so video stays in sync with audio.
  const start = key ?? (await copier.sink.getFirstPacket())
  if (!start) return
  await copyPackets(copier.sink, start, segment, outputStart, (packet) =>
    copier.write(packet, null),
  )
}

async function measuredBitrate(track: InputVideoTrack): Promise<number | null> {
  try {
    const stats = await track.computePacketStats(BITRATE_SAMPLE_PACKETS)
    return stats.averageBitrate
  } catch {
    return null
  }
}
