import { safeFilename } from '@butterfly-record/core/filenames'

const MAX_TITLE = 200

const pad = (value: number) => String(value).padStart(2, '0')

/** "Recording 2026-10-07 14.05": sortable, and a valid Windows file name as-is. */
export function defaultRecordingTitle(at: Date): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `Recording ${date} ${pad(at.getHours())}.${pad(at.getMinutes())}`
}

const DEFAULT_TITLE = /^Recording \d{4}-\d{2}-\d{2} \d{2}\.\d{2}(?: \(\d+\))?$/

/**
 * True while the title is still the one the app chose: the recording default, or the
 * imported file's own name.
 */
export function isDefaultTitle(title: string, importedFileName?: string | null): boolean {
  const trimmed = title.trim()
  if (trimmed.length === 0 || DEFAULT_TITLE.test(trimmed)) return true
  return importedFileName ? trimmed === fileStem(importedFileName) : false
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export function fileStem(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function fileExtension(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function cleanTitle(raw: string): string {
  return (
    raw
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE)
      // Slicing can split a surrogate pair, and a lone surrogate is rejected by JSON IPC.
      .replace(/[\uD800-\uDBFF]$/, '')
      .trimEnd()
  )
}

/** "<title> - <Language>", the stem of a dubbed copy. */
export function dubBaseName(title: string, languageName: string): string {
  return `${safeFilename(title)} - ${languageName}`
}

/** "<title>.<lang>", the stem of a caption export. */
export function captionBaseName(title: string, language: string): string {
  return `${safeFilename(title)}.${language}`
}

export function mediaBaseName(title: string): string {
  return safeFilename(title)
}
