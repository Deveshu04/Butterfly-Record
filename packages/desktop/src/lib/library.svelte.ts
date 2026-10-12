import {
  createManifest,
  ulid,
  ulidTime,
  type AudioCodecName,
  type ContainerName,
  type VideoCodecName,
} from '@butterfly-record/core'
import { getVersion } from '@tauri-apps/api/app'
import { convertFileSrc } from '@tauri-apps/api/core'

import {
  errorMessage,
  libraryInfo,
  libraryList,
  librarySetRoot,
  libraryTrash,
  libraryUseHomeRoot,
  mediaRename,
  openPath,
  pickFolder,
  pickImportFiles,
  revealPath as revealPathIpc,
  sessionCreate,
  sidecarRemove,
  type DesktopManifest,
  type DesktopOutput,
  type LibraryInfo,
  type LibraryItem,
} from './ipc.ts'
import { runJob } from './job-state.svelte.ts'
import { ImportError, leftoverParts, type ImportFailure } from './library-rules.ts'
import {
  PART_NAME,
  POSTER_NAME,
  TRANSCRIPT_NAME,
  readManifest,
  updateManifest,
  writeManifest,
} from './manifests.ts'
import {
  anyFinalizing,
  generatePoster,
  isFinalizing,
  probeFile,
  recoverSession,
  type MediaInfo,
} from './media.ts'
import { storageAccess } from './storage-access.svelte.ts'
import { cleanTitle, fileName, fileStem, mediaBaseName } from './titles.ts'

export type VideoStatus = 'ready' | 'recording' | 'needs-recovery' | 'missing'

export interface VideoItem {
  id: string
  title: string
  description: string
  createdAt: string
  duration: number | null
  bytes: number | null
  width: number | null
  height: number | null
  external: boolean
  imported: boolean
  mediaPath: string | null
  mediaUrl: string | null
  /** Carries a cache-busting query so a regenerated poster shows at once. */
  posterUrl: string | null
  status: VideoStatus
  /** Languages of transcript.<lang>.json files (translations). */
  transcriptLanguages: string[]
  /** transcript.json exists. */
  hasTranscript: boolean
  outputs: DesktopOutput[]
  manifest: DesktopManifest | null
}

let items = $state<VideoItem[]>([])
let loading = $state(false)
let info = $state<LibraryInfo | null>(null)

const raw = new Map<string, LibraryItem>()
const posterVersions = new Map<string, number>()
let activeRecording: string | null = null
let importing = 0

/** The recorder marks its session so the library shows it as recording, not broken. */
export function setActiveRecording(id: string | null): void {
  activeRecording = id
}

/** Call after rewriting poster.jpg so `<img>` does not show the cached one. */
export function posterChanged(id: string): void {
  posterVersions.set(id, (posterVersions.get(id) ?? 0) + 1)
}

const TRANSLATION = /^transcript\.(.+)\.json$/

