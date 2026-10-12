// On-device transcription from the app's side: whether this PC has a usable GPU, which
// speech models are downloaded, and running a job in a worker.

import { formatBytes } from '@butterfly-record/core'
import type { TimedText } from '@butterfly-record/core/speech-windows'

import type { JobContext } from './job-state.svelte.ts'
import {
  MODEL_CACHE,
  PROFILES,
  cachedModels,
  modelFileUrl,
  profileFiles,
  whisperBackend,
  type CachedModel,
  type GpuInfo,
  type ProcessorChoice,
  type WhisperBackend,
  type WhisperModel,
} from './whisper-models.ts'
import type { WhisperEvent, WhisperJob } from './workers/whisper-protocol.ts'

// GPU

let gpuInfo = $state<GpuInfo | null>(null)
let gpuChecked = $state(false)
let probing: Promise<GpuInfo | null> | null = null

async function requestGpu(): Promise<GpuInfo | null> {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    // A software adapter is slower than WebAssembly.
    if (!adapter || adapter.info.isFallbackAdapter) return null
    const { vendor, architecture, description } = adapter.info
    return { vendor, architecture, description }
  } catch {
    return null
  }
}

export const gpu = {
  get info(): GpuInfo | null {
    return gpuInfo
  },
  get checked(): boolean {
    return gpuChecked
  },
  probe(): Promise<GpuInfo | null> {
    probing ??= requestGpu().then((info) => {
      gpuInfo = info
      gpuChecked = true
      return info
    })
    return probing
  },
}

// Downloaded models

let cachedFiles = $state<{ url: string; bytes: number }[]>([])
let cacheRead = $state(false)
let running = $state(0)

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(MODEL_CACHE)
  } catch {
    return null
  }
}

async function readCache(): Promise<void> {
  const cache = await openCache()
  const files: { url: string; bytes: number }[] = []
  for (const request of (await cache?.keys()) ?? []) {
    const response = await cache?.match(request)
    files.push({ url: request.url, bytes: Number(response?.headers.get('content-length')) || 0 })
  }
  cachedFiles = files
  cacheRead = true
}

export const speechModels = {
  get downloaded(): CachedModel[] {
    return cachedModels(cachedFiles)
  },
  get loaded(): boolean {
    return cacheRead
  },
  /** A transcription on this PC is running or waiting to; its model must stay put. */
  get busy(): boolean {
    return running > 0
  },
  refresh: () => readCache().catch(() => {}),

  /** Every file the backend needs is cached, so the model runs without a connection. */
  has(model: WhisperModel, backend: WhisperBackend): boolean {
    const urls = new Set(cachedFiles.map((file) => file.url))
    return profileFiles(PROFILES[backend]).every((file) => urls.has(modelFileUrl(model.repo, file)))
  },

  async remove(repo: string): Promise<void> {
    const cache = await openCache()
    if (cache) {
      const prefix = modelFileUrl(repo, '')
      for (const request of await cache.keys()) {
        if (request.url.startsWith(prefix)) await cache.delete(request)
      }
    }
    await readCache()
  },
}

// Running a job

export interface WhisperRequest {
  /** 16 kHz mono; handed over to the worker, so unusable afterwards. */
  samples: Float32Array
  model: WhisperModel
  processor: ProcessorChoice
  /** Whisper language code; null to detect it. */
  language: string | null
  task: 'transcribe' | 'translate'
}

export interface WhisperOutcome {
  /** Whisper language code; null when no speech was found. */
  language: string | null
  cues: TimedText[]
}

const GPU_HINT = 'If this keeps happening, choose CPU only for transcription in Settings.'

function transcribing(device: WhisperJob['profile']['device'] | null): string {
  return device === 'webgpu' ? 'Transcribing on this PC with the GPU' : 'Transcribing on this PC'
}

/** One model in memory at a time: a second job waits for the first. */
let queue: Promise<unknown> = Promise.resolve()

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export async function runWhisper(request: WhisperRequest, job: JobContext): Promise<WhisperOutcome> {
  if (running > 0) job.progress('waiting', 'Waiting for another transcription on this PC to finish')
  running++
  const before = queue
  let finished!: () => void
  queue = Promise.all([before, new Promise<void>((resolve) => (finished = resolve))])
  try {
    await Promise.race([before, whenAborted(job.signal)])
    return await runNow(request, job)
  } finally {
    running--
    finished()
  }
}

async function runNow(request: WhisperRequest, job: JobContext): Promise<WhisperOutcome> {
  job.signal.throwIfAborted()
  const backend = whisperBackend(
    request.processor,
    request.processor === 'cpu' ? null : await gpu.probe(),
  )
  await readCache().catch(() => {})
  let downloading = !speechModels.has(request.model, backend)

  const message: WhisperJob = {
    samples: request.samples,
    repo: request.model.repo,
    profile: PROFILES[backend],
    fallback: backend === 'gpu' ? PROFILES.cpu : null,
    language: request.language,
    task: request.task,
  }
  // Known once the model has loaded; a failure after that on the GPU may be the GPU's.
  let device: WhisperJob['profile']['device'] | null = null

  const worker = new Worker(new URL('./workers/whisper-worker.ts', import.meta.url), {
    type: 'module',
  })
  try {
    return await new Promise<WhisperOutcome>((resolve, reject) => {
      job.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
        once: true,
      })
      worker.addEventListener('error', (event) => {
        event.preventDefault()
        reject(new Error(event.message || 'The speech model stopped unexpectedly.'))
      })
      worker.addEventListener('message', (event: MessageEvent<WhisperEvent>) => {
        const data = event.data
        switch (data.type) {
          case 'download':
            if (downloading && data.loaded < data.total) {
              job.progress(
                'downloading-model',
                `Downloading the speech model, ${formatBytes(data.loaded)} of ${formatBytes(data.total)}`,
                data.loaded / data.total,
              )
            } else {
              job.progress('loading-model', 'Loading the speech model')
            }
            break
          case 'fallback':
            console.warn('[butterfly-record] the GPU could not load the speech model', data.reason)
            downloading = !speechModels.has(request.model, 'cpu')
            job.progress('loading-model', 'Loading the speech model on the CPU')
            break
          case 'ready':
            device = data.device
            job.progress('transcribing', transcribing(device), 0)
            break
          case 'detecting':
            job.progress('transcribing', 'Detecting the spoken language', 0)
            break
          case 'progress':
            job.progress('transcribing', transcribing(device), data.fraction)
            break
          case 'done':
            resolve({ language: data.language, cues: data.cues })
            break
          case 'failed':
            reject(new Error(device === 'webgpu' ? `${data.message} ${GPU_HINT}` : data.message))
            break
        }
      })
      if (downloading) job.progress('downloading-model', 'Downloading the speech model', 0)
      else job.progress('loading-model', 'Loading the speech model')
      worker.postMessage(message, [request.samples.buffer])
    })
  } finally {
    worker.terminate()
    void readCache().catch(() => {})
  }
}
