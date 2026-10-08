// Persisted in chrome.storage.local. loadSettings merges defaults, so keys added
// in later versions are never undefined.

import type { RecordScope } from './messages.ts'

const KEY = 'settings'

export type CountdownSeconds = 0 | 3 | 5 | 10

/** Bubble resize bounds, in CSS px. */
export const CAMERA_MIN_SIZE = 96
export const CAMERA_MAX_SIZE = 480
/** A rounded frame is 16:9; this is its width relative to `cameraSize`. */
export const ROUNDED_ASPECT = 16 / 9
export type QualityCap = 720 | 1080 | 1440 | 2160

export interface Settings {
  scope: RecordScope
  microphoneEnabled: boolean
  /** deviceId, or null for the system default. */
  microphoneId: string | null
  cameraEnabled: boolean
  cameraId: string | null
  mirrorCamera: boolean
  cameraShape: 'circle' | 'rounded'
  /** Bubble edge length in CSS px. */
  cameraSize: number
  /** Tab scope only. */
  tabAudioEnabled: boolean
  countdownSeconds: CountdownSeconds
  /** Upper bound; capture never upscales past the source. */
  maxHeight: QualityCap
  frameRate: 30 | 60
  showHud: boolean
  showClickHighlight: boolean
  showCursorSpotlight: boolean
  /** Any CSS colour. */
  penColour: string
  /** Burned into the video, not just shown in the HUD. */
  showTimerInRecording: boolean
  cameraOnTop: boolean
  /**
   * Chrome salts `deviceId` per top-level site, so the offscreen document's id
   * does not match inside the bubble iframe; the bubble falls back to this label.
   */
  cameraLabel: string | null
  /** `auto` prefers WebCodecs, which writes duration and seek index with no repair pass. */
  encoder: 'auto' | 'webcodecs' | 'media-recorder'
  autoTranscribe: boolean
  /** Hugging Face model id used for on-device transcription. */
  transcriptionModel: string
  /** Captures page console output and failed requests; off by default for privacy. */
  devReport: boolean
  quickRecord: boolean
  /** Origins where the Quick Record button was dismissed. */
  quickRecordDisabledOrigins: string[]
  /** Document Picture-in-Picture keeps the HUD out of the captured tab. */
  hudInPip: boolean
  /** With 'none', nothing is uploaded. */
  shareDestination: 'none' | 'server'
  /** Base URL of a self-hosted butterfly-share instance. */
  shareServerUrl: string
  /** Upload token printed by that instance at startup. */
  shareToken: string
}

export const DEFAULT_SETTINGS: Settings = {
  scope: 'tab',
  microphoneEnabled: true,
  microphoneId: null,
  cameraEnabled: false,
  cameraId: null,
  mirrorCamera: false,
  cameraShape: 'circle',
  cameraSize: 176,
  tabAudioEnabled: true,
  countdownSeconds: 3,
  maxHeight: 1080,
  frameRate: 30,
  showHud: true,
  showClickHighlight: true,
  showCursorSpotlight: false,
  penColour: '#ff3b30',
  showTimerInRecording: false,
  cameraOnTop: true,
  cameraLabel: null,
  encoder: 'auto',
  autoTranscribe: false,
  transcriptionModel: 'onnx-community/whisper-base',
  devReport: false,
  quickRecord: false,
  quickRecordDisabledOrigins: [],
  hudInPip: false,
  shareDestination: 'none',
  shareServerUrl: '',
  shareToken: '',
}

/** Height is a ceiling (`max`, not `ideal`), so capture never upscales past the source. */
export function videoConstraintsFor(settings: {
  maxHeight: number
  frameRate: number
}): MediaTrackConstraints {
  return {
    height: { max: settings.maxHeight },
    width: { max: Math.round((settings.maxHeight * 16) / 9) },
    frameRate: { ideal: settings.frameRate, max: settings.frameRate },
  }
}

export const QUALITY_CHOICES: ReadonlyArray<{ value: QualityCap; label: string }> = [
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
  { value: 1440, label: '1440p' },
  { value: 2160, label: '4K' },
]

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY)
  return { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings> | undefined) ?? {}) }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await chrome.storage.local.set({ [KEY]: next })
  return next
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !changes[KEY]) return
    listener({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) })
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}

export interface MediaDeviceChoice {
  deviceId: string
  label: string
}

/** Labels stay empty until the device class is granted; `labelled: false` signals that. */
export async function listDevices(kind: MediaDeviceKind): Promise<{
  devices: MediaDeviceChoice[]
  labelled: boolean
}> {
  let all: MediaDeviceInfo[] = []
  try {
    all = await navigator.mediaDevices.enumerateDevices()
  } catch {
    return { devices: [], labelled: false }
  }

  const matching = all.filter((device) => device.kind === kind && device.deviceId !== '')
  return {
    devices: matching.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `${kindNoun(kind)} ${index + 1}`,
    })),
    labelled: matching.length > 0 && matching.every((device) => device.label !== ''),
  }
}

function kindNoun(kind: MediaDeviceKind): string {
  if (kind === 'audioinput') return 'Microphone'
  if (kind === 'videoinput') return 'Camera'
  return 'Device'
}
