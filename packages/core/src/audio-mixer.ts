// MediaRecorder records only the first audio track, so all sources are mixed into one.
// chrome.tabCapture mutes the tab, so tab audio is also routed back to the speakers.

import type { AudioTrackKind } from './manifest.ts'

export interface MixerInput {
  kind: AudioTrackKind
  label: string
  stream: MediaStream
  /**
   * Route to the speakers. True for tab capture (Chrome mutes the tab); false for
   * the mic (feedback loop) and getDisplayMedia audio (keeps playing on its own).
   */
  monitor: boolean
  gain?: number
}

export interface MixerOptions {
  /** Fixed at 48 kHz: 44.1 kHz and 48 kHz sources drift apart over long recordings. */
  sampleRate?: 48000
  meters?: boolean
}

interface Channel {
  kind: AudioTrackKind
  label: string
  source: MediaStreamAudioSourceNode
  mixGain: GainNode
  monitorGain: GainNode | null
  analyser: AnalyserNode | null
  buffer: Float32Array<ArrayBuffer> | null
}

const FFT_SIZE = 1024

export class AudioMixer {
  readonly #ctx: AudioContext
  readonly #destination: MediaStreamAudioDestinationNode
  /** Gain 0 into ctx.destination: Chrome only pulls analysers whose graph reaches it. */
  readonly #silentSink: GainNode
  readonly #channels = new Map<AudioTrackKind, Channel>()
  #closed = false

  private constructor(ctx: AudioContext) {
    this.#ctx = ctx
    this.#destination = ctx.createMediaStreamDestination()
    this.#silentSink = ctx.createGain()
    this.#silentSink.gain.value = 0
    this.#silentSink.connect(ctx.destination)
  }

  static async create(inputs: MixerInput[], options: MixerOptions = {}): Promise<AudioMixer> {
    const withAudio = inputs.filter((input) => input.stream.getAudioTracks().length > 0)
    if (withAudio.length === 0) {
      throw new Error('AudioMixer.create: no input stream has an audio track')
    }

    const ctx = new AudioContext({
      sampleRate: options.sampleRate ?? 48000,
      latencyHint: 'interactive',
    })
    const mixer = new AudioMixer(ctx)

    for (const input of withAudio) mixer.#addChannel(input, options.meters ?? false)

    // A context created without a user gesture starts suspended and records silence
    // without error. resume() can also reject, so the state is re-checked.
    if (ctx.state === 'suspended') {
      await ctx.resume().catch((error: unknown) => {
        console.warn('[butterfly-record] AudioContext.resume() rejected', error)
      })
    }

    if (ctx.state !== 'running') {
      console.error(
        `[butterfly-record] AudioContext is "${ctx.state}" — the recording would have no audio.`,
      )
      throw new Error(
        'The browser would not start audio processing, so this recording would be silent. Try again, or record without audio.',
      )
    }

    console.info(
      `[butterfly-record] audio mixer running at ${ctx.sampleRate}Hz:`,
      [...mixer.#channels.values()].map((channel) => `${channel.kind}(${channel.label})`),
    )

    return mixer
  }

  #addChannel(input: MixerInput, meters: boolean): void {
    const ctx = this.#ctx

    // Kept in #channels: an unreferenced source node can be garbage-collected and go silent.
    const source = ctx.createMediaStreamSource(input.stream)

    const mixGain = ctx.createGain()
    mixGain.gain.value = input.gain ?? 1
    source.connect(mixGain).connect(this.#destination)

    let monitorGain: GainNode | null = null
    if (input.monitor) {
      monitorGain = ctx.createGain()
      monitorGain.gain.value = 1
      source.connect(monitorGain).connect(ctx.destination)
    }

    let analyser: AnalyserNode | null = null
    let buffer: Float32Array<ArrayBuffer> | null = null
    if (meters) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      // Meters read the raw source so a muted mic still shows input.
      source.connect(analyser).connect(this.#silentSink)
      buffer = new Float32Array(analyser.fftSize)
    }

    this.#channels.set(input.kind, {
      kind: input.kind,
      label: input.label,
      source,
      mixGain,
      monitorGain,
      analyser,
      buffer,
    })
  }

  get track(): MediaStreamTrack {
    const [track] = this.#destination.stream.getAudioTracks()
    if (!track) throw new Error('AudioMixer: destination produced no audio track')
    if (track.readyState !== 'live') {
      throw new Error('AudioMixer: the mixed audio track is not live')
    }
    return track
  }

  get channelCount(): number {
    return this.#channels.size
  }

  /** Mute with gain 0, never `track.enabled = false`: Web Audio treats a disabled track as absent. */
  setGain(kind: AudioTrackKind, gain: number): void {
    const channel = this.#channels.get(kind)
    if (!channel) return
    // Ramped: a step change in gain is an audible click.
    const now = this.#ctx.currentTime
    channel.mixGain.gain.setTargetAtTime(Math.max(0, gain), now, 0.01)
  }

  setMonitored(kind: AudioTrackKind, monitored: boolean): void {
    const channel = this.#channels.get(kind)
    if (!channel?.monitorGain) return
    const now = this.#ctx.currentTime
    channel.monitorGain.gain.setTargetAtTime(monitored ? 1 : 0, now, 0.01)
  }

  /** RMS level 0..1 per source. */
  levels(): Map<AudioTrackKind, number> {
    const out = new Map<AudioTrackKind, number>()
    for (const channel of this.#channels.values()) {
      if (!channel.analyser || !channel.buffer) continue
      channel.analyser.getFloatTimeDomainData(channel.buffer)
      let sum = 0
      for (const sample of channel.buffer) sum += sample * sample
      out.set(channel.kind, Math.sqrt(sum / channel.buffer.length))
    }
    return out
  }

  contributions(): Array<{ kind: AudioTrackKind; label: string; gain: number }> {
    return [...this.#channels.values()].map((channel) => ({
      kind: channel.kind,
      label: channel.label,
      gain: channel.mixGain.gain.value,
    }))
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const channel of this.#channels.values()) {
      channel.source.disconnect()
      channel.mixGain.disconnect()
      channel.monitorGain?.disconnect()
      channel.analyser?.disconnect()
    }
    this.#channels.clear()
    this.#silentSink.disconnect()
    this.#destination.disconnect()
    await this.#ctx.close()
  }
}

export function composeRecordingStream(
  videoTrack: MediaStreamTrack,
  audioTrack: MediaStreamTrack | null,
): MediaStream {
  return new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack])
}
