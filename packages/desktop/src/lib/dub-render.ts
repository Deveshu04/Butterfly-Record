// Renders a text-to-speech dub track: each translated phrase voiced by Bulbul and placed at
// its original time, optionally over the original audio turned well down.

import type { Transcript } from '@butterfly-record/core'
import { ALL_FORMATS, AudioSampleSink, Input, type AudioSample } from 'mediabunny'

import { openSource, writeFile } from './fsio.ts'
import { sarvamTts } from './ipc.ts'
import type { JobHooks } from './media.ts'
import { chunkRanges, dubPace, placeCue, planDub, splitForTts, type DubCue } from './timing.ts'
import {
  WAV_HEADER_BYTES,
  decibelsToGain,
  floatToS16,
  parseWav,
  resampleLinear,
  wavHeader,
} from './wav.ts'

const RATE = 48_000
/** Rendered in slices so memory stays flat however long the video is. */
const CHUNK_SECONDS = 300
const TTS_MAX_CHARS = 2500
const BED_GAIN = decibelsToGain(-18)

export interface TtsDubOptions extends JobHooks {
  id: string
  /** The translated transcript to voice. */
  transcript: Transcript
  language: string
  speaker: string
  /** Seconds; the rendered track is exactly this long. */
  duration: number
  keepOriginalAudio: boolean
}

export function ttsTrackName(language: string): string {
  return `tmp-tts-${language}.wav`
}

interface Clip {
  /** First frame on the output timeline. */
  at: number
  samples: Float32Array
}

/** Writes a mono 48 kHz WAV sidecar and resolves with its name. */
export async function renderTtsDub(options: TtsDubOptions): Promise<string> {
  const { id, transcript, duration, signal, onProgress } = options
  const name = ttsTrackName(options.language)
  const totalFrames = Math.ceil(duration * RATE)
  if (totalFrames === 0) throw new Error('The video length is unknown, so it cannot be dubbed.')
  const cues = planDub(transcript.segments, duration)
  if (cues.length === 0) throw new Error('The translation has no text to voice.')

  await writeFile({ kind: 'sidecar', id, name }, async (writer) => {
    await writer.write(wavHeader(totalFrames, RATE, 1), 0)
    const bed = options.keepOriginalAudio ? await openBed(id) : null
    try {
      const pending: Clip[] = []
      let next = 0
      let cursor = 0

      for (const [from, to] of chunkRanges(totalFrames, CHUNK_SECONDS * RATE)) {
        const mix = new Float32Array(to - from)
        if (bed) await bed.mixInto(mix, from)

        while (next < cues.length && cues[next]!.start * RATE < to) {
          if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
          const clip = await voiceCue(cues[next]!, cursor, options)
          cursor = (clip.at + clip.samples.length) / RATE
          pending.push(clip)
          next++
          onProgress?.(next / cues.length)
        }

        for (const clip of pending) mixClip(mix, from, clip)
        // Clips that run past this slice are finished in the next one.
        for (let index = pending.length - 1; index >= 0; index--) {
          const clip = pending[index]!
          if (clip.at + clip.samples.length <= to) pending.splice(index, 1)
        }

        await writer.write(floatToS16(mix), WAV_HEADER_BYTES + from * 2)
      }
    } finally {
      await bed?.close()
    }
  })

  return name
}

async function voiceCue(cue: DubCue, cursor: number, options: TtsDubOptions): Promise<Clip> {
  const { at, window } = placeCue(cue, cursor)
  let samples = await speak(cue.text, 1, options)
  const pace = dubPace(samples.length / RATE, window)
  if (pace !== null) samples = await speak(cue.text, pace, options)
  return { at: Math.round(at * RATE), samples }
}

async function speak(text: string, pace: number, options: TtsDubOptions): Promise<Float32Array> {
  const pieces: Float32Array[] = []
  for (const piece of splitForTts(text, TTS_MAX_CHARS)) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const wav = await sarvamTts({
      text: piece,
      language: options.language,
      speaker: options.speaker,
      pace,
      sampleRate: RATE,
    })
    const audio = parseWav(new Uint8Array(wav))
    pieces.push(
      audio.sampleRate === RATE
        ? audio.samples
        : resampleLinear(audio.samples, audio.sampleRate, RATE),
    )
  }
  if (pieces.length === 1) return pieces[0]!
  const joined = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0))
  let offset = 0
  for (const piece of pieces) {
    joined.set(piece, offset)
    offset += piece.length
  }
  return joined
}

function mixClip(mix: Float32Array, from: number, clip: Clip): void {
  const start = Math.max(clip.at, from)
  const end = Math.min(clip.at + clip.samples.length, from + mix.length)
  for (let frame = start; frame < end; frame++) {
    mix[frame - from]! += clip.samples[frame - clip.at]!
  }
}

interface Bed {
  mixInto(mix: Float32Array, from: number): Promise<void>
  close(): Promise<void>
}

/** The original soundtrack, decoded slice by slice and mixed in at -18 dB. */
async function openBed(id: string): Promise<Bed | null> {
  const file = await openSource({ kind: 'media', id })
  const input = new Input({ source: file.source, formats: ALL_FORMATS })
  const close = async () => {
    input.dispose()
    await file.close()
  }

  const track = await input.getPrimaryAudioTrack().catch(() => null)
  if (!track || !(await track.canDecode())) {
    await close()
    return null
  }
  const sink = new AudioSampleSink(track)

  return {
    close,
    mixInto: async (mix, from) => {
      const start = from / RATE
      const end = (from + mix.length) / RATE
      for await (const sample of sink.samples(start, end)) {
        try {
          const mono = toMono(sample)
          const audio =
            sample.sampleRate === RATE ? mono : resampleLinear(mono, sample.sampleRate, RATE)
          const offset = Math.round((sample.timestamp - start) * RATE)
          const first = Math.max(0, -offset)
          const last = Math.min(audio.length, mix.length - offset)
          for (let index = first; index < last; index++) {
            mix[offset + index]! += audio[index]! * BED_GAIN
          }
        } finally {
          sample.close()
        }
      }
    },
  }
}

function toMono(sample: AudioSample): Float32Array {
  const frames = sample.numberOfFrames
  const channels = sample.numberOfChannels
  const mono = new Float32Array(frames)
  const plane = new Float32Array(frames)
  for (let channel = 0; channel < channels; channel++) {
    sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
    for (let frame = 0; frame < frames; frame++) mono[frame]! += plane[frame]! / channels
  }
  return mono
}
