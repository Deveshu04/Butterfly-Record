import {
  assertIdle,
  beginRecording,
  cancelRecording,
  downloadSettled,
  isRecording,
  levels,
  markFailed,
  pauseRecording,
  resumeRecording,
  setSourceMuted,
  status,
  stopRecording,
  tryMicrophone,
} from '../../lib/recording-host.ts'
import {
  fail,
  isFor,
  ok,
  type CaptureOptions,
  type DeviceChoice,
  type DeviceList,
  type OffscreenRequest,
} from '../../lib/messages.ts'
import { checkFolderAccess } from '../../lib/recordings-folder.ts'
import { videoConstraintsFor } from '../../lib/settings.ts'

/**
 * Tab capture needs the legacy `mandatory` form; the modern syntax is silently
 * ignored (yielding the webcam), so quality caps go here too. minFrameRate stops
 * Chrome dropping below 1 fps on a static tab.
 */
function tabCaptureConstraints(
  streamId: string,
  withTabAudio: boolean,
  capture: CaptureOptions,
): MediaStreamConstraints {
  return {
    // Omit the track rather than mute it: Chrome only silences a tab while capturing it.
    audio: withTabAudio
      ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: Math.round((capture.maxHeight * 16) / 9),
        maxHeight: capture.maxHeight,
        maxFrameRate: capture.frameRate,
        minFrameRate: 5,
      },
    },
  } as unknown as MediaStreamConstraints
}

/** `displaySurface` only sets the picker's initial pane; unshared audio is simply absent. */
async function startDisplayRecording(
  request: Extract<OffscreenRequest, { type: 'start-display' }>,
) {
  assertIdle()
  const captureStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: request.scope === 'screen' ? 'monitor' : 'window',
      ...videoConstraintsFor(request.capture),
    },
    audio: {
      // Keep local playback; display audio is not monitored, so it is heard once.
      suppressLocalAudioPlayback: false,
    },
  } as DisplayMediaStreamOptions)

  const micStream = request.withMicrophone
    ? await tryMicrophone(request.capture.microphoneId)
    : null
  const [video] = captureStream.getVideoTracks()

  console.info('[butterfly-record] display stream live', {
    surface: video?.getSettings().displaySurface,
    state: video?.readyState,
    systemAudio: captureStream.getAudioTracks().length,
    mic: micStream?.getAudioTracks().length ?? 0,
  })

  return beginRecording({
    sessionId: request.sessionId,
    surface: request.scope === 'screen' ? 'display' : 'window',
    sourceLabel: video?.label || (request.scope === 'screen' ? 'Entire screen' : 'Window'),
    captureStream,
    micStream,
    countdownMs: request.countdownMs,
    host: 'offscreen',
  })
}

// Pre-roll mic meter. Never connected to ctx.destination, which would feed back.
let monitor: { stream: MediaStream; ctx: AudioContext; analyser: AnalyserNode } | null = null

async function startMonitor(microphoneId: string | null): Promise<null> {
  stopMonitor()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: microphoneId ? { deviceId: { ideal: microphoneId } } : true,
  })
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  monitor = { stream, ctx, analyser }
  return null
}

function stopMonitor(): void {
  if (!monitor) return
  for (const track of monitor.stream.getTracks()) track.stop()
  void monitor.ctx.close().catch(() => {})
  monitor = null
}

/** Raw RMS 0..1, keyed like the mixer's levels so the overlay reads one shape. */
function monitorLevels(): Record<string, number> {
  // During a recording, report the mixer's meters instead of opening the mic twice.
  if (isRecording()) return levels()
  if (!monitor) return {}
  const buffer = new Float32Array(monitor.analyser.fftSize)
  monitor.analyser.getFloatTimeDomainData(buffer)
  let sum = 0
  for (const sample of buffer) sum += sample * sample
  return { mic: Math.sqrt(sum / buffer.length) }
}

async function handle(request: OffscreenRequest): Promise<unknown> {
  switch (request.type) {
    case 'start-display':
      // The recording opens its own mic; release the monitor's copy.
      stopMonitor()
      return startDisplayRecording(request)
    case 'download-settled':
      return downloadSettled(request)
    case 'start-tab': {
      assertIdle()
      stopMonitor()
      const captureStream = await navigator.mediaDevices.getUserMedia(
        tabCaptureConstraints(request.streamId, request.withTabAudio, request.capture),
      )
      const micStream = request.withMicrophone
        ? await tryMicrophone(request.capture.microphoneId)
        : null
      return beginRecording({
        sessionId: request.sessionId,
        surface: 'tab',
        sourceLabel: request.sourceLabel,
        captureStream,
        micStream,
        countdownMs: request.countdownMs,
        host: 'offscreen',
      })
    }
    case 'stop':
      return stopRecording()
    case 'cancel':
      return cancelRecording()
    case 'pause':
      return pauseRecording()
    case 'resume':
      return resumeRecording()
    case 'status':
      return status()
    case 'set-mic-muted':
      return setSourceMuted('mic', request.muted)
    case 'list-devices':
      return listDevices()
    case 'start-monitor':
      return startMonitor(request.microphoneId)
    case 'stop-monitor':
      stopMonitor()
      return null
    case 'levels':
      return monitorLevels()
    case 'check-folder':
      return checkFolderAccess()
  }
}

/** Runs here because device labels are only visible at the extension origin once granted. */
async function listDevices(): Promise<DeviceList> {
  const all = await navigator.mediaDevices.enumerateDevices()
  const pick = (kind: MediaDeviceKind, fallback: string): DeviceChoice[] =>
    all
      .filter((device) => device.kind === kind && device.deviceId)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }))

  const cameras = pick('videoinput', 'Camera')
  const microphones = pick('audioinput', 'Microphone')
  const named = [...cameras, ...microphones]

  return {
    cameras,
    microphones,
    labelled: named.length > 0 && named.every((device) => !/ \d+$/.test(device.label)),
  }
}

/** Only a failed start marks the host failed; stop and cancel clean up after themselves. */
const START_TYPES = new Set<OffscreenRequest['type']>(['start-tab', 'start-display'])

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isFor(message, 'offscreen')) return false

  handle(message).then(
    (value) => sendResponse(ok(value)),
    (error) => {
      if (START_TYPES.has(message.type)) markFailed(error)
      sendResponse(fail(error))
    },
  )
  // Keeps the message channel open for the async reply.
  return true
})
