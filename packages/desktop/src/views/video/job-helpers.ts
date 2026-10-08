import { jobs, type Job, type JobKind } from '../../lib/jobs.svelte.ts'
import type { VideoItem } from '../../lib/library.svelte.ts'
import { toasts } from '../../components/toasts.svelte.ts'

/** The newest job of `kind` for a video. */
export function latestJob(videoId: string, kind: JobKind): Job | undefined {
  let found: Job | undefined
  for (const job of jobs.forVideo(videoId)) {
    if (job.kind === kind && (!found || job.startedAt >= found.startedAt)) found = job
  }
  return found
}

/**
 * Runs a job action and reports whether its job finished. Failures inside a job show on
 * the job itself; anything thrown before a job exists needs a toast instead.
 */
export async function runAction(videoId: string, kind: JobKind, action: () => Promise<void>): Promise<boolean> {
  const started = Date.now()
  try {
    await action()
  } catch (error) {
    toasts.error(error)
    return false
  }
  const job = latestJob(videoId, kind)
  return job !== undefined && job.startedAt >= started && job.state === 'done'
}

/** Summary jobs have no progress card of their own, so their outcome is reported as a toast. */
export async function summarizeVideo(item: VideoItem, onview?: () => void): Promise<void> {
  const done = await runAction(item.id, 'summarize', () => jobs.summarize(item))
  if (done) {
    toasts.push('Description updated from the transcript.', onview ? { tone: 'ok', action: { label: 'View', run: onview } } : { tone: 'ok' })
    return
  }
  const job = latestJob(item.id, 'summarize')
  if (job && job.state !== 'running') {
    if (job.state === 'failed') toasts.push(job.error ?? 'The summary could not be written.', { tone: 'error' })
    jobs.dismiss(job.task)
  }
}
