import {
  DEFAULT_CAMERA_EFFECTS,
  normalizeCameraEffects,
  type CameraEffects,
} from './camera-effects.ts'
import {
  CAMERA_CORNERS,
  CAMERA_SHAPES,
  DEFAULT_CAMERA_SIZE,
  clampCameraSize,
  type CameraCorner,
  type CameraShape,
} from './camera-layout.ts'
import { DEFAULT_TTS_SPEAKER, TTS_SPEAKERS, findLanguage } from './languages.ts'
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  type ProcessorChoice,
  type TranscriptionEngine,
  type WhisperModelId,
} from './whisper-models.ts'

export interface CameraSettings {
  enabled: boolean
  /** null = the system's default camera. */
  deviceId: string | null
  shape: CameraShape
  /** Overlay width in logical pixels; the height follows the shape. */
  size: number
  mirror: boolean
  /** Where the camera is drawn in window recordings, which cannot see the overlay. */
  corner: CameraCorner
  /** Last top-left of the overlay in physical screen pixels; null = place by corner. */
  position: { x: number; y: number } | null
  effects: CameraEffects
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  closeToTray: boolean
  recording: {
    scope: 'screen' | 'window'
    quality: '720p' | '1080p' | '1440p' | '2160p'
    frameRate: 30 | 60
    microphoneEnabled: boolean
    /** null = system default. */
    microphoneId: string | null
    countdown: boolean
    /** Minimize the main window while recording. */
    hideWindow: boolean
    camera: CameraSettings
  }
  sarvam: {
    sttModel: 'saaras:v4' | 'saaras:v3'
    /** 'unknown' = auto-detect. */
    sttLanguage: string
    diarize: boolean
    translateModel: 'sarvam-translate:v1' | 'mayura:v1'
    ttsSpeaker: string
  }
  transcription: {
    /** null until chosen: Sarvam when a key is saved, otherwise this PC. */
    engine: TranscriptionEngine | null
    model: WhisperModelId
    processor: ProcessorChoice
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  closeToTray: true,
  recording: {
    scope: 'screen',
    quality: '1080p',
    frameRate: 30,
    microphoneEnabled: true,
    microphoneId: null,
    countdown: true,
    hideWindow: true,
    camera: {
      enabled: false,
      deviceId: null,
      shape: 'circle',
      size: DEFAULT_CAMERA_SIZE,
      mirror: true,
      corner: 'bottom-right',
      position: null,
      effects: { ...DEFAULT_CAMERA_EFFECTS },
    },
  },
  sarvam: {
    sttModel: 'saaras:v4',
    sttLanguage: 'unknown',
    diarize: false,
    translateModel: 'sarvam-translate:v1',
    ttsSpeaker: DEFAULT_TTS_SPEAKER,
  },
  transcription: {
    engine: null,
    model: DEFAULT_WHISPER_MODEL,
    processor: 'auto',
  },
}

export const QUALITY_HEIGHT: Record<AppSettings['recording']['quality'], number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Screen coordinates can be negative on a monitor left of the primary one. */
function overlayPosition(value: unknown): { x: number; y: number } | null {
  const point = record(value)
  const { x, y } = point
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

function normalizeCamera(raw: unknown, defaults: CameraSettings): CameraSettings {
  const camera = record(raw)
  return {
    enabled: bool(camera.enabled, defaults.enabled),
    deviceId:
      typeof camera.deviceId === 'string' && camera.deviceId.length > 0 ? camera.deviceId : null,
    shape: pick(camera.shape, CAMERA_SHAPES, defaults.shape),
    size: clampCameraSize(typeof camera.size === 'number' ? camera.size : defaults.size),
    mirror: bool(camera.mirror, defaults.mirror),
    corner: pick(camera.corner, CAMERA_CORNERS, defaults.corner),
    position: overlayPosition(camera.position),
    effects: normalizeCameraEffects(camera.effects),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Settings files outlive versions and can be hand-edited, so every field is checked and
 * anything unknown or invalid falls back to its default.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const root = record(raw)
  const recording = record(root.recording)
  const sarvam = record(root.sarvam)
  const transcription = record(root.transcription)
  const defaults = DEFAULT_SETTINGS

  const sttLanguage =
    sarvam.sttLanguage === 'unknown'
      ? 'unknown'
      : (findLanguage(typeof sarvam.sttLanguage === 'string' ? sarvam.sttLanguage : null)?.code ??
        defaults.sarvam.sttLanguage)

  return {
    theme: pick(root.theme, ['system', 'light', 'dark'] as const, defaults.theme),
    closeToTray: bool(root.closeToTray, defaults.closeToTray),
    recording: {
      scope: pick(recording.scope, ['screen', 'window'] as const, defaults.recording.scope),
      quality: pick(
        recording.quality,
        ['720p', '1080p', '1440p', '2160p'] as const,
        defaults.recording.quality,
      ),
      frameRate: pick(recording.frameRate, [30, 60] as const, defaults.recording.frameRate),
      microphoneEnabled: bool(recording.microphoneEnabled, defaults.recording.microphoneEnabled),
      microphoneId:
        typeof recording.microphoneId === 'string' && recording.microphoneId.length > 0
          ? recording.microphoneId
          : null,
      countdown: bool(recording.countdown, defaults.recording.countdown),
      hideWindow: bool(recording.hideWindow, defaults.recording.hideWindow),
      camera: normalizeCamera(recording.camera, defaults.recording.camera),
    },
    sarvam: {
      sttModel: pick(
        sarvam.sttModel,
        ['saaras:v4', 'saaras:v3'] as const,
        defaults.sarvam.sttModel,
      ),
      sttLanguage,
      diarize: bool(sarvam.diarize, defaults.sarvam.diarize),
      translateModel: pick(
        sarvam.translateModel,
        ['sarvam-translate:v1', 'mayura:v1'] as const,
        defaults.sarvam.translateModel,
      ),
      ttsSpeaker: pick(
        sarvam.ttsSpeaker,
        TTS_SPEAKERS.map((speaker) => speaker.id),
        defaults.sarvam.ttsSpeaker,
      ),
    },
    transcription: {
      engine: pick(transcription.engine, ['local', 'sarvam', null] as const, null),
      model: pick(
        transcription.model,
        WHISPER_MODELS.map((model) => model.id),
        defaults.transcription.model,
      ),
      processor: pick(
        transcription.processor,
        ['auto', 'cpu'] as const,
        defaults.transcription.processor,
      ),
    },
  }
}

/** Constraints for getDisplayMedia: the height is a ceiling, so capture never upscales. */
export function displayVideoConstraints(
  recording: AppSettings['recording'],
): MediaTrackConstraints & { displaySurface: 'monitor' | 'window' } {
  const height = QUALITY_HEIGHT[recording.quality]
  return {
    displaySurface: recording.scope === 'screen' ? 'monitor' : 'window',
    height: { max: height },
    width: { max: Math.round((height * 16) / 9) },
    frameRate: { ideal: recording.frameRate, max: recording.frameRate },
  }
}
