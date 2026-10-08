// The desktop recorder: getDisplayMedia + microphone, mixed by core's AudioMixer, encoded
// by MediaRecorderEncoder into <session>\source.part through Rust, then finalized into
// <title>.webm in the library folder.

import {
  AudioMixer,
  MediaRecorderEncoder,
  audioBitrateFor,
  bitrateFor,
  composeRecordingStream,
  createManifest,
  pickRecordingCodec,
  ulid,
  type CaptureSurface,
  type EncoderFault,
  type MixerInput,
} from '@butterfly-record/core'
import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { displayVideoConstraints } from './app-settings.ts'
import {
  appQuit,
  emitRecorderStatus,
  errorMessage,
  hudClose,
  hudOpen,
  onHudAction,
  onQuitRequested,
  onRecordToggle,
  recAbort,
  recorderSetState,
  sessionCreate,
  sessionDiscard,
  type DesktopManifest,
  type HudActionName,
  type RecorderPhase,
} from './ipc.ts'
import { library, posterChanged, setActiveRecording } from './library.svelte.ts'
import { writeManifest } from './manifests.ts'
import { finalizeSession, generatePoster } from './media.ts'
import { settings, type AppSettings } from './settings.svelte.ts'
import { RustChunkSink } from './sink.ts'
import { defaultRecordingTitle } from './titles.ts'

export type { RecorderPhase }

const TICK_MS = 250
const COUNTDOWN_SECONDS = 3
/** Long enough for the minimize animation to finish before the first frame is captured. */
const MINIMIZE_SETTLE_MS = 350

interface Active {
  id: string
  encoder: MediaRecorderEncoder
  mixer: AudioMixer | null
  capture: MediaStream
  mic: MediaStream | null
  minimized: boolean
}

function warn(context: string) {
  return (error: unknown) => console.warn(`[butterfly-record] ${context}`, error)
}

function abortError(): DOMException {
  return new DOMException('Cancelled', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The picker records system audio only when the user turns on "Share with system audio". */
function acquireCapture(recording: AppSettings['recording']): Promise<MediaStream> {
  const options = {
    video: displayVideoConstraints(recording),
    // Loopback stays raw: speech processing mangles music and UI sounds.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chromium extensions, absent from lib.dom: offer the system-audio checkbox and keep
    // the app's own window out of the picker.
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
  } as DisplayMediaStreamOptions
  return navigator.mediaDevices.getDisplayMedia(options)
}

function micConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
}

/** Best effort: a missing or unplugged microphone records without one rather than failing. */
async function openMicrophone(deviceId: string | null): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
  } catch (error) {
    if (deviceId) return openMicrophone(null)
    warn('microphone unavailable')(error)
    return null
  }
}

/** WebView2's track labels are opaque ("screen:0:0"), so the label comes from the surface. */
function describeCapture(track: MediaStreamTrack): { surface: CaptureSurface; label: string } {
  const surface = track.getSettings().displaySurface
  if (surface === 'monitor') return { surface: 'display', label: 'Entire screen' }
  return { surface: 'window', label: track.label || 'Window' }
}

async function restoreMainWindow(): Promise<void> {
  const main = getCurrentWindow()
  await main.unminimize()
  await main.show()
  await main.setFocus()
}

let appVersion: Promise<string> | null = null

class Recorder {
  #phase = $state<RecorderPhase>('idle')
  #elapsed = $state(0)
  #bytes = $state(0)
  #micMuted = $state(false)
  #hasMic = $state(false)
  #countdown = $state<number | null>(null)
  #error = $state<string | null>(null)
  #lastSavedId = $state<string | null>(null)

  #active: Active | null = null
  #startAbort: AbortController | null = null
  #starting: Promise<void> | null = null
  #ending: Promise<string | null> | null = null
  #ticker: ReturnType<typeof setInterval> | null = null

  get phase(): RecorderPhase {
    return this.#phase
  }
  get elapsed(): number {
    return this.#elapsed
  }
  get bytes(): number {
    return this.#bytes
  }
  get micMuted(): boolean {
    return this.#micMuted
  }
  get hasMic(): boolean {
    return this.#hasMic
  }
  get countdown(): number | null {
    return this.#countdown
  }
  get error(): string | null {
    return this.#error
  }
  get lastSavedId(): string | null {
    return this.#lastSavedId
  }

