// Messages between the on-device transcription job and the worker that runs Whisper.

import type { TimedText } from '@butterfly-record/core/speech-windows'

import type { WhisperProfile } from '../whisper-models.ts'

export interface WhisperJob {
  /** 16 kHz mono. */
  samples: Float32Array
  repo: string
  profile: WhisperProfile
  /** Used when the GPU cannot load the model. */
  fallback: WhisperProfile | null
  /** Whisper language code; null to detect it. */
  language: string | null
  task: 'transcribe' | 'translate'
}

export type WhisperEvent =
  | { type: 'download'; loaded: number; total: number }
  | { type: 'fallback'; reason: string }
  | { type: 'ready'; device: WhisperProfile['device'] }
  | { type: 'detecting' }
  | { type: 'progress'; fraction: number }
  | { type: 'done'; language: string | null; cues: TimedText[]; device: WhisperProfile['device'] }
  | { type: 'failed'; message: string }
