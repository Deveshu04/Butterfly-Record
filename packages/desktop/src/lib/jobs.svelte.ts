// Sarvam workflows: transcribe, translate, dub (Sarvam Dubbing or Bulbul voice) and
// summarize. Every run is a visible job; failures land on the job, never as a rejection.

import type { Transcript } from '@butterfly-record/core'
import { parseSrt } from '@butterfly-record/core/transcript'

import { estimateCost } from './cost.ts'
import { renderTtsDub } from './dub-render.ts'
import {
  errorMessage,
  isIpcError,
  sarvamDub,
  sarvamPendingJobs,
  sarvamSummarize,
  sarvamTranscribe,
  sarvamTranslate,
  sidecarReadText,
  sidecarRemove,
  type CommitResult,
  type DubRequest,
  type DubResult,
  type ReadTarget,
  type SttRequest,
  type SttResult,
  type TranslateModel,
} from './ipc.ts'
import {
  cancelJob,
  dismissJob,
  jobList,
  runJob,
  type Job,
  type JobContext,
  type JobKind,
} from './job-state.svelte.ts'
import { canonicalLanguage, findLanguage, iso639, languageName } from './languages.ts'
import { library, type VideoItem } from './library.svelte.ts'
import { addOutput, readManifest } from './manifests.ts'
import {
  extractDubUploadAudio,
  extractSttAudio,
  muxDub,
  probeFile,
  saveSidecarAsOutput,
  type JobHooks,
} from './media.ts'
import { settings } from './settings.svelte.ts'
import { readTranscript, writeTranscript } from './transcripts.ts'
import { buildTranscript, transcriptForSummary, translateTranscript } from './transcript-data.ts'
import { cleanTitle, dubBaseName, fileExtension, isDefaultTitle } from './titles.ts'

export { estimateCost, type Job, type JobKind }

export interface TranscribeOptions {
  /** 'unknown' = auto-detect. */
  language: string
  /** 'translate' produces an English transcript. */
  mode: 'transcribe' | 'translate'
  diarize: boolean
  numSpeakers: number | null
}

export interface DubOptions {
  targets: string[]
  method: 'sarvam-dubbing' | 'tts'
  /** 1..10, or -1 to auto-detect. */
  numSpeakers: number
  upload: 'audio' | 'video'
  /** Bulbul voice for the tts method. */
  speaker: string
  /** tts method: keep the original soundtrack quietly under the new voice. */
  keepOriginalAudio: boolean
}

/** Errors that would fail every remaining language the same way. */
const FATAL_CODES = new Set([
  'no_key',
  'invalid_key',
  'quota',
  'network',
  'rate_limited',
  'cancelled',
])

function quiet(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  )
}

function hooksFor(job: JobContext, stage: string, message: string): JobHooks {
  return { signal: job.signal, onProgress: (fraction) => job.progress(stage, message, fraction) }
}

function requireMedia(item: VideoItem): void {
  if (item.status !== 'ready' || !item.mediaPath) {
    throw new Error('The video file is missing, so this cannot run. Recover or locate it first.')
  }
}

async function removeSidecars(id: string, names: readonly string[]): Promise<void> {
  for (const name of names) await sidecarRemove(id, name).catch(() => {})
}

function isCancelled(error: unknown, job: JobContext): boolean {
  return (
    job.signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (isIpcError(error) && error.code === 'cancelled')
  )
}

// Transcription

function sttModelLabel(request: Pick<SttRequest, 'model' | 'mode'>): string {
  return request.mode === 'transcribe' ? request.model : `${request.model} (${request.mode})`
}

/** True when the transcript is an English translation of the speech, not the speech itself. */
function isTranslatedSpeech(transcript: Transcript): boolean {
  return transcript.model.endsWith('(translate)')
}

async function saveSttResult(request: SttRequest, result: SttResult): Promise<void> {
  const language =
    canonicalLanguage(result.language) ??
    (request.mode === 'translate'
      ? 'en-IN'
      : request.language !== 'unknown'
        ? request.language
        : 'unknown')
  const transcript = buildTranscript(result.segments, {
    language,
    model: sttModelLabel(request),
    duration: request.duration,
  })
  await writeTranscript(request.id, transcript)
}

async function runTranscription(request: SttRequest): Promise<void> {
  try {
    const result = await sarvamTranscribe(request)
    await saveSttResult(request, result)
  } finally {
    await removeSidecars(request.id, request.files)
  }
  await library.refresh()
}

