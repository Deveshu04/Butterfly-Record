// MediaRecorder defaults to ~2.5 Mbps at any resolution, so a bitrate is always set explicitly.

export interface VideoShape {
  width: number
  height: number
  frameRate: number
}

const TABLE: ReadonlyArray<{ width: number; height: number; fps: number; bitrate: number }> = [
  { width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  { width: 1920, height: 1080, fps: 30, bitrate: 10_000_000 },
  { width: 1920, height: 1080, fps: 60, bitrate: 15_000_000 },
  { width: 2560, height: 1440, fps: 30, bitrate: 18_000_000 },
  { width: 3840, height: 2160, fps: 30, bitrate: 40_000_000 },
  { width: 3840, height: 2160, fps: 60, bitrate: 60_000_000 },
]

// Bits per pixel fitted to TABLE for off-table sizes, linear between 30 and 60 fps.
const BPP_AT_30 = 0.161
const BPP_AT_60 = 0.121

const MIN_BITRATE = 1_000_000
const MAX_BITRATE = 80_000_000

function bitsPerPixel(frameRate: number): number {
  const t = (clamp(frameRate, 30, 60) - 30) / 30
  return BPP_AT_30 + (BPP_AT_60 - BPP_AT_30) * t
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Bits per second. */
export function bitrateFor({ width, height, frameRate }: VideoShape): number {
  const exact = TABLE.find(
    (row) => row.width === width && row.height === height && row.fps === frameRate,
  )
  if (exact) return exact.bitrate

  const pixelRate = width * height * frameRate
  return Math.round(clamp(pixelRate * bitsPerPixel(frameRate), MIN_BITRATE, MAX_BITRATE))
}

/** Opus bits per second. */
export function audioBitrateFor(channels: 1 | 2): number {
  return channels === 2 ? 128_000 : 96_000
}

export function secondsRemaining(
  bytesAvailable: number,
  videoBitrate: number,
  audioBitrate: number,
): number {
  const bytesPerSecond = (videoBitrate + audioBitrate) / 8
  if (bytesPerSecond <= 0) return Infinity
  return Math.max(0, bytesAvailable / bytesPerSecond)
}
