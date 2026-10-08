import type { VideoItem } from '../../lib/library.svelte.ts'
import { library } from '../../lib/library.svelte.ts'
import { captionText, exportCaptions, readTranscript } from '../../lib/transcripts.ts'
import { baseName } from '../../components/format.ts'
import type { MenuEntry } from '../../components/menu.svelte.ts'
import { toasts } from '../../components/toasts.svelte.ts'

type Format = 'srt' | 'vtt' | 'txt'

const FORMATS: { format: Format; label: string }[] = [
  { format: 'srt', label: 'SubRip subtitles (.srt)' },
  { format: 'vtt', label: 'WebVTT subtitles (.vtt)' },
  { format: 'txt', label: 'Plain text (.txt)' },
]

async function save(item: VideoItem, language: string | null, format: Format, destination: 'library' | 'choose') {
  try {
    const path = await exportCaptions(item, language, format, destination)
    if (!path) return
    toasts.push(`Saved ${baseName(path)}`, {
      tone: 'ok',
      action: { label: 'Show in folder', run: () => library.revealPath(path) },
    })
  } catch (error) {
    toasts.error(error)
  }
}

async function copy(item: VideoItem, language: string | null) {
  try {
    const transcript = await readTranscript(item.id, language)
    if (!transcript) throw new Error('The transcript could not be read.')
    await navigator.clipboard.writeText(captionText(transcript, 'txt'))
    toasts.push('Copied the transcript.', { tone: 'ok' })
  } catch (error) {
    toasts.error(error)
  }
}

/** `language` null = the original transcript. */
export function captionExportEntries(item: VideoItem, language: string | null): MenuEntry[] {
  return [
    { label: 'Copy text', icon: 'text', onSelect: () => void copy(item, language) },
    { kind: 'separator' },
    { kind: 'heading', label: 'Save to library folder' },
    ...FORMATS.map(({ format, label }) => ({
      label,
      onSelect: () => void save(item, language, format, 'library'),
    })),
    { kind: 'separator' },
    { kind: 'heading', label: 'Save as…' },
    ...FORMATS.map(({ format, label }) => ({
      label,
      onSelect: () => void save(item, language, format, 'choose'),
    })),
  ]
}