  #setPhase(phase: RecorderPhase): void {
    this.#phase = phase
    recorderSetState(phase).catch(warn('recorder state not sent'))
    this.#emitStatus()
  }

  #emitStatus(): void {
    emitRecorderStatus({
      phase: this.#phase,
      elapsed: this.#elapsed,
      micMuted: this.#micMuted,
      hasMic: this.#hasMic,
      countdown: this.#countdown,
    }).catch(() => {})
  }

  #startTicker(): void {
    this.#stopTicker()
    this.#ticker = setInterval(() => {
      const active = this.#active
      if (active) {
        this.#elapsed = active.encoder.elapsed
        this.#bytes = active.encoder.bytesWritten
      }
      this.#emitStatus()
    }, TICK_MS)
  }

  #stopTicker(): void {
    if (this.#ticker !== null) clearInterval(this.#ticker)
    this.#ticker = null
  }

  start(): Promise<void> {
    if (this.#phase !== 'idle' || this.#starting) return this.#starting ?? Promise.resolve()
    this.#starting = this.#start().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #start(): Promise<void> {
    const recording = settings.value.recording
    const abort = new AbortController()
    this.#startAbort = abort
    this.#error = null
    this.#elapsed = 0
    this.#bytes = 0
    this.#countdown = null
    this.#setPhase('starting')

    let capture: MediaStream | null = null
    let mic: MediaStream | null = null
    let mixer: AudioMixer | null = null
    let minimized = false
    let sessionId: string | null = null

    try {
      // The picker spends the user gesture, so it must be the first thing awaited.
      capture = await acquireCapture(recording)
      if (abort.signal.aborted) throw abortError()
      mic = recording.microphoneEnabled ? await openMicrophone(recording.microphoneId) : null

      const [videoTrack] = capture.getVideoTracks()
      if (!videoTrack) throw new Error('The capture produced no video.')
      const { surface, label } = describeCapture(videoTrack)

      const inputs: MixerInput[] = []
      // Loopback keeps playing on the speakers by itself, and monitoring the mic would feed back.
      if (capture.getAudioTracks().length > 0) {
        inputs.push({ kind: 'system', label, stream: capture, monitor: false })
      }
      if (mic) {
        inputs.push({
          kind: 'mic',
          label: mic.getAudioTracks()[0]?.label || 'Microphone',
          stream: mic,
          monitor: false,
        })
      }
      mixer = inputs.length > 0 ? await AudioMixer.create(inputs) : null
      this.#hasMic = mic !== null
      this.#micMuted = false

      if (recording.hideWindow) {
        await getCurrentWindow().minimize()
        minimized = true
      }
      await hudOpen().catch(warn('HUD could not open'))
      this.#startTicker()

      if (recording.countdown) {
        this.#setPhase('countdown')
        for (let remaining = COUNTDOWN_SECONDS; remaining > 0; remaining--) {
          this.#countdown = remaining
          this.#emitStatus()
          await sleep(1000, abort.signal)
        }
        this.#countdown = null
      } else if (minimized) {
        await sleep(MINIMIZE_SETTLE_MS, abort.signal)
      }

      const track = videoTrack.getSettings()
      const width = track.width ?? 1920
      const height = track.height ?? 1080
      const frameRate = Math.round(track.frameRate ?? recording.frameRate)
      const codec = pickRecordingCodec(mixer !== null)
      const videoBitsPerSecond = bitrateFor({ width, height, frameRate })
      const audioBitsPerSecond = audioBitrateFor(2)

      const id = ulid()
      await sessionCreate(id)
      sessionId = id
      const manifest: DesktopManifest = {
        ...createManifest({
          id,
          producer: {
            app: 'desktop',
            version: await (appVersion ??= getVersion().catch(() => 'unknown')),
            os: navigator.userAgent,
          },
          video: {
            codec: codec.videoCodec,
            container: 'webm',
            width,
            height,
            frameRate,
            bitrate: videoBitsPerSecond,
            surface,
            sourceLabel: label,
          },
          audio: {
            codec: 'opus',
            sampleRate: 48000,
            channels: 2,
            tracks: mixer ? mixer.contributions() : [],
          },
          camera: null,
          title: defaultRecordingTitle(new Date()),
        }),
        media: null,
        outputs: [],
      }
      await writeManifest(manifest)
      if (abort.signal.aborted) throw abortError()

      const encoder = new MediaRecorderEncoder()
      const active: Active = { id, encoder, mixer, capture, mic, minimized }
      this.#active = active
      setActiveRecording(id)
      void library.refresh().catch(warn('library refresh failed'))

      await encoder.start({
        sessionId: id,
        stream: composeRecordingStream(videoTrack, mixer?.track ?? null),
        width,
        height,
        frameRate,
        surface,
        videoBitsPerSecond,
        audioBitsPerSecond,
        openSink: (session) => RustChunkSink.open(session),
        finalize: async (session) => {
          const result = await finalizeSession(session, {
            patch: { pauses: [...encoder.pauses] },
            fallbackDuration: encoder.elapsed,
          })
          return { duration: result.duration, bytes: result.bytes }
        },
        onFault: (fault) => this.#onFault(fault),
      })

      this.#startAbort = null
      this.#setPhase('recording')
      if (abort.signal.aborted) await this.discard()
    } catch (error) {
      this.#startAbort = null
      const active = this.#active
      this.#active = null
      this.#stopTicker()
      await active?.encoder.cancel().catch(warn('encoder cancel failed'))
      await mixer?.close().catch(warn('mixer close failed'))
      for (const track of capture?.getTracks() ?? []) track.stop()
      for (const track of mic?.getTracks() ?? []) track.stop()
      if (sessionId) await this.#removeSession(sessionId)
      setActiveRecording(null)
      if (sessionId) void library.refresh().catch(warn('library refresh failed'))
      this.#countdown = null
      this.#hasMic = false
      this.#setPhase('idle')
      await hudClose().catch(warn('HUD could not close'))
      if (minimized) await restoreMainWindow().catch(warn('window restore failed'))

      const cancelled =
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'NotAllowedError')
      if (!cancelled) this.#error = errorMessage(error)
    }
  }

  async #removeSession(id: string): Promise<void> {
    await recAbort(id).catch(() => {})
    await sessionDiscard(id).catch(warn('could not remove the empty session'))
  }

  #onFault(fault: EncoderFault): void {
    this.#error = fault.message
    // Recoverable means the bytes so far are a real recording worth finishing.
    if (fault.recoverable) void this.stop()
    else void this.discard()
  }

  async #release(active: Active): Promise<void> {
    await active.mixer?.close().catch(warn('mixer close failed'))
    for (const track of active.capture.getTracks()) track.stop()
    for (const track of active.mic?.getTracks() ?? []) track.stop()
  }

  /** Common tail of stop and discard: hardware off, HUD closed, window back. */
  async #wrapUp(active: Active): Promise<void> {
    await this.#release(active)
    setActiveRecording(null)
    this.#active = null
    this.#stopTicker()
    this.#hasMic = false
    this.#micMuted = false
    this.#setPhase('idle')
    await hudClose().catch(warn('HUD could not close'))
    if (active.minimized) await restoreMainWindow().catch(warn('window restore failed'))
  }

  stop(): Promise<string | null> {
    if (this.#ending) return this.#ending
    if (this.#phase === 'starting' || this.#phase === 'countdown') {
      this.#startAbort?.abort()
      return (this.#starting ?? Promise.resolve()).then(() => null)
    }
    const active = this.#active
    if (!active) return Promise.resolve(null)
    this.#ending = this.#finish(active).finally(() => {
      this.#ending = null
    })
    return this.#ending
  }

  async #finish(active: Active): Promise<string | null> {
    this.#setPhase('finalizing')
    let saved = false
    try {
      await active.encoder.stop()
      saved = true
      if (await generatePoster(active.id)) posterChanged(active.id)
      this.#lastSavedId = active.id
    } catch (error) {
      // Overrides a fault's "was saved" message: finishing failed.
      this.#error = errorMessage(error)
      // Nothing reached the disk: there is nothing to recover, so leave nothing behind.
      if (active.encoder.bytesWritten === 0) await this.#removeSession(active.id)
    }
    await this.#wrapUp(active)
    await library.refresh().catch(warn('library refresh failed'))
    if (saved) location.hash = `#/video/${active.id}`
    return saved ? active.id : null
  }

  discard(): Promise<void> {
    if (this.#phase === 'starting' || this.#phase === 'countdown') {
      this.#startAbort?.abort()
      return this.#starting ?? Promise.resolve()
    }
    const active = this.#active
    if (!active || this.#ending) return Promise.resolve()
    this.#ending = (async () => {
      await active.encoder.cancel().catch(warn('encoder cancel failed'))
      await this.#removeSession(active.id)
      await this.#wrapUp(active)
      await library.refresh().catch(warn('library refresh failed'))
      return null
    })().finally(() => {
      this.#ending = null
    })
    return this.#ending.then(() => {})
  }

  pause(): void {
    if (this.#phase !== 'recording' || !this.#active) return
    this.#active.encoder.pause()
    this.#setPhase('paused')
  }

  resume(): void {
    if (this.#phase !== 'paused' || !this.#active) return
    this.#active.encoder.resume()
    this.#setPhase('recording')
  }

  toggleMute(): void {
    const active = this.#active
    if (!active?.mixer || !this.#hasMic) return
    this.#micMuted = !this.#micMuted
    // Gain, not track.enabled: Web Audio treats a disabled track as absent.
    active.mixer.setGain('mic', this.#micMuted ? 0 : 1)
    this.#emitStatus()
  }

  clearError(): void {
    this.#error = null
  }

  /** Finishes whatever is in flight so the app can exit without losing a take. */
  async settle(): Promise<void> {
    if (this.#phase === 'starting' || this.#phase === 'countdown') {
      this.#startAbort?.abort()
      await this.#starting
    }
    if (this.#ending) await this.#ending
    if (this.#active) await this.stop()
  }
}

export const recorder = new Recorder()

export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  const audioInputs = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'audioinput',
    )

  let inputs = await audioInputs()
  if (inputs.some((device) => !device.label)) {
    // Labels stay empty until the page has been granted microphone access once.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of probe.getTracks()) track.stop()
      inputs = await audioInputs()
    } catch (error) {
      warn('microphone permission not granted')(error)
    }
  }

  // "default" and "communications" are aliases; null already means the system default.
  return inputs
    .filter(
      (device) =>
        device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications',
    )
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }))
}

