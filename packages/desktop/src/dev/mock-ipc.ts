// Mock backend for `vite --mode mock`: answers every Rust command in the browser so the UI can
// be developed and screenshotted without Tauri. All state lives inside installMock so that a
// production build, where nothing calls it, keeps none of this file.

import { createManifest, ulid } from '@butterfly-record/core'
import { emit, listen } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

import { FILLER_LINES, PLANNING_LINES, ROOT, VIDEOS, type MockVideo } from './mock-data.ts'
import { clipWebm, posterJpeg, silentWav } from './mock-media.ts'

type Bytes = Uint8Array
type Args = Record<string, unknown>

interface Session {
  files: Map<string, Bytes>
}

interface IpcError {
  code: string
  message: string
}

export function installMock() {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  let root = ROOT
  const sessions = new Map<string, Session>()
  /** Absolute path → bytes, for media in the library folder and imported files elsewhere. */
  const files = new Map<string, Bytes>()
  /** Realistic sizes for fixtures whose stand-in clips are tiny. */
  const shownSizes = new Map<string, number>()
  const urls = new WeakMap<Bytes, string>()
  let keyPresent = true
  let pendingJobs: unknown[] = []
  const cancelled = new Set<string>()
  /** The camera overlay: a real window in the app, a couple of fields here. */
  const CAMERA_HOME = { x: 1480, y: 760 }
  /** There are no monitors here, so the overlay is placed against a nominal 1080p desktop. */
  const CAMERA_WORK_AREA = { width: 1920, height: 1080 }
  let cameraOpen = false
  let cameraPlacement = CAMERA_HOME

  function fail(code: string, message: string): never {
    throw { code, message } satisfies IpcError
  }

  const sessionDir = (id: string) => `${root}\\.butterfly\\${id}`

  function session(id: string): Session {
    const found = sessions.get(id)
    if (!found) fail('not_found', 'No such library item.')
    return found
  }

  function readJson(id: string, name: string): Record<string, unknown> | null {
    const bytes = sessions.get(id)?.files.get(name)
    return bytes ? (JSON.parse(decoder.decode(bytes)) as Record<string, unknown>) : null
  }

  function writeJson(id: string, name: string, value: unknown) {
    session(id).files.set(name, encoder.encode(`${JSON.stringify(value, null, 2)}\n`))
  }

  function mediaPathOf(id: string): string | null {
    const media = readJson(id, 'manifest.json')?.media as { path: string; external: boolean } | null | undefined
    if (!media) return null
    return media.external ? media.path : `${root}\\${media.path}`
  }

  /** Resolves any absolute path the UI may hand to convertFileSrc. */
  function lookup(path: string): Bytes | undefined {
    const direct = files.get(path)
    if (direct) return direct
    const prefix = `${root}\\.butterfly\\`
    if (!path.startsWith(prefix)) return undefined
    const [id, name] = path.slice(prefix.length).split('\\')
    return id && name ? sessions.get(id)?.files.get(name) : undefined
  }

  function mime(path: string, bytes: Bytes): string {
    if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
    // Every stand-in clip is WebM whatever its name says.
    if (bytes[0] === 0x1a && bytes[1] === 0x45) return 'video/webm'
    return 'application/octet-stream'
  }

  function assetUrl(path: string): string {
    const bytes = lookup(path)
    if (!bytes) return `http://asset.localhost/${encodeURIComponent(path)}`
    let url = urls.get(bytes)
    if (!url) {
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime(path, bytes) }))
      urls.set(bytes, url)
    }
    // The trailing '#' turns any cache-busting query the app appends into a fragment, which blob URLs ignore.
    return `${url}#`
  }

  function uniqueName(base: string, ext: string): string {
    let name = `${base}.${ext}`
    for (let n = 2; files.has(`${root}\\${name}`); n++) name = `${base} (${n}).${ext}`
    return name
  }

  function concat(a: Bytes, b: Bytes): Bytes {
    const out = new Uint8Array(a.byteLength + b.byteLength)
    out.set(a)
    out.set(b, a.byteLength)
    return out
  }

  // Fixtures

  function segmentsFor(duration: number, diarize: boolean) {
    const count = Math.max(1, Math.floor(duration / 6))
    return Array.from({ length: count }, (_, index) => ({
      start: index * 6,
      end: index * 6 + 5.6,
      text: FILLER_LINES[index % FILLER_LINES.length]!,
      speaker: diarize ? String(Math.floor(index / 3) % 2) : null,
    }))
  }

  function planningTranscript(hindi: boolean, createdAt: string) {
    const step = 252 / PLANNING_LINES.length
    return {
      schema: 1,
      language: hindi ? 'hi-IN' : 'en-IN',
      model: hindi ? 'sarvam-translate:v1' : 'saaras:v4',
      createdAt,
      duration: 252,
      segments: PLANNING_LINES.map(([speaker, english, translated], index) => ({
        start: Math.round(index * step * 10) / 10,
        end: Math.round((index * step + step - 0.4) * 10) / 10,
        text: hindi ? translated : english,
        speaker: `Speaker ${speaker + 1}`,
      })),
    }
  }

  async function addFixture(video: MockVideo, now: number) {
    const createdAt = now - video.ageMinutes * 60_000
    const id = ulid(createdAt)
    const iso = new Date(createdAt).toISOString()
    const sidecars = new Map<string, Bytes>()
    sessions.set(id, { files: sidecars })

    const tracks = [
      ...(video.mic ? [{ kind: 'mic' as const, label: video.mic, gain: 1 }] : []),
      ...(video.systemAudio ? [{ kind: 'system' as const, label: video.sourceLabel, gain: 1 }] : []),
    ]
    const bitrate = Math.round(video.width * video.height * video.frameRate * 0.07)
    const base = createManifest({
      id,
      producer: { app: video.imported ? 'import' : 'desktop', version: '0.1.0', os: navigator.userAgent },
      video: {
        codec: video.imported ? 'h264' : 'vp9',
        container: video.imported ? 'mp4' : 'webm',
        width: video.width,
        height: video.height,
        frameRate: video.frameRate,
        bitrate,
        surface: video.surface,
        sourceLabel: video.sourceLabel,
      },
      audio: { codec: video.imported ? 'aac' : 'opus', sampleRate: 48000, channels: 2, tracks },
      camera: null,
      title: video.title,
    })
    const shownBytes = Math.round(((bitrate + 128_000) / 8) * Math.max(video.duration, 140) * 0.55)
    const clipSeconds = video.needsRecovery ? 140 : video.duration
    const [clip, poster] = await Promise.all([clipWebm(video.scene, clipSeconds), posterJpeg(video.scene)])

    let media: { path: string; external: boolean } | null = null
    if (video.needsRecovery) {
      sidecars.set('source.part', clip)
    } else if (video.imported) {
      files.set(video.imported.path, clip)
      shownSizes.set(video.imported.path, shownBytes)
      media = { path: video.imported.path, external: true }
    } else {
      const name = uniqueName(video.title.replace(/[\\/:*?"<>|]/g, '-'), 'webm')
      files.set(`${root}\\${name}`, clip)
      shownSizes.set(`${root}\\${name}`, shownBytes)
      media = { path: name, external: false }
    }
    if (!video.needsRecovery) sidecars.set('poster.jpg', poster)

    const outputs: unknown[] = []
    if (video.transcript === 'planning') {
      writeJson(id, 'transcript.json', planningTranscript(false, iso))
      writeJson(id, 'transcript.hi-IN.json', planningTranscript(true, iso))
      const dubName = uniqueName(`${video.title} - Tamil`, 'webm')
      files.set(`${root}\\${dubName}`, clip)
      shownSizes.set(`${root}\\${dubName}`, shownBytes)
      outputs.push({ kind: 'dub', language: 'ta-IN', path: dubName, method: 'sarvam-dubbing', createdAt: iso })
    }

    writeJson(id, 'manifest.json', {
      ...base,
      createdAt: iso,
      status: video.needsRecovery ? 'recording' : 'ready',
      duration: video.needsRecovery ? null : video.duration,
      bytes: video.needsRecovery ? 0 : shownBytes,
      description: video.description,
      media,
      outputs,
    })

    if (video.pendingTranscription) {
      pendingJobs.push({
        id,
        kind: 'stt',
        jobId: '2f6c1d9e-batch',
        createdAt: new Date(now - 4 * 60_000).toISOString(),
        request: {
          task: `transcribe-${ulid()}`,
          id,
          files: ['tmp-stt-0.webm'],
          offsets: [0],
          duration: video.duration,
          language: 'unknown',
          model: 'saaras:v4',
          mode: 'transcribe',
          diarize: true,
          numSpeakers: null,
        },
      })
    }
  }

  let fixtures: Promise<void> | null = null
  /** `?empty` starts with an empty library, for the first-run screens. */
  const fixtureVideos = new URLSearchParams(location.search).has('empty') ? [] : VIDEOS
  const ready = () =>
    (fixtures ??= Promise.all(fixtureVideos.map((video) => addFixture(video, Date.now()))).then(() => {}))

  // Simulated remote work

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  async function remote(
    task: string,
    totalMs: number,
    from: number,
    stage: (fraction: number) => [string, string],
  ): Promise<void> {
    const started = Date.now()
    for (;;) {
      if (cancelled.delete(task)) fail('cancelled', 'Cancelled.')
      const fraction = Math.min(1, from + ((Date.now() - started) / totalMs) * (1 - from))
      const [name, message] = stage(fraction)
      await emit('sarvam-progress', { task, stage: name, fraction, message })
      if (fraction >= 1) return
      await sleep(400)
    }
  }

  const sttStages = (fraction: number): [string, string] =>
    fraction < 0.12
      ? ['uploading', 'Uploading audio to Sarvam']
      : fraction < 0.92
        ? ['processing', 'Transcribing on Sarvam']
        : ['downloading', 'Downloading the transcript']

  // Commands

  type ReadTarget = { kind: 'part' | 'media'; id: string } | { kind: 'sidecar'; id: string; name: string } | { kind: 'path'; path: string }
  type WriteTarget =
    | { kind: 'media' | 'output'; id: string; baseName: string; ext: string }
    | { kind: 'sidecar'; id: string; name: string }
    | { kind: 'path'; path: string }

  const readers = new Map<number, Bytes>()
  const writers = new Map<number, { target: WriteTarget; data: Bytes; size: number }>()
  let nextHandle = 1

  function resolveRead(target: ReadTarget): [Bytes, string] {
    switch (target.kind) {
      case 'part': {
        const bytes = session(target.id).files.get('source.part')
        if (!bytes) fail('not_found', 'There is no capture to recover.')
        return [bytes, `${sessionDir(target.id)}\\source.part`]
      }
      case 'media': {
        const path = mediaPathOf(target.id)
        const bytes = path ? lookup(path) : undefined
        if (!path || !bytes) fail('not_found', 'The video file is missing.')
        return [bytes, path]
      }
      case 'sidecar': {
        const bytes = session(target.id).files.get(target.name)
        if (!bytes) fail('not_found', `${target.name} does not exist.`)
        return [bytes, `${sessionDir(target.id)}\\${target.name}`]
      }
      case 'path': {
        const bytes = files.get(target.path)
        if (!bytes) fail('not_found', 'The file could not be found.')
        return [bytes, target.path]
      }
    }
  }

  function commit(handle: number) {
    const writer = writers.get(handle)
    if (!writer) fail('not_found', 'Unknown file handle.')
    writers.delete(handle)
    const data = writer.data.slice(0, writer.size)
    const target = writer.target
    if (target.kind === 'sidecar') {
      session(target.id).files.set(target.name, data)
      return { path: `${sessionDir(target.id)}\\${target.name}`, relPath: `.butterfly\\${target.id}\\${target.name}`, bytes: data.byteLength }
    }
    if (target.kind === 'path') {
      files.set(target.path, data)
      const inside = target.path.startsWith(`${root}\\`)
      return { path: target.path, relPath: inside ? target.path.slice(root.length + 1) : null, bytes: data.byteLength }
    }
    const name = uniqueName(target.baseName, target.ext)
    files.set(`${root}\\${name}`, data)
    return { path: `${root}\\${name}`, relPath: name, bytes: data.byteLength }
  }

  function libraryItem(id: string) {
    const entry = session(id)
    const path = mediaPathOf(id)
    const bytes = path ? lookup(path) : undefined
    return {
      id,
      manifest: readJson(id, 'manifest.json'),
      mediaPath: bytes ? path : null,
      mediaBytes: bytes && path ? (shownSizes.get(path) ?? bytes.byteLength) : null,
      partBytes: entry.files.get('source.part')?.byteLength ?? null,
      sidecar: [...entry.files.keys()],
      sessionDir: sessionDir(id),
    }
  }

  let headers = new Headers()

  async function handle(cmd: string, raw: unknown): Promise<unknown> {
    const args = (raw ?? {}) as Args
    const body = raw instanceof Uint8Array ? raw : new Uint8Array()
    const request = (args.request ?? {}) as Args

    switch (cmd) {
      case 'library_info':
        return { root, defaultRoot: ROOT, freeBytes: 182.4 * 1024 ** 3 }
      case 'library_set_root':
        root = String(args.path)
        return { root, defaultRoot: ROOT, freeBytes: 911.7 * 1024 ** 3 }
      case 'library_list':
        await ready()
        return [...sessions.keys()].sort().reverse().map(libraryItem)
      case 'session_create':
        sessions.set(String(args.id), { files: new Map() })
        return sessionDir(String(args.id))
      case 'library_trash': {
        const id = String(args.id)
        const media = readJson(id, 'manifest.json')?.media as { path: string; external: boolean } | null
        if (media && !media.external) files.delete(`${root}\\${media.path}`)
        sessions.delete(id)
        return null
      }
      case 'session_discard':
        sessions.delete(String(args.id))
        return null
      case 'media_rename': {
        const id = String(args.id)
        const old = mediaPathOf(id)
        const bytes = old ? files.get(old) : undefined
        if (!old || !bytes) fail('not_found', 'The video file is missing.')
        files.delete(old)
        const name = uniqueName(String(args.baseName), old.split('.').pop() ?? 'webm')
        files.set(`${root}\\${name}`, bytes)
        const size = shownSizes.get(old)
        if (size) shownSizes.set(`${root}\\${name}`, size)
        return name
      }
      case 'reveal_path':
      case 'open_path':
        console.info(`[mock] ${cmd}`, args.path)
        return null
      case 'pick_folder':
        return 'D:\\Videos\\Butterfly Record'
      case 'pick_import_files': {
        const path = 'D:\\Footage\\Site visit walkthrough.mp4'
        if (!files.has(path)) files.set(path, await clipWebm({ backdrop: '#7d7466', tint: '#6b5a3a', kind: 'slides' }, 185))
        return [path]
      }
      case 'pick_save_path':
        return `C:\\Users\\Asha\\Documents\\${String(args.defaultName)}`

      case 'sidecar_read_text': {
        await ready()
        const bytes = sessions.get(String(args.id))?.files.get(String(args.name))
        return bytes ? decoder.decode(bytes) : null
      }
      case 'sidecar_write_text':
        session(String(args.id)).files.set(String(args.name), encoder.encode(String(args.text)))
        return null
      case 'sidecar_write_bytes':
        session(headers.get('x-id') ?? '').files.set(headers.get('x-name') ?? '', body.slice())
        return null
      case 'sidecar_remove':
        sessions.get(String(args.id))?.files.delete(String(args.name))
        return null

      case 'rec_open':
        session(String(args.id)).files.set('source.part', new Uint8Array())
        return null
      case 'rec_write': {
        const entry = session(headers.get('x-id') ?? '')
        const next = concat(entry.files.get('source.part') ?? new Uint8Array(), body)
        entry.files.set('source.part', next)
        return next.byteLength
      }
      case 'rec_flush':
        return null
      case 'rec_close':
        return session(String(args.id)).files.get('source.part')?.byteLength ?? 0
      case 'rec_abort':
        sessions.get(String(args.id))?.files.delete('source.part')
        return null

      case 'fs_open': {
        const [bytes, path] = resolveRead(args.target as ReadTarget)
        const handle = nextHandle++
        readers.set(handle, bytes)
        return { handle, size: bytes.byteLength, path }
      }
      case 'fs_read': {
        const bytes = readers.get(Number(args.handle))
        if (!bytes) fail('not_found', 'Unknown file handle.')
        const offset = Number(args.offset)
        return bytes.slice(offset, offset + Number(args.length)).buffer
      }
      case 'fs_close':
        readers.delete(Number(args.handle))
        return null
      case 'fs_create': {
        const handle = nextHandle++
        writers.set(handle, { target: args.target as WriteTarget, data: new Uint8Array(1024 * 1024), size: 0 })
        return { handle }
      }
      case 'fs_write': {
        const writer = writers.get(Number(headers.get('x-handle')))
        if (!writer) fail('not_found', 'Unknown file handle.')
        const position = Number(headers.get('x-position'))
        const end = position + body.byteLength
        if (end > writer.data.byteLength) {
          const grown = new Uint8Array(Math.max(end, writer.data.byteLength * 2))
          grown.set(writer.data)
          writer.data = grown
        }
        writer.data.set(body, position)
        writer.size = Math.max(writer.size, end)
        return null
      }
      case 'fs_commit':
        return commit(Number(args.handle))
      case 'fs_discard':
        writers.delete(Number(args.handle))
        return null
      case 'fs_uncommit':
        files.delete(String(args.path))
        return null

      case 'settings_get':
        try {
          return JSON.parse(localStorage.getItem('mock.settings') ?? '{}') as unknown
        } catch {
          return {}
        }
      case 'settings_set':
        localStorage.setItem('mock.settings', JSON.stringify(args.value))
        return null
      case 'recorder_set_state':
      case 'hud_open':
      case 'hud_close':
      case 'app_quit':
        return null

      case 'camera_open': {
        cameraOpen = true
        cameraPlacement = {
          x: Number(args.x ?? cameraPlacement.x),
          y: Number(args.y ?? cameraPlacement.y),
        }
        // No overlay window exists here, so the mock plays its part of the handshake.
        void emit('camera-state', { status: 'starting', message: null })
        setTimeout(() => void emit('camera-state', { status: 'live', message: null }), 400)
        return cameraPlacement
      }
      case 'camera_close':
        cameraOpen = false
        return null
      case 'camera_set_visible':
      case 'camera_set_size':
      case 'camera_set_protected':
        return null
      case 'camera_reset_position':
        if (!cameraOpen) fail('not_found', 'The camera overlay is not open.')
        cameraPlacement = CAMERA_HOME
        return cameraPlacement
      case 'camera_anchor':
        return cameraOpen
          ? {
              x: cameraPlacement.x / CAMERA_WORK_AREA.width,
              y: cameraPlacement.y / CAMERA_WORK_AREA.height,
            }
          : null

      case 'sarvam_key_status':
        return { present: keyPresent }
      case 'sarvam_key_set':
        keyPresent = true
        return null
      case 'sarvam_key_clear':
        keyPresent = false
        return null
      case 'sarvam_key_test':
        await sleep(600)
        if (!keyPresent) fail('no_key', 'No key is saved.')
        return { ok: true, message: 'Connected. Sarvam accepted the key.' }
      case 'sarvam_cancel':
        cancelled.add(String(args.task))
        return null
      case 'sarvam_pending_jobs': {
        await ready()
        const jobs = pendingJobs
        pendingJobs = []
        return jobs
      }
      case 'sarvam_transcribe': {
        const resumed = Boolean(request.resumeJobId)
        const duration = Number(request.duration)
        await remote(String(request.task), resumed ? 15 * 60_000 : 8000, resumed ? 0.41 : 0, sttStages)
        return {
          language: request.mode === 'translate' ? 'en-IN' : request.language === 'unknown' ? 'en-IN' : request.language,
          segments: segmentsFor(duration, Boolean(request.diarize)),
          requestIds: ['mock-request'],
        }
      }
      case 'sarvam_translate': {
        await remote(String(request.task), 2500, 0, () => ['translating', 'Translating on Sarvam'])
        const texts = request.texts as string[]
        if (request.target !== 'hi-IN') return texts
        return texts.map((text) => PLANNING_LINES.find(([, english]) => english === text)?.[2] ?? text)
      }
      case 'sarvam_tts':
        await sleep(300)
        return silentWav()
      case 'sarvam_dub': {
        const id = String(request.id)
        const targets = request.targetLanguages as string[]
        await remote(String(request.task), 9000, 0, (fraction) =>
          fraction < 0.2 ? ['uploading', 'Uploading to Sarvam'] : ['dubbing', 'Dubbing on Sarvam'],
        )
        const path = mediaPathOf(id)
        const clip = (path && lookup(path)) || new Uint8Array()
        return {
          jobId: 'mock-dub-job',
          outputs: targets.map((language) => {
            const sidecarName = `dub.${language}.webm`
            session(id).files.set(sidecarName, clip)
            return { language, type: 'video', sidecarName, bytes: clip.byteLength }
          }),
          failed: [],
        }
      }
      case 'sarvam_summarize':
        await sleep(1500)
        return {
          title: 'Expense tool walkthrough',
          summary:
            'A walkthrough of submitting an expense: adding receipts, choosing a cost centre, and what approvers see before payment.',
        }

      case 'plugin:app|version':
        return '0.1.0'
      case 'plugin:window|is_visible':
        return true
      case 'plugin:window|is_minimized':
        return false
      // Only the page itself exists in a browser, so the camera window is never found and
      // its moves are simply not remembered.
      case 'plugin:window|get_all_windows':
        return [label]
      case 'plugin:window|scale_factor':
        return window.devicePixelRatio
      default:
        if (cmd.startsWith('plugin:')) return null
        fail('invalid_argument', `The mock does not implement ${cmd}.`)
    }
  }

  function startHudFeed() {
    const params = new URLSearchParams(location.search)
    const phase = params.get('phase') ?? 'recording'
    // `?camera=visible|hidden` brings up the camera toggle; without it the recording has none.
    const requested = params.get('camera')
    let camera: 'visible' | 'hidden' | null =
      requested === 'visible' || requested === 'hidden' ? requested : null
    if (camera) {
      // Nothing is recording, so the bar answers its own camera toggle.
      void listen<{ action: string }>('hud-action', ({ payload }) => {
        if (payload.action === 'camera-show') camera = 'visible'
        else if (payload.action === 'camera-hide') camera = 'hidden'
      })
    }
    let elapsed = 754
    setInterval(() => {
      if (phase === 'recording') elapsed += 0.25
      void emit('recorder-status', {
        phase,
        elapsed,
        micMuted: params.has('muted'),
        hasMic: true,
        countdown: phase === 'countdown' ? 3 : null,
        camera,
      })
    }, 250)
  }

  const label = location.pathname.includes('hud')
    ? 'hud'
    : location.pathname.includes('camera')
      ? 'camera'
      : 'main'
  mockWindows(label)
  mockIPC((cmd, payload) => handle(cmd, payload), { shouldMockEvents: true })

  const internals = (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__
  const invoke = internals.invoke as (cmd: string, args: unknown, options?: { headers?: HeadersInit }) => Promise<unknown>
  // mockIPC drops invoke options, and raw-body commands carry their arguments in headers.
  internals.invoke = (cmd: string, args: unknown, options?: { headers?: HeadersInit }) => {
    headers = new Headers(options?.headers)
    // The mocked event plugin swallows emitTo, so windows talk to each other as plain
    // emits: each mock page is on its own anyway, but a page still hears itself.
    if (cmd === 'plugin:event|emit_to') {
      const { event, payload } = (args ?? {}) as { event?: string; payload?: unknown }
      return emit(String(event), payload)
    }
    return invoke(cmd, args, options)
  }
  internals.convertFileSrc = (path: string) => assetUrl(path)

  if (label === 'hud') startHudFeed()
  else void ready()
}
