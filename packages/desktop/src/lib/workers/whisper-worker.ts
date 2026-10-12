// Runs Whisper for one transcription job, off the main thread. The job ends the worker:
// terminating it is the only way to stop inference midway, and it frees the model's memory.

import { transcribeWindows } from '@butterfly-record/core/speech-windows'
import { TARGET_SAMPLE_RATE, loadWhisper, type Whisper } from '@butterfly-record/core/transcribe'
// Served by the app: ONNX Runtime would otherwise fetch it from a CDN.
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

import { MODEL_CACHE, type WhisperProfile } from '../whisper-models.ts'
import type { WhisperEvent, WhisperJob } from './whisper-protocol.ts'

interface WorkerScope {
  postMessage(message: WhisperEvent): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WhisperJob>) => void): void
}

const scope = self as unknown as WorkerScope

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What Chromium throws when a request, or reading its body, loses the connection. */
function downloadFailed(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network/i.test(error.message)
}

const DOWNLOAD_FAILED =
  'The speech model could not be downloaded. Check the internet connection and try again; ' +
  'the parts already downloaded are kept.'

async function load(job: WhisperJob, profile: WhisperProfile): Promise<Whisper> {
  try {
    return await fetchAndLoad(job, profile)
  } catch (error) {
    if (!downloadFailed(error)) throw error
  }
  // A large file can fail midway on a flaky connection; finished files are cached already.
  try {
    return await fetchAndLoad(job, profile)
  } catch (error) {
    throw downloadFailed(error) ? new Error(DOWNLOAD_FAILED) : error
  }
}

function fetchAndLoad(job: WhisperJob, profile: WhisperProfile): Promise<Whisper> {
  return loadWhisper({
    model: job.repo,
    device: profile.device,
    dtype: profile.dtype,
    cacheName: MODEL_CACHE,
    wasmPaths: { wasm: new URL(ortWasm, location.href).href },
    onLoad: (event) => {
      if (event.status !== 'progress_total' || !event.total) return
      scope.postMessage({ type: 'download', loaded: event.loaded ?? 0, total: event.total })
    },
  })
}

async function run(job: WhisperJob): Promise<void> {
  let whisper: Whisper
  try {
    whisper = await load(job, job.profile)
  } catch (error) {
    if (!job.fallback || messageOf(error) === DOWNLOAD_FAILED) throw error
    scope.postMessage({ type: 'fallback', reason: messageOf(error) })
    whisper = await load(job, job.fallback)
  }
  scope.postMessage({ type: 'ready', device: whisper.device })

  const { language, cues } = await transcribeWindows(whisper, job.samples, TARGET_SAMPLE_RATE, {
    language: job.language,
    task: job.task,
    onDetecting: () => scope.postMessage({ type: 'detecting' }),
    onProgress: (fraction) => scope.postMessage({ type: 'progress', fraction }),
  })
  scope.postMessage({ type: 'done', language, cues, device: whisper.device })
}

scope.addEventListener('message', (event) => {
  run(event.data).catch((error: unknown) => {
    console.error('[butterfly-record] on-device transcription failed', error)
    scope.postMessage({ type: 'failed', message: messageOf(error) })
  })
})