const METER_FLOOR_DB = -60

export async function openLevelMeter(
  deviceId: string | null,
): Promise<{ level(): number; close(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
  let context: AudioContext
  try {
    context = new AudioContext()
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    throw error
  }
  if (context.state === 'suspended') {
    await context.resume().catch(warn('meter audio context suspended'))
  }

  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  // Chromium only pulls analysers whose graph reaches the destination; gain 0 keeps it silent.
  const silent = context.createGain()
  silent.gain.value = 0
  source.connect(analyser).connect(silent).connect(context.destination)
  const buffer = new Float32Array(analyser.fftSize)

  let closed = false
  return {
    level() {
      if (closed) return 0
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (const sample of buffer) sum += sample * sample
      const rms = Math.sqrt(sum / buffer.length)
      if (rms <= 0) return 0
      const decibels = 20 * Math.log10(rms)
      return Math.min(1, Math.max(0, (decibels - METER_FLOOR_DB) / -METER_FLOOR_DB))
    },
    close() {
      if (closed) return
      closed = true
      source.disconnect()
      analyser.disconnect()
      silent.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close()
    },
  }
}

async function focusRecordPage(): Promise<void> {
  // getDisplayMedia needs a click in the window, so the shortcut only brings the page up.
  location.hash = '#/record'
  await restoreMainWindow()
}

function handleHudAction(action: HudActionName): void {
  switch (action) {
    case 'stop':
      void recorder.stop()
      break
    case 'pause':
      recorder.pause()
      break
    case 'resume':
      recorder.resume()
      break
    case 'mute':
      if (!recorder.micMuted) recorder.toggleMute()
      break
    case 'unmute':
      if (recorder.micMuted) recorder.toggleMute()
      break
    case 'discard':
      void recorder.discard()
      break
  }
}

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === 'main'
  } catch {
    return false
  }
}

if (isMainWindow()) {
  onHudAction(handleHudAction).catch(warn('HUD actions unavailable'))
  onRecordToggle(() => {
    if (recorder.phase === 'idle') void focusRecordPage().catch(warn('could not show the recorder'))
    else void recorder.stop()
  }).catch(warn('record shortcut unavailable'))
  onQuitRequested(() => {
    void recorder
      .settle()
      .catch(warn('recording could not be finished before quitting'))
      .then(() => appQuit())
      .catch(warn('quit failed'))
  }).catch(warn('quit handling unavailable'))
}
