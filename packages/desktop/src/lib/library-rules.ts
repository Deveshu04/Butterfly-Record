// Library decisions that need no IPC, kept apart so Node tests can import them.

import { InsufficientSpaceError } from '@butterfly-record/core/library'

import type { LibraryItem } from './ipc.ts'

/** The remux writes a full second copy next to the capture before the capture is deleted. */
const SPACE_HEADROOM = 1.1

/** Throws before a finalize that would fill the disk. 0 free bytes means Rust could not tell. */
export function checkFinalizeSpace(partBytes: number, freeBytes: number): void {
  const required = Math.ceil(partBytes * SPACE_HEADROOM)
  if (freeBytes > 0 && freeBytes < required) throw new InsufficientSpaceError(required, freeBytes)
}

/** Items whose finished file is in place but whose raw capture was never deleted. */
export function leftoverParts(items: LibraryItem[], busy: (id: string) => boolean): string[] {
  return items
    .filter(
      (item) =>
        item.manifest?.media &&
        item.mediaPath !== null &&
        item.partBytes !== null &&
        !busy(item.id),
    )
    .map((item) => item.id)
}

export interface ImportFailure {
  name: string
  message: string
}

const LISTED_FAILURES = 3

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

function describeImportFailures(importedCount: number, failed: ImportFailure[]): string {
  const [first] = failed
  let text: string
  if (failed.length === 1 && first) {
    text = sentence(`Could not import ${first.name}: ${first.message}`)
  } else {
    const names = failed.slice(0, LISTED_FAILURES).map((failure) => failure.name)
    const more = failed.length - names.length
    const list =
      more > 0
        ? `${names.join(', ')} and ${more} more`
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    const reasons = new Set(failed.map((failure) => failure.message))
    text = `Could not import ${failed.length} files: ${list}.`
    if (reasons.size === 1 && first) text += ` ${sentence(first.message)}`
  }
  if (importedCount === 1) text += ' The other file was imported.'
  else if (importedCount > 1) text += ` The other ${importedCount} files were imported.`
  return text
}

/** Some picked files could not be imported; `imported` holds the ids of those that were. */
export class ImportError extends Error {
  override readonly name = 'ImportError'
  readonly imported: string[]
  readonly failed: ImportFailure[]

  constructor(imported: string[], failed: ImportFailure[]) {
    super(describeImportFailures(imported.length, failed))
    this.imported = imported
    this.failed = failed
  }
}
