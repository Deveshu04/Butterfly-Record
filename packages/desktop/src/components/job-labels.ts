import type { Job } from '../lib/jobs.svelte.ts'
import { languageName } from '../lib/languages.ts'

const VERBS: Record<Job['kind'], string> = {
  transcribe: 'Transcribing',
  translate: 'Translating',
  dub: 'Dubbing',
  summarize: 'Summarizing',
  recover: 'Recovering',
  import: 'Importing',
}

const NOUNS: Record<Job['kind'], string> = {
  transcribe: 'Transcription',
  translate: 'Translation',
  dub: 'Dubbing',
  summarize: 'Summary',
  recover: 'Recovery',
  import: 'Import',
}

/** "Transcribing", "Translating" — short enough for a badge. */
export function jobLabel(job: Job): string {
  return VERBS[job.kind]
}

/** "Translating to Hindi" — for progress rows that have the room. */
export function jobTitle(job: Job): string {
  const verb = VERBS[job.kind]
  if (job.language && (job.kind === 'translate' || job.kind === 'dub')) return `${verb} to ${languageName(job.language)}`
  return verb
}

/** "Translation to Hindi failed", "Transcription cancelled". */
export function jobOutcome(job: Job, outcome: 'failed' | 'cancelled'): string {
  const noun = NOUNS[job.kind]
  const target = job.language && (job.kind === 'translate' || job.kind === 'dub') ? ` to ${languageName(job.language)}` : ''
  return `${noun}${target} ${outcome}`
}
