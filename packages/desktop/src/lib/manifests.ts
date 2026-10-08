import { normalizeManifest, SerialQueue, type RecordingManifest } from '@butterfly-record/core'

import {
  sidecarReadText,
  sidecarWriteText,
  type DesktopManifest,
  type DesktopOutput,
} from './ipc.ts'

export const MANIFEST_NAME = 'manifest.json'
export const PART_NAME = 'source.part'
export const POSTER_NAME = 'poster.jpg'
export const TRANSCRIPT_NAME = 'transcript.json'

export function transcriptName(language?: string | null): string {
  return language ? `transcript.${language}.json` : TRANSCRIPT_NAME
}

/** Fills fields older or hand-edited manifests may lack. */
export function normalizeDesktopManifest(raw: DesktopManifest): DesktopManifest {
  const loose = raw as Partial<DesktopManifest>
  return {
    ...normalizeManifest(raw as RecordingManifest),
    media: loose.media ?? null,
    outputs: Array.isArray(loose.outputs) ? loose.outputs : [],
  }
}

export async function readManifest(id: string): Promise<DesktopManifest | null> {
  const text = await sidecarReadText(id, MANIFEST_NAME)
  if (text === null) return null
  try {
    return normalizeDesktopManifest(JSON.parse(text) as DesktopManifest)
  } catch {
    return null
  }
}

export function writeManifest(manifest: DesktopManifest): Promise<void> {
  return sidecarWriteText(manifest.id, MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`)
}

const queues = new Map<string, SerialQueue>()

/**
 * Read-modify-write, serialized per session so concurrent jobs (a dub finishing while the
 * user renames) never overwrite each other's changes.
 */
export function updateManifest(
  id: string,
  mutate: (manifest: DesktopManifest) => DesktopManifest | void,
): Promise<DesktopManifest> {
  let queue = queues.get(id)
  if (!queue) {
    queue = new SerialQueue()
    queues.set(id, queue)
  }
  return queue.run(async () => {
    const current = await readManifest(id)
    if (!current) throw new Error('This item has no readable manifest.')
    const next = mutate(current) ?? current
    await writeManifest(next)
    return next
  })
}

export function addOutput(id: string, output: DesktopOutput): Promise<DesktopManifest> {
  return updateManifest(id, (manifest) => {
    manifest.outputs = [
      ...manifest.outputs.filter((existing) => existing.path !== output.path),
      output,
    ]
  })
}
