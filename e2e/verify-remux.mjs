// Records ~15 s of screen, then checks from OPFS that the finalized source.webm has a finite duration and seeks.
import fs from 'node:fs'
import path from 'node:path'
import {
  launch,
  freshDir,
  extensionId,
  attachConsoleCollector,
  toBackground,
  waitForPhase,
  WORKDIR,
} from './common.mjs'

const RECORD_SECONDS = 15
const PORT = 9333
const report = {
  goal: 'remux-finalize',
  startedAt: new Date().toISOString(),
  steps: [],
  verdict: 'UNKNOWN',
}
const step = (name, data) => {
  report.steps.push({ name, ...data })
  console.log(`[step] ${name}: ${JSON.stringify(data)}`)
}

const profileDir = freshDir('profile-remux')
const logFile = path.join(WORKDIR, 'logs-remux.txt')
fs.writeFileSync(logFile, '')

let context
let collector
try {
  context = await launch({ profileDir, port: PORT })
  collector = await attachConsoleCollector(PORT, logFile)

  const id = await extensionId(context)
  step('extension-id', { id })

  context.on('close', () => step('CONTEXT-CLOSED', { at: new Date().toISOString() }))
  const page = await context.newPage()
  page.on('close', () => step('LIBRARY-PAGE-CLOSED', { at: new Date().toISOString() }))
  page.on('crash', () => step('LIBRARY-PAGE-CRASHED', { at: new Date().toISOString() }))
  await page.goto(`chrome-extension://${id}/library.html`, { waitUntil: 'domcontentloaded' })
  step('library-open', { url: page.url() })

  const startReply = await toBackground(page, {
    target: 'background',
    type: 'start-recording',
    scope: 'screen',
    crop: null,
  })
  step('start-recording-reply', { reply: startReply })
  if (!startReply?.ok) throw new Error(`start-recording failed: ${JSON.stringify(startReply)}`)

  // The countdown (default 3 s) runs before the phase becomes 'recording'.
  const recording = await waitForPhase(page, (s) => s.phase === 'recording', 30000, 'phase=recording')
  const sessionId = recording.sessionId
  step('recording-started', { sessionId, phase: recording.phase })

  // Poll each second so a mid-recording failure is timestamped.
  for (let i = 0; i < RECORD_SECONDS; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await toBackground(page, { target: 'background', type: 'get-state' })
    if (!s?.ok || s.value.phase !== 'recording') {
      step('mid-recording-anomaly', { second: i + 1, state: s })
    }
  }

  const midState = await toBackground(page, { target: 'background', type: 'get-state' })
  step('pre-stop-state', { state: midState?.value ?? midState })

  const stopReply = await toBackground(page, { target: 'background', type: 'stop-recording' })
  step('stop-recording-reply', { reply: stopReply })

  const idle = await waitForPhase(page, (s) => s.phase === 'idle', 60000, 'phase=idle after stop')
  step('finalize-complete', { phase: idle.phase })

  // Let the manifest write and cleanup settle.
  await new Promise((r) => setTimeout(r, 1500))

  const opfs = await page.evaluate(async (sid) => {
    const root = await navigator.storage.getDirectory()
    const out = { sessionIds: [], manifest: null, files: {}, error: null }
    try {
      const sessions = await root.getDirectoryHandle('sessions')
      for await (const [name] of sessions.entries()) out.sessionIds.push(name)
      const dir = await sessions.getDirectoryHandle(sid)
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
          const f = await handle.getFile()
          out.files[name] = f.size
        } else {
          out.files[name] = 'dir'
        }
      }
      const mf = await (await (await dir.getFileHandle('manifest.json')).getFile()).text()
      out.manifest = JSON.parse(mf)
    } catch (e) {
      out.error = `${e.name}: ${e.message}`
    }
    return out
  }, sessionId)
  step('opfs', opfs)

  const manifest = opfs.manifest
  const hasWebm = typeof opfs.files['source.webm'] === 'number' && opfs.files['source.webm'] > 0
  const hasPart = 'source.part' in opfs.files

  const playback = await page.evaluate(async (sid) => {
    const root = await navigator.storage.getDirectory()
    const dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle(sid)
    const file = await (await dir.getFileHandle('source.webm')).getFile()
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    document.body.append(video)
    const result = { bytes: file.size }
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('loadedmetadata timeout (10s)')), 10000)
        video.addEventListener('loadedmetadata', () => {
          clearTimeout(t)
          resolve()
        })
        video.addEventListener('error', () => {
          clearTimeout(t)
          reject(new Error(`video element error: ${video.error?.code} ${video.error?.message ?? ''}`))
        })
        video.src = url
      })
      result.duration = video.duration
      result.durationFinite = Number.isFinite(video.duration)
      result.videoWidth = video.videoWidth
      result.videoHeight = video.videoHeight

      if (result.durationFinite && video.duration > 0) {
        const target = video.duration / 2
        const seekStart = performance.now()
        const seeked = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(false), 3000)
          video.addEventListener(
            'seeked',
            () => {
              clearTimeout(t)
              resolve(true)
            },
            { once: true },
          )
          video.currentTime = target
        })
        result.seek = {
          target,
          fired: seeked,
          ms: Math.round(performance.now() - seekStart),
          currentTime: video.currentTime,
          delta: Math.abs(video.currentTime - target),
        }
      }
    } catch (e) {
      result.error = e.message
    } finally {
      URL.revokeObjectURL(url)
      video.remove()
    }
    return result
  }, sessionId)
  step('playback', playback)

  await new Promise((r) => setTimeout(r, 500))
  const finalizing = collector.grep(/finalizing /)
  const finalized = collector.grep(/finalized /)
  step('console-evidence', {
    finalizing: finalizing.map((l) => `[${l.targetType}] ${l.targetUrl} :: ${l.text}`),
    finalized: finalized.map((l) => `[${l.targetType}] ${l.targetUrl} :: ${l.text}`),
  })

  const durationOk =
    playback.durationFinite && playback.duration >= RECORD_SECONDS - 5 && playback.duration <= RECORD_SECONDS + 5
  const seekOk = playback.seek?.fired && playback.seek.delta <= 0.5
  const manifestOk = manifest?.status === 'ready' && manifest?.duration > 0
  const filesOk = hasWebm && !hasPart
  const logsOk = finalizing.length > 0 && finalized.length > 0

  report.checks = {
    manifestReady: manifestOk,
    manifestDuration: manifest?.duration ?? null,
    manifestBytes: manifest?.bytes ?? null,
    manifestVideo: manifest?.video ?? null,
    sourceWebmBytes: opfs.files['source.webm'] ?? null,
    sourcePartGone: !hasPart,
    videoDuration: playback.duration ?? null,
    durationFinite: playback.durationFinite ?? false,
    durationInRange: durationOk,
    seek: playback.seek ?? null,
    seekOk,
    offscreenLogsSeen: logsOk,
  }
  report.verdict =
    manifestOk && filesOk && durationOk && seekOk ? 'VERIFIED' : 'FAILED'
  report.verdictNote = logsOk
    ? 'finalizing/finalized offscreen log lines captured'
    : 'offscreen log lines NOT captured; OPFS+seek evidence is primary'
} catch (e) {
  report.error = e.message
  report.verdict = 'FAILED'
  console.error(e)
} finally {
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(WORKDIR, 'report-remux.json'), JSON.stringify(report, null, 2))
  collector?.close()
  await context?.close().catch(() => {})
  console.log(`\nVERDICT: ${report.verdict}`)
  process.exit(report.verdict === 'VERIFIED' ? 0 : 1)
}