function statusOf(item: LibraryItem): VideoStatus {
  if (item.mediaPath) return 'ready'
  if (item.id === activeRecording) return 'recording'
  if (!item.manifest?.media && (item.partBytes ?? 0) > 0) return 'needs-recovery'
  return 'missing'
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function toVideoItem(item: LibraryItem): VideoItem {
  const manifest = item.manifest
  const posterVersion = posterVersions.get(item.id) ?? 0
  const posterUrl = item.sidecar.includes(POSTER_NAME)
    ? `${convertFileSrc(`${item.sessionDir}\\${POSTER_NAME}`)}?v=${posterVersion}`
    : null

  return {
    id: item.id,
    title: manifest?.title.trim() || 'Untitled',
    description: manifest?.description ?? '',
    createdAt: manifest?.createdAt ?? new Date(ulidTime(item.id)).toISOString(),
    duration: positive(manifest?.duration),
    bytes: positive(item.mediaBytes) ?? positive(manifest?.bytes),
    width: positive(manifest?.video.width),
    height: positive(manifest?.video.height),
    external: manifest?.media?.external ?? false,
    imported: manifest?.producer.app === 'import',
    mediaPath: item.mediaPath,
    mediaUrl: item.mediaPath ? convertFileSrc(item.mediaPath) : null,
    posterUrl,
    status: statusOf(item),
    transcriptLanguages: item.sidecar
      .map((name) => TRANSLATION.exec(name)?.[1])
      .filter((language): language is string => Boolean(language))
      .sort(),
    hasTranscript: item.sidecar.includes(TRANSCRIPT_NAME),
    outputs: manifest?.outputs ?? [],
    manifest,
  }
}

const isBusy = (id: string) => id === activeRecording || isFinalizing(id)

let refreshing: Promise<void> | null = null
let refreshAgain = false

function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true
    return refreshing
  }
  refreshing = (async () => {
    loading = true
    try {
      do {
        refreshAgain = false
        const [list, current] = await Promise.all([libraryList(), libraryInfo()])
        raw.clear()
        for (const item of list) raw.set(item.id, item)
        items = list.map(toVideoItem)
        info = current
        for (const id of leftoverParts(list, isBusy)) {
          void sidecarRemove(id, PART_NAME).catch(() => {})
        }
      } while (refreshAgain)
    } finally {
      loading = false
      refreshing = null
    }
  })()
  return refreshing
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined

/** Files also change outside the app (Explorer, the Recycle Bin), so look again on return. */
function refreshSoon(): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refresh().catch((error: unknown) =>
      console.warn('[butterfly-record] library refresh failed', error),
    )
  }, 250)
}

window.addEventListener('focus', refreshSoon)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSoon()
})

function get(id: string): VideoItem | undefined {
  return items.find((item) => item.id === id)
}

async function rename(id: string, title: string): Promise<void> {
  const clean = cleanTitle(title)
  if (!clean) throw new Error('A title cannot be empty.')
  const manifest = await readManifest(id)
  if (!manifest) throw new Error('This item has no readable manifest.')

  if (clean === manifest.title) return

  // Titles that map to the same file name keep the file as it is rather than gaining " (2)".
  const baseName = mediaBaseName(clean)
  const media = manifest.media
  const renamed =
    media && !media.external && fileStem(media.path) !== baseName
      ? await mediaRename(id, baseName)
      : null
  await updateManifest(id, (current) => {
    current.title = clean
    if (renamed !== null && current.media) current.media = { ...current.media, path: renamed }
  })
  await refresh()
}

async function setDescription(id: string, text: string): Promise<void> {
  await updateManifest(id, (current) => {
    current.description = text
  })
  await refresh()
}

async function remove(id: string): Promise<void> {
  if (id === activeRecording) throw new Error('Stop the recording before deleting it.')
  if (isFinalizing(id)) throw new Error('Wait for the recovery to finish before deleting it.')
  try {
    await libraryTrash(id)
  } finally {
    // A partial failure (video trashed, folder kept) still changes what is on disk.
    await refresh()
  }
}

/** Recording fields describe what MediaRecorder produces; imports carry whatever the file holds. */
function importedManifest(
  id: string,
  path: string,
  probe: MediaInfo,
  version: string,
): DesktopManifest {
  const base = createManifest({
    id,
    producer: { app: 'import', version, os: navigator.userAgent },
    video: {
      codec: (probe.video?.codec === 'avc' ? 'h264' : (probe.video?.codec ?? '')) as VideoCodecName,
      container: probe.container as ContainerName,
      width: probe.video?.width ?? 0,
      height: probe.video?.height ?? 0,
      frameRate: probe.video?.frameRate ?? 0,
      bitrate: probe.duration > 0 ? Math.round((probe.size * 8) / probe.duration) : 0,
      surface: 'display',
      sourceLabel: fileName(path),
    },
    audio: {
      codec: (probe.audio?.codec ?? '') as AudioCodecName,
      sampleRate: (probe.audio?.sampleRate ?? 48_000) as 48000,
      channels: (probe.audio?.channels === 1 ? 1 : 2) as 1 | 2,
      tracks: [],
    },
    camera: null,
    title: fileStem(path),
  })
  return {
    ...base,
    status: 'ready',
    duration: probe.duration > 0 ? probe.duration : null,
    bytes: probe.size,
    media: { path, external: true },
    outputs: [],
  }
}

