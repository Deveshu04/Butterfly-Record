// Minimal RIFF/WAVE handling for TTS clips and the rendered dub track.

export const WAV_HEADER_BYTES = 44
/** RIFF sizes are 32-bit. */
export const MAX_WAV_DATA_BYTES = 0xffff_ffff - WAV_HEADER_BYTES

/** Canonical 44-byte header for 16-bit PCM. */
export function wavHeader(
  frames: number,
  sampleRate: number,
  channels: number,
): Uint8Array<ArrayBuffer> {
  const blockAlign = channels * 2
  const dataBytes = frames * blockAlign
  if (dataBytes > MAX_WAV_DATA_BYTES) throw new Error('The audio is too long for a WAV file.')

  const header = new Uint8Array(WAV_HEADER_BYTES)
  const view = new DataView(header.buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      header[offset + index] = text.charCodeAt(index)
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return header
}

export interface MonoAudio {
  sampleRate: number
  samples: Float32Array<ArrayBuffer>
}

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

/** Decodes integer or float PCM WAV into mono float samples. */
export function parseWav(bytes: Uint8Array): MonoAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)

  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('The speech audio is not a WAV file.')
  }

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = -1
  let dataBytes = 0

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataOffset = body
      // Streamed WAVs leave the size at 0 or 0xFFFFFFFF; the data then runs to the end.
      const remaining = bytes.byteLength - body
      dataBytes = size === 0 || size > remaining ? remaining : size
      break
    }
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) {
    throw new Error('The speech audio is missing its format or data.')
  }
  const read = sampleReader(view, format, bits)
  if (!read) throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit).`)

  const bytesPerSample = bits / 8
  const frames = Math.floor(dataBytes / (bytesPerSample * channels))
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      sum += read(dataOffset + (frame * channels + channel) * bytesPerSample)
    }
    samples[frame] = sum / channels
  }
  return { sampleRate, samples }
}

function sampleReader(
  view: DataView,
  format: number,
  bits: number,
): ((offset: number) => number) | null {
  if (format === FORMAT_PCM) {
    if (bits === 16) return (offset) => view.getInt16(offset, true) / 32768
    if (bits === 8) return (offset) => (view.getUint8(offset) - 128) / 128
    if (bits === 24) {
      return (offset) => {
        const value =
          view.getUint8(offset) |
          (view.getUint8(offset + 1) << 8) |
          (view.getInt8(offset + 2) << 16)
        return value / 8_388_608
      }
    }
    if (bits === 32) return (offset) => view.getInt32(offset, true) / 2_147_483_648
  }
  if (format === FORMAT_FLOAT) {
    if (bits === 32) return (offset) => view.getFloat32(offset, true)
    if (bits === 64) return (offset) => view.getFloat64(offset, true)
  }
  return null
}

/** Linear interpolation: plenty for speech, and for a bed mixed far below it. */
export function resampleLinear(
  input: Float32Array,
  from: number,
  to: number,
): Float32Array<ArrayBuffer> {
  if (from === to) return Float32Array.from(input)
  const length = Math.max(0, Math.round((input.length * to) / from))
  const output = new Float32Array(length)
  const ratio = from / to
  const last = input.length - 1
  for (let index = 0; index < length; index++) {
    const position = index * ratio
    const left = Math.min(last, Math.floor(position))
    const right = Math.min(last, left + 1)
    const fraction = position - left
    output[index] = input[left]! + (input[right]! - input[left]!) * fraction
  }
  return output
}

/** Clamps to [-1, 1] and packs little-endian 16-bit PCM. */
export function floatToS16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]!))
    view.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true)
  }
  return out
}

export function decibelsToGain(decibels: number): number {
  return 10 ** (decibels / 20)
}
