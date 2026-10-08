import type { Transcript } from '@butterfly-record/core'

import { writeFile } from './fsio.ts'
import { pickSavePath, sidecarReadText, sidecarWriteText } from './ipc.ts'
import { library, type VideoItem } from './library.svelte.ts'
import { addOutput, transcriptName } from './manifests.ts'
import { captionText, parseTranscript } from './transcript-data.ts'
import { captionBaseName } from './titles.ts'

export { captionText }

/** `language` undefined or null reads the original transcript.json. */
export async function readTranscript(
  id: string,
  language?: string | null,
): Promise<Transcript | null> {
  const text = await sidecarReadText(id, transcriptName(language))
  return text === null ? null : parseTranscript(text)
}

export function writeTranscript(
  id: string,
  transcript: Transcript,
  language?: string | null,
): Promise<void> {
  return sidecarWriteText(id, transcriptName(language), `${JSON.stringify(transcript, null, 2)}\n`)
}

/**
 * Saves captions next to the recording ("<title>.<lang>.<format>") or wherever the user
 * chooses. Resolves with the saved path, or null when the save dialog was cancelled.
 */
export async function exportCaptions(
  item: VideoItem,
  language: string | null,
  format: 'srt' | 'vtt' | 'txt',
  destination: 'library' | 'choose',
): Promise<string | null> {
  const transcript = await readTranscript(item.id, language)
  if (!transcript) throw new Error('There is no transcript to export yet.')
  const code = language ?? transcript.language
  const bytes = new TextEncoder().encode(captionText(transcript, format))
  const baseName = captionBaseName(item.title, code)

  if (destination === 'choose') {
    const path = await pickSavePath(`${baseName}.${format}`, [format])
    if (!path) return null
    const saved = await writeFile({ kind: 'path', path }, (writer) => writer.write(bytes, 0))
    return saved.path
  }

  const saved = await writeFile({ kind: 'output', id: item.id, baseName, ext: format }, (writer) =>
    writer.write(bytes, 0),
  )
  await addOutput(item.id, {
    kind: 'captions',
    language: code,
    path: saved.relPath ?? saved.path,
    method: 'export',
    createdAt: new Date().toISOString(),
  })
  await library.refresh()
  return saved.path
}