function transcribe(item: VideoItem, options: TranscribeOptions): Promise<void> {
  const outputLanguage =
    options.mode === 'translate'
      ? 'en-IN'
      : options.language === 'unknown'
        ? null
        : options.language
  return quiet(
    runJob('transcribe', item.id, outputLanguage, async (job) => {
      requireMedia(item)
      const message = 'Preparing the audio'
      job.progress('extracting', message, 0)
      const audio = await extractSttAudio(item.id, hooksFor(job, 'extracting', message))
      job.progress('uploading', 'Sending the audio to Sarvam')
      await runTranscription({
        task: job.task,
        id: item.id,
        files: audio.files,
        offsets: audio.offsets,
        duration: audio.duration,
        language: options.language,
        model: settings.value.sarvam.sttModel,
        mode: options.mode,
        diarize: options.diarize,
        numSpeakers: options.diarize ? options.numSpeakers : null,
      })
    }),
  )
}

// Translation

function translateModelFor(source: string, target: string): TranslateModel {
  const preferred = settings.value.sarvam.translateModel
  // Mayura covers fewer languages; fall back rather than fail.
  if (preferred === 'mayura:v1' && findLanguage(source)?.mayura && findLanguage(target)?.mayura) {
    return 'mayura:v1'
  }
  return 'sarvam-translate:v1'
}

async function translateInto(
  item: VideoItem,
  target: string,
  job: JobContext,
): Promise<Transcript> {
  const original = await readTranscript(item.id)
  if (!original || original.segments.length === 0) throw new Error('Transcribe this video first.')
  const source = canonicalLanguage(original.language)
  if (!source) {
    throw new Error(
      'The language of this transcript is unknown, so it cannot be translated. ' +
        'Transcribe it again with its language selected.',
    )
  }
  const language = canonicalLanguage(target)
  if (!language) throw new Error(`${target} is not a supported language.`)
  if (language === source) {
    throw new Error(`The transcript is already in ${languageName(language)}.`)
  }

  const model = translateModelFor(source, language)
  job.progress('translating', `Translating into ${languageName(language)}`)
  const texts = await sarvamTranslate({
    task: job.task,
    texts: original.segments.map((segment) => segment.text),
    source,
    target: language,
    model,
  })
  const translated = translateTranscript(original, texts, { language, model })
  await writeTranscript(item.id, translated, language)
  return translated
}

function translate(item: VideoItem, target: string): Promise<void> {
  return quiet(
    runJob('translate', item.id, canonicalLanguage(target) ?? target, async (job) => {
      await translateInto(item, target, job)
      await library.refresh()
    }),
  )
}

// Dubbing

function trackMetadata(language: string): { languageCode?: string; name: string } {
  const code = iso639(language)
  return code
    ? { languageCode: code, name: languageName(language) }
    : { name: languageName(language) }
}

/** The language spoken in the video, which Sarvam Dubbing needs to be told. */
async function spokenLanguage(item: VideoItem): Promise<string> {
  const transcript = await readTranscript(item.id)
  const fromTranscript =
    transcript && !isTranslatedSpeech(transcript) ? canonicalLanguage(transcript.language) : null
  if (fromTranscript) return fromTranscript
  const preferred = settings.value.sarvam.sttLanguage
  if (preferred !== 'unknown') return preferred
  throw new Error(
    'Sarvam Dubbing needs to know the spoken language. Transcribe the video first, ' +
      'or choose a default transcription language in Settings.',
  )
}

/** Subtitles the user translated themselves outrank a dub's own SRT and are never replaced. */
async function saveSrtAsTranscript(
  id: string,
  name: string,
  language: string,
  duration: number,
): Promise<void> {
  const existing = await readTranscript(id, language).catch(() => null)
  if (existing && existing.segments.length > 0 && existing.model !== 'sarvam-dubbing') return
  const text = await sidecarReadText(id, name)
  if (!text) return
  const transcript = buildTranscript(parseSrt(text), {
    language,
    model: 'sarvam-dubbing',
    duration,
  })
  if (transcript.segments.length > 0) await writeTranscript(id, transcript, language)
}