/** Ids of the imported items; rejects with an ImportError when any file could not be imported. */
async function importFiles(): Promise<string[]> {
  const paths = await pickImportFiles()
  if (paths.length === 0) return []
  importing++
  try {
    return await importPaths(paths)
  } finally {
    importing--
  }
}

async function importPaths(paths: string[]): Promise<string[]> {
  const version = await getVersion().catch(() => 'unknown')
  const imported: string[] = []
  const failed: ImportFailure[] = []

  for (const path of paths) {
    const id = ulid()
    try {
      await runJob('import', id, null, async (job) => {
        job.progress('reading', `Reading ${fileName(path)}`)
        const probe = await probeFile({ kind: 'path', path })
        await sessionCreate(id)
        await writeManifest(importedManifest(id, path, probe, version))
        if (probe.video) {
          job.progress('poster', 'Creating a thumbnail')
          await generatePoster(id)
        }
        imported.push(id)
      })
    } catch (error) {
      // Every other file would be refused the same way; the dialog explains it once.
      if (storageAccess.report(error, 'import')) break
      // The remaining files still import; the failures are reported together at the end.
      failed.push({ name: fileName(path), message: errorMessage(error) })
    }
  }

  await refresh()
  if (failed.length > 0) throw new ImportError(imported, failed)
  return imported
}

async function recover(id: string): Promise<void> {
  try {
    await runJob('recover', id, null, async (job) => {
      job.progress('remuxing', 'Rebuilding the video file', 0)
      await recoverSession(id, {
        onProgress: (fraction) => job.progress('remuxing', 'Rebuilding the video file', fraction),
      })
      job.progress('poster', 'Creating a thumbnail')
      if (await generatePoster(id)) posterChanged(id)
    })
  } finally {
    await refresh()
  }
}

async function reveal(id: string): Promise<void> {
  const item = raw.get(id)
  if (!item) throw new Error('This item is no longer in the library.')
  await revealPathIpc(item.mediaPath ?? item.sessionDir)
}

async function openFolder(): Promise<void> {
  const current = info ?? (await libraryInfo())
  await openPath(current.root)
}

function ensureRootMovable(): void {
  // Sessions in flight resolve their files against the root, so it must not move under them.
  if (activeRecording || importing > 0 || anyFinalizing()) {
    throw new Error('Finish the recording or the running task before changing the library folder.')
  }
}

/** Rust refuses a folder it cannot write to, with the reason. */
async function changeRoot(): Promise<void> {
  ensureRootMovable()
  const picked = await pickFolder()
  if (!picked) return
  info = await librarySetRoot(picked)
  await Promise.all([refresh(), storageAccess.check()])
}

/** Moves the library to %USERPROFILE%\Butterfly Record, outside the protected folders. */
async function useHomeRoot(): Promise<void> {
  ensureRootMovable()
  info = await libraryUseHomeRoot()
  await Promise.all([refresh(), storageAccess.check()])
}

export const library = {
  get items(): VideoItem[] {
    return items
  },
  get loading(): boolean {
    return loading
  },
  get info(): LibraryInfo | null {
    return info
  },
  refresh,
  get,
  rename,
  setDescription,
  remove,
  importFiles,
  recover,
  reveal,
  revealPath: (path: string): Promise<void> => revealPathIpc(path),
  openFolder,
  changeRoot,
  useHomeRoot,
}
