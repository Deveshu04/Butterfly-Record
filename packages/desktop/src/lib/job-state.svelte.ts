// The live list of background jobs, shared by the library (recover, import) and the
// Sarvam workflows. Remote progress arrives as `sarvam-progress` events keyed by task.

import { ulid } from '@butterfly-record/core'
import { ConversionCanceledError } from 'mediabunny'

import { errorMessage, isIpcError, onSarvamProgress, sarvamCancel } from './ipc.ts'

export type JobKind = 'transcribe' | 'translate' | 'dub' | 'summarize' | 'recover' | 'import'

export interface Job {
  task: string
  videoId: string
  kind: JobKind
  language: string | null
  stage: string
  fraction: number | null
  message: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  startedAt: number
}

export interface JobContext {
  readonly task: string
  readonly signal: AbortSignal
  /** Local progress; `fraction` null shows an indeterminate bar. */
  progress(stage: string, message: string, fraction?: number | null): void
}

const list = $state<Job[]>([])
const controllers = new Map<string, AbortController>()

export function jobList(): Job[] {
  return list
}

export function newTask(kind: JobKind): string {
  return `${kind}-${ulid()}`
}

function find(task: string): Job | undefined {
  return list.find((job) => job.task === task)
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (isIpcError(error)) return error.code === 'cancelled'
  if (error instanceof ConversionCanceledError) return true
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Runs `work` as a visible job. Resolves with its result; rejects with its error after
 * recording the failure (or cancellation) on the job.
 */
export async function runJob<T>(
  kind: JobKind,
  videoId: string,
  language: string | null,
  work: (context: JobContext) => Promise<T>,
  options: { task?: string; doneMessage?: (result: T) => string } = {},
): Promise<T> {
  const task = options.task ?? newTask(kind)
  const controller = new AbortController()
  controllers.set(task, controller)

  // A resumed task replaces any earlier record of itself.
  const existing = list.findIndex((job) => job.task === task)
  if (existing >= 0) list.splice(existing, 1)
  list.push({
    task,
    videoId,
    kind,
    language,
    stage: 'starting',
    fraction: null,
    message: 'Starting…',
    state: 'running',
    error: null,
    startedAt: Date.now(),
  })

  const context: JobContext = {
    task,
    signal: controller.signal,
    progress(stage, message, fraction = null) {
      const job = find(task)
      if (!job || job.state !== 'running') return
      job.stage = stage
      job.message = message
      job.fraction = fraction
    },
  }

  try {
    const result = await work(context)
    const job = find(task)
    if (job) {
      job.state = 'done'
      job.stage = 'done'
      job.fraction = 1
      job.message = options.doneMessage?.(result) ?? 'Done'
    }
    return result
  } catch (error) {
    const job = find(task)
    if (job) {
      if (isCancellation(error, controller.signal)) {
        job.state = 'cancelled'
        job.stage = 'cancelled'
        job.message = 'Cancelled'
      } else {
        job.state = 'failed'
        job.stage = 'failed'
        job.error = errorMessage(error)
        job.message = job.error
      }
    }
    throw error
  } finally {
    controllers.delete(task)
  }
}

export async function cancelJob(task: string): Promise<void> {
  controllers.get(task)?.abort()
  await sarvamCancel(task).catch(() => {})
}

export function dismissJob(task: string): void {
  const index = list.findIndex((job) => job.task === task)
  if (index >= 0 && list[index]!.state !== 'running') list.splice(index, 1)
}

void onSarvamProgress((progress) => {
  const job = find(progress.task)
  if (!job || job.state !== 'running') return
  job.stage = progress.stage
  job.message = progress.message
  job.fraction = progress.fraction
}).catch((error: unknown) => console.warn('[butterfly-record] progress events unavailable', error))