async function finishSarvamDub(
  item: VideoItem,
  request: DubRequest,
  result: DubResult,
  job: JobContext,
): Promise<string> {
  const saved: string[] = []
  const failed = result.failed.map((failure) => {
    const label = languageName(canonicalLanguage(failure.language) ?? failure.language)
    return `${label}: ${failure.message}`
  })
  const duration = item.duration ?? 0

  try {
    for (const language of request.targetLanguages) {
      const label = languageName(language)
      const outputs = result.outputs.filter(
        (output) => canonicalLanguage(output.language) === language,
      )
      const dubbed =
        outputs.find((output) => output.type === 'audio') ??
        outputs.find((output) => output.type === 'video') ??
        outputs.find((output) => output.type === 'mp3')
      if (!dubbed) {
        const reported = result.failed.some(
          (failure) => canonicalLanguage(failure.language) === language,
        )
        if (!reported) failed.push(`${label}: no dubbed file was returned`)
        continue
      }

      const baseName = dubBaseName(item.title, label)
      let committed: CommitResult
      if (dubbed.type === 'video') {
        const message = `Saving the ${label} video`
        committed = await saveSidecarAsOutput(
          item.id,
          dubbed.sidecarName,
          baseName,
          fileExtension(dubbed.sidecarName) || 'mp4',
          hooksFor(job, 'saving', message),
        )
      } else {
        const message = `Adding the ${label} audio to the video`
        const audio: ReadTarget = { kind: 'sidecar', id: item.id, name: dubbed.sidecarName }
        committed = await muxDub(
          item.id,
          audio,
          baseName,
          trackMetadata(language),
          hooksFor(job, 'muxing', message),
        )
      }
      await addOutput(item.id, {
        kind: 'dub',
        language,
        path: committed.relPath ?? committed.path,
        method: 'sarvam-dubbing',
        createdAt: new Date().toISOString(),
      })

      const srt = outputs.find((output) => output.type === 'srt')
      if (srt) await saveSrtAsTranscript(item.id, srt.sidecarName, language, duration)
      saved.push(label)
    }
  } finally {
    await removeSidecars(
      item.id,
      result.outputs.map((output) => output.sidecarName),
    )
    if (request.upload.kind === 'sidecar') await removeSidecars(item.id, [request.upload.name])
    await library.refresh().catch(() => {})
  }

  if (saved.length === 0) {
    throw new Error(failed.join('; ') || 'Sarvam did not return any dubbed audio.')
  }
  return failed.length > 0
    ? `Dubbed into ${saved.join(', ')}. Not dubbed: ${failed.join('; ')}`
    : `Dubbed into ${saved.join(', ')}`
}

async function dubWithSarvam(
  item: VideoItem,
  targets: string[],
  options: DubOptions,
  job: JobContext,
): Promise<string> {
  const source = await spokenLanguage(item)
  if (!findLanguage(source)?.dub) {
    throw new Error(
      `Sarvam Dubbing does not support ${languageName(source)} as the original language.`,
    )
  }
  const unsupported = targets.filter((target) => !findLanguage(target)?.dub)
  if (unsupported.length > 0) {
    throw new Error(`Sarvam Dubbing does not support ${unsupported.map(languageName).join(', ')}.`)
  }
  const wanted = targets.filter((target) => target !== source)
  if (wanted.length === 0) throw new Error(`The video is already in ${languageName(source)}.`)

  let upload: ReadTarget = { kind: 'media', id: item.id }
  if (options.upload === 'audio') {
    const message = 'Preparing the audio'
    job.progress('extracting', message, 0)
    const name = await extractDubUploadAudio(item.id, hooksFor(job, 'extracting', message))
    upload = { kind: 'sidecar', id: item.id, name }
  }

  const request: DubRequest = {
    task: job.task,
    id: item.id,
    upload,
    sourceLanguage: source,
    targetLanguages: wanted,
    numSpeakers: options.numSpeakers,
    // Audio-only uploads come back as audio and are put onto the video here, on this PC.
    exports: options.upload === 'audio' ? ['audio', 'srt'] : ['video', 'srt'],
  }
  job.progress('uploading', 'Sending to Sarvam')
  let result: DubResult
  try {
    result = await sarvamDub(request)
  } catch (error) {
    if (upload.kind === 'sidecar') await removeSidecars(item.id, [upload.name])
    throw error
  }
  return finishSarvamDub(item, request, result, job)
}

async function dubWithTts(
  item: VideoItem,
  targets: string[],
  options: DubOptions,
  job: JobContext,
): Promise<string> {
  const unsupported = targets.filter((target) => !findLanguage(target)?.tts)
  if (unsupported.length > 0) {
    throw new Error(
      `A text-to-speech voice is not available for ${unsupported.map(languageName).join(', ')}.`,
    )
  }
  const original = await readTranscript(item.id)
  if (!original || original.segments.length === 0) {
    throw new Error('Text-to-speech dubbing needs a transcript. Transcribe this video first.')
  }
  const duration = item.duration ?? (await probeFile({ kind: 'media', id: item.id })).duration

  const saved: string[] = []
  const failed: string[] = []
  for (const language of targets) {
    const label = languageName(language)
    try {
      let transcript = await readTranscript(item.id, language)
      if (!transcript) {
        transcript =
          canonicalLanguage(original.language) === language
            ? original
            : await translateInto(item, language, job)
      }

      const voicing = `Voicing ${label}`
      job.progress('voicing', voicing, 0)
      const track = await renderTtsDub({
        id: item.id,
        transcript,
        language,
        speaker: options.speaker,
        duration,
        keepOriginalAudio: options.keepOriginalAudio,
        ...hooksFor(job, 'voicing', voicing),
      })

      try {
        const message = `Adding the ${label} voice to the video`
        job.progress('muxing', message, 0)
        const committed = await muxDub(
          item.id,
          { kind: 'sidecar', id: item.id, name: track },
          dubBaseName(item.title, label),
          trackMetadata(language),
          hooksFor(job, 'muxing', message),
        )
        await addOutput(item.id, {
          kind: 'dub',
          language,
          path: committed.relPath ?? committed.path,
          method: 'tts',
          createdAt: new Date().toISOString(),
        })
        saved.push(label)
      } finally {
        await removeSidecars(item.id, [track])
      }
    } catch (error) {
      if (isCancelled(error, job) || (isIpcError(error) && FATAL_CODES.has(error.code))) throw error
      failed.push(`${label}: ${errorMessage(error)}`)
    }
  }

  await library.refresh().catch(() => {})
  if (saved.length === 0) throw new Error(failed.join('; '))
  return failed.length > 0
    ? `Dubbed into ${saved.join(', ')}. Not dubbed: ${failed.join('; ')}`
    : `Dubbed into ${saved.join(', ')}`
}

function dub(item: VideoItem, options: DubOptions): Promise<void> {
  const targets = [
    ...new Set(
      options.targets
        .map((target) => canonicalLanguage(target))
        .filter((code): code is string => code !== null),
    ),
  ]
  return quiet(
    runJob(
      'dub',
      item.id,
      targets.length === 1 ? targets[0]! : null,
      async (job) => {
        if (targets.length === 0) throw new Error('Choose at least one language to dub into.')
        requireMedia(item)
        return options.method === 'sarvam-dubbing'
          ? dubWithSarvam(item, targets, options, job)
          : dubWithTts(item, targets, options, job)
      },
      { doneMessage: (summary) => summary },
    ),
  )
}

// Summary

function summarize(item: VideoItem): Promise<void> {
  return quiet(
    runJob('summarize', item.id, null, async (job) => {
      const transcript = await readTranscript(item.id)
      if (!transcript || transcript.segments.length === 0) {
        throw new Error('Transcribe this video first.')
      }
      job.progress('summarizing', 'Writing a title and description')
      const result = await sarvamSummarize(
        transcriptForSummary(transcript),
        canonicalLanguage(transcript.language),
      )

      await library.setDescription(item.id, result.summary.trim())
      const manifest = await readManifest(item.id)
      const title = cleanTitle(result.title)
      const importedName = manifest?.producer.app === 'import' ? manifest.video.sourceLabel : null
      if (manifest && title && isDefaultTitle(manifest.title, importedName)) {
        await library.rename(item.id, title)
      }
    }),
  )
}

// Restart recovery

let resumed = false

async function resumePending(): Promise<void> {
  if (resumed) return
  resumed = true

  let pending
  try {
    pending = await sarvamPendingJobs()
  } catch (error) {
    console.warn('[butterfly-record] pending Sarvam jobs could not be read', error)
    return
  }
  if (pending.length === 0) return
  if (!library.info) await library.refresh().catch(() => {})

  for (const entry of pending) {
    const item = library.get(entry.request.id)
    if (!item) continue
    if (entry.kind === 'stt') {
      const request: SttRequest = { ...entry.request, resumeJobId: entry.jobId }
      const language =
        request.mode === 'translate'
          ? 'en-IN'
          : request.language === 'unknown'
            ? null
            : request.language
      void quiet(
        runJob('transcribe', item.id, language, () => runTranscription(request), {
          task: request.task,
        }),
      )
    } else {
      const request: DubRequest = { ...entry.request, resumeJobId: entry.jobId }
      const language = request.targetLanguages.length === 1 ? request.targetLanguages[0]! : null
      void quiet(
        runJob(
          'dub',
          item.id,
          language,
          async (job) => finishSarvamDub(item, request, await sarvamDub(request), job),
          { task: request.task, doneMessage: (summary) => summary },
        ),
      )
    }
  }
}

export const jobs = {
  get list(): Job[] {
    return jobList()
  },
  forVideo(videoId: string): Job[] {
    return jobList().filter((job) => job.videoId === videoId)
  },
  transcribe,
  translate,
  dub,
  summarize,
  cancel: cancelJob,
  dismiss: dismissJob,
  resumePending,
}
