// Smoke test for the built Windows app: launches the release exe against a scratch library and
// settings folder, records the screen for a few seconds through the real UI, checks the finished
// file on disk, imports a copy of it, and quits through the app's own exit path.
//
// Needs `pnpm desktop:build` first. Optional: SMOKE_SCREENSHOTS=<dir> saves screenshots of
// every view while the test runs; SMOKE_KEEP=1 keeps the scratch folders for inspection;
// SMOKE_CAPTURE=fake swaps the real screen for Chromium's generated test pattern and adds a
// generated microphone and camera (no real audio or camera device is ever opened), and turns
// the camera overlay on, with a background blur, so it is covered too.

import { chromium } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { WORKDIR } from './common.mjs'

const ROOT = path.resolve(WORKDIR, '..')
const EXE = path.join(ROOT, 'packages', 'desktop', 'src-tauri', 'target', 'release', 'butterfly-record-desktop.exe')
const PORT = 9333
const RECORD_SECONDS = 6
const REPORT = path.join(WORKDIR, 'report-desktop-smoke.json')
const LOGS = path.join(WORKDIR, 'logs-desktop-smoke.txt')
const FAILURE_SHOT = path.join(WORKDIR, 'failure-desktop-smoke.png')
const SHOTS = process.env.SMOKE_SCREENSHOTS ? path.resolve(process.env.SMOKE_SCREENSHOTS) : null

const FAKE_CAPTURE = process.env.SMOKE_CAPTURE === 'fake'

// WebView2 honours Chromium's media switches: grant capture without a prompt and take the
// whole screen without showing the picker.
const WEBVIEW_ARGS = [
  `--remote-debugging-port=${PORT}`,
  '--auto-select-desktop-capture-source="Entire screen"',
  '--use-fake-ui-for-media-stream',
  ...(FAKE_CAPTURE ? ['--use-fake-device-for-media-stream'] : []),
].join(' ')

// Written to the scratch settings folder; the real settings are never read or changed.
const TEST_SETTINGS = {
  theme: 'system',
  closeToTray: true,
  recording: {
    scope: 'screen',
    quality: '1080p',
    frameRate: 30,
    // Only the generated microphone is used; the real one stays closed.
    microphoneEnabled: FAKE_CAPTURE,
    microphoneId: null,
    countdown: true,
    hideWindow: true,
    // Only the generated camera is used; a real webcam stays closed.
    camera: {
      enabled: FAKE_CAPTURE,
      deviceId: null,
      shape: 'wide',
      size: 240,
      mirror: true,
      // Where the overlay is placed when it has no saved position; there is no corner control.
      corner: 'bottom-right',
      position: null,
    },
  },
}

const report = { ok: false, startedAt: new Date().toISOString(), checks: [], recording: null, imported: null, camera: null }

/** The overlay window's page, or null when it is not open. */
function cameraPage(context) {
  return context.pages().find((page) => page.url().includes('/camera.html')) ?? null
}

/** What the overlay is actually showing, read from the page itself. */
function cameraFeed(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video')
    const frame = document.querySelector('.frame')
    const box = frame?.getBoundingClientRect()
    return {
      videoWidth: video?.videoWidth ?? 0,
      readyState: video?.readyState ?? 0,
      unavailable: Boolean(document.querySelector('.placeholder')),
      radius: frame ? getComputedStyle(frame).borderRadius : null,
      mirrored: video ? getComputedStyle(video).transform.startsWith('matrix(-1') : false,
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }
  })
}

/** The overlay's effect canvas, sampled down to a few numbers that say whether it shows a picture. */
function cameraEffect(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.effect')
    if (!canvas || canvas.width === 0) return null
    const probe = document.createElement('canvas')
    probe.width = 16
    probe.height = 16
    const context = probe.getContext('2d')
    context.drawImage(canvas, 0, 0, 16, 16)
    const pixels = context.getImageData(0, 0, 16, 16).data
    let min = 255
    let max = 0
    let sum = 0
    for (let at = 0; at < pixels.length; at += 4) {
      const luma = (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3
      min = Math.min(min, luma)
      max = Math.max(max, luma)
      sum += luma
    }
    return {
      shown: canvas.classList.contains('shown'),
      width: canvas.width,
      height: canvas.height,
      contrast: Math.round(max - min),
      signature: Math.round(sum),
    }
  })
}

function check(name, passed, detail) {
  log(`[check] ${passed ? 'PASS' : 'FAIL'} ${name}`)
  report.checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  if (!passed) throw new Error(`check failed: ${name}`)
}

function log(line) {
  fs.appendFileSync(LOGS, `${new Date().toISOString()} ${line}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
    await sleep(250)
  }
}

// A second launch hands over to a running copy (single instance) and exits at once.
function runningInstance() {
  const tasks = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).toLowerCase()
  return ['butterfly-record-desktop.exe', 'butterfly record.exe'].find((name) => tasks.includes(`"${name}"`))
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// The e2e package sits outside the workspace; core's copy of Mediabunny reads the result.
const { ALL_FORMATS, FilePathSource, Input } = createRequire(
  path.join(ROOT, 'packages', 'core', 'package.json'),
)('mediabunny')

async function probe(file) {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    return {
      format: (await input.getFormat()).name,
      metadataDuration: await input.getDurationFromMetadata().catch(() => null),
      duration: await input.computeDuration(),
      video: video
        ? { codec: await video.getCodec(), width: await video.getDisplayWidth(), height: await video.getDisplayHeight() }
        : null,
      audio: audio
        ? { codec: await audio.getCodec(), channels: await audio.getNumberOfChannels(), sampleRate: await audio.getSampleRate() }
        : null,
    }
  } finally {
    input.dispose()
  }
}

function sessions(library) {
  const dir = path.join(library, '.butterfly')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

function readManifest(library, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(library, '.butterfly', id, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

async function shot(page, name) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await sleep(300)
}

async function go(page, hash) {
  await page.evaluate((target) => {
    location.hash = target
  }, hash)
  await settle(page)
}

async function screenshotViews(page, recordedId) {
  if (!SHOTS) return
  await go(page, '#/library')
  await shot(page, 'library')
  for (const tab of ['transcript', 'translate', 'dub', 'details']) {
    await go(page, `#/video/${recordedId}/${tab}`)
    await sleep(500)
    await shot(page, `video-${tab}`)
  }
  await go(page, '#/record')
  await shot(page, 'record')
  for (const section of ['general', 'recording', 'sarvam', 'about']) {
    await go(page, `#/settings/${section}`)
    await shot(page, `settings-${section}`)
  }
  await go(page, '#/library')
}

async function main() {
  fs.rmSync(LOGS, { force: true })
  fs.rmSync(FAILURE_SHOT, { force: true })
  if (!fs.existsSync(EXE)) throw new Error(`missing ${EXE}; run pnpm desktop:build first`)
  const running = runningInstance()
  if (running) throw new Error(`${running} is already running (check the tray); quit it before the smoke test`)
  if (await portInUse(PORT)) throw new Error(`port ${PORT} is busy; is Butterfly Record already running?`)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butterfly-smoke-'))
  const library = path.join(scratch, 'library')
  const config = path.join(scratch, 'config')
  const importDir = path.join(scratch, 'elsewhere')
  const importFile = path.join(importDir, 'Imported clip.webm')
  fs.mkdirSync(library)
  fs.mkdirSync(config)
  fs.mkdirSync(importDir)
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(TEST_SETTINGS))
  report.library = library

  const app = spawn(EXE, [], {
    env: {
      ...process.env,
      BUTTERFLY_RECORD_LIBRARY_DIR: library,
      BUTTERFLY_RECORD_CONFIG_DIR: config,
      BUTTERFLY_RECORD_WEBVIEW_ARGS: WEBVIEW_ARGS,
      BUTTERFLY_RECORD_TEST_IMPORT: importFile,
    },
    stdio: 'ignore',
  })
  let exited = null
  const exitPromise = new Promise((resolve) => {
    app.once('exit', (code, signal) => {
      exited = { code, signal }
      resolve(exited)
    })
  })
  // The app has no console, so Ctrl+C would otherwise leave it recording into the scratch folder.
  const interrupt = () => {
    app.kill()
    process.exit(130)
  }
  for (const signal of ['SIGINT', 'SIGBREAK', 'SIGTERM']) process.once(signal, interrupt)

  let browser = null
  let mainWindow = null
  try {
    browser = await waitFor('the CDP endpoint', 30_000, async () => {
      if (exited) {
        const hint = exited.code === 0 ? ' (another Butterfly Record instance probably took the launch)' : ''
        throw new Error(`the app exited early: ${JSON.stringify(exited)}${hint}`)
      }
      return chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
    })
    const context = browser.contexts()[0]
    const watch = (page) => {
      page.on('console', (message) => log(`[${new URL(page.url()).pathname}] [${message.type()}] ${message.text()}`))
      page.on('pageerror', (error) => log(`[${new URL(page.url()).pathname}] [pageerror] ${error.stack ?? error}`))
    }
    context.on('page', watch)
    context.pages().forEach(watch)

    mainWindow = await waitFor('the main window', 30_000, async () =>
      context.pages().find((page) => /^https:\/\/tauri\.localhost\/(index\.html)?(#.*)?$/.test(page.url())),
    )
    await mainWindow.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 })
    check('main window rendered', true, mainWindow.url())

    // Record

    await go(mainWindow, '#/record')
    await shot(mainWindow, 'record-idle')

    // Camera overlay: open on the Record page, live, in the configured frame

    if (FAKE_CAPTURE) {
      const overlay = await waitFor('the camera overlay window', 20_000, async () => cameraPage(context))
      const feed = await waitFor('the camera overlay to show a picture', 20_000, async () => {
        const current = await cameraFeed(overlay).catch(() => null)
        // Not just non-zero: a shape hint a camera cannot meet can crop the picture to almost
        // nothing, which still reports a width.
        return current?.videoWidth >= 32 && current.readyState >= 2 ? current : null
      })
      check('the camera overlay shows a live picture', !feed.unavailable, feed)
      // 16:9, the 'wide' frame in TEST_SETTINGS; a circle would be square instead.
      const ratio = feed.innerWidth / feed.innerHeight
      check('the overlay keeps the frame aspect ratio', Math.abs(ratio - 16 / 9) < 0.05, {
        ratio,
        size: [feed.innerWidth, feed.innerHeight],
      })
      check('the overlay is mirrored', feed.mirrored, feed.mirrored)
      await shot(overlay, 'camera-overlay')
      report.camera = { feed }

      // A background effect is drawn over the video, and stays on for the recording below.
      await mainWindow.getByRole('radio', { name: 'Blur' }).click()
      const effect = await waitFor('the camera effect to be drawn', 60_000, async () => {
        const current = await cameraEffect(overlay).catch(() => null)
        return current?.shown ? current : null
      })
      const moved = await waitFor('the camera effect to keep up with the camera', 10_000, async () => {
        const current = await cameraEffect(overlay).catch(() => null)
        return current && current.signature !== effect.signature ? current : null
      }).catch(() => null)
      check('the overlay draws the background effect over a live picture', effect.contrast > 8 && moved !== null, {
        effect,
        moved,
      })
      await shot(overlay, 'camera-overlay-blur')
      report.camera.effect = { effect, moved }
    }

    log('[step] clicking Start recording')
    await mainWindow.getByRole('button', { name: 'Start recording' }).click()

    const id = await waitFor('the recording session', 30_000, async () => {
      const error = await mainWindow.locator('[role="alert"]').first().textContent({ timeout: 100 }).catch(() => null)
      if (error) throw new Error(`recording did not start: ${error.trim()}`)
      return sessions(library).find((session) => fileSize(path.join(library, '.butterfly', session, 'source.part')) !== null)
    })
    const sessionDir = path.join(library, '.butterfly', id)
    const part = path.join(sessionDir, 'source.part')
    await waitFor('encoded bytes in source.part', 15_000, async () => (fileSize(part) ?? 0) > 0)
    check('recording streams into source.part', true, { id, bytes: fileSize(part) })

    const hud = await waitFor('the recording controls window', 15_000, async () =>
      context.pages().find((page) => page.url().includes('/hud.html')),
    )
    log('[step] recording; waiting before stop')
    await sleep(RECORD_SECONDS * 1000)
    await shot(hud, 'hud-recording')
    const partBytesBeforeStop = fileSize(part)
    log('[step] clicking Stop in the recording bar')
    await hud.getByRole('button', { name: 'Stop' }).click()
    log('[step] Stop clicked')

    const manifest = await waitFor('the finished recording', 120_000, async () => {
      const current = readManifest(library, id)
      return current?.status === 'ready' && current.media && !fs.existsSync(part) ? current : null
    })
    await waitFor('the poster', 30_000, async () => (fileSize(path.join(sessionDir, 'poster.jpg')) ?? 0) > 0)

    const webms = fs.readdirSync(library).filter((name) => name.toLowerCase().endsWith('.webm'))
    check('exactly one .webm in the library folder', webms.length === 1, webms)
    const mediaFile = path.join(library, webms[0])
    const mediaBytes = fileSize(mediaFile)
    check('the .webm is not empty', mediaBytes > 0, { bytes: mediaBytes, partBytesBeforeStop })
    check('manifest is ready', manifest.status === 'ready', manifest.status)
    if (FAKE_CAPTURE) {
      const camera = manifest.camera
      check(
        'manifest records the camera',
        camera?.present === true && camera.mode === 'overlay' && camera.shape === 'wide' && camera.mirrored === true,
        camera,
      )
      report.camera.manifest = camera
    }
    check('manifest points at the file', manifest.media.path === webms[0] && manifest.media.external === false, manifest.media)
    check('source.part is gone', !fs.existsSync(part))
    check('poster.jpg exists', true, { bytes: fileSize(path.join(sessionDir, 'poster.jpg')) })

    const media = await probe(mediaFile)
    check('duration is over 4 s', media.duration > 4, media.duration)
    check('duration is in the header (the remux ran)', (media.metadataDuration ?? 0) > 4, media.metadataDuration)
    check('VP9 video', media.video?.codec === 'vp9', media.video)
    const sources = manifest.audio.tracks.map((track) => track.kind)
    if (sources.length > 0) check('Opus audio', media.audio?.codec === 'opus', { sources, audio: media.audio })
    else check('no audio track without audio sources', media.audio === null)
    report.recording = {
      id,
      file: webms[0],
      bytes: mediaBytes,
      media,
      manifest: {
        status: manifest.status,
        title: manifest.title,
        duration: manifest.duration,
        bytes: manifest.bytes,
        media: manifest.media,
        video: manifest.video,
        audio: { codec: manifest.audio.codec, tracks: manifest.audio.tracks },
      },
    }

    await waitFor('the video page', 15_000, async () => mainWindow.url().includes(`#/video/${id}`))
    check('the app opened the new video', true, mainWindow.url())

    if (FAKE_CAPTURE) {
      // Leaving the Record page must close the overlay, or the camera light stays on.
      const closed = await waitFor('the camera overlay to close', 20_000, async () =>
        cameraPage(context) === null ? true : null,
      ).catch(() => false)
      check('the camera is released after recording', closed === true)
    }

    // Import a copy from outside the library folder

    fs.copyFileSync(mediaFile, importFile)
    await go(mainWindow, '#/library')
    await mainWindow.getByRole('button', { name: 'Import video' }).first().click()
    const importedId = await waitFor('the imported item', 60_000, async () => {
      const found = sessions(library).find((session) => session !== id && readManifest(library, session)?.status === 'ready')
      return found && (fileSize(path.join(library, '.butterfly', found, 'poster.jpg')) ?? 0) > 0 ? found : null
    })
    const imported = readManifest(library, importedId)
    check('import manifest', imported.producer.app === 'import' && imported.media.external === true, imported.media)
    check('import keeps the file where it is', path.resolve(imported.media.path) === path.resolve(importFile))
    check('import duration', imported.duration > 4, imported.duration)
    check('import poster', true, { bytes: fileSize(path.join(library, '.butterfly', importedId, 'poster.jpg')) })
    check('nothing was copied into the library', fs.readdirSync(library).filter((n) => n.endsWith('.webm')).length === 1)
    await waitFor('the imported video page', 15_000, async () => mainWindow.url().includes(`#/video/${importedId}`))
    check('the app opened the imported video', true, mainWindow.url())
    await go(mainWindow, '#/library')
    const cards = await waitFor('two cards in the library', 15_000, async () => {
      const count = await mainWindow.locator('article.card').count()
      return count >= 2 ? count : null
    })
    check('the library shows both items', cards === 2, cards)
    report.imported = { id: importedId, media: imported.media, duration: imported.duration, title: imported.title }

    await screenshotViews(mainWindow, id)

    // Quit through the command the app uses itself

    await mainWindow.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_quit')).catch(() => {})
    const status = await Promise.race([exitPromise, sleep(15_000).then(() => null)])
    check('the app exits on app_quit', status !== null, status)

    report.ok = true
  } catch (error) {
    await mainWindow?.screenshot({ path: FAILURE_SHOT }).catch(() => {})
    throw error
  } finally {
    await browser?.close().catch(() => {})
    if (!exited) app.kill()
    if (!process.env.SMOKE_KEEP) {
      await waitFor('the app to release the library', 15_000, async () => exited !== null).catch(() => {})
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
  }
}

main()
  .catch((error) => {
    report.error = error.stack ?? String(error)
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
    console.log(`${report.ok ? 'OK' : 'FAILED'}; report: ${REPORT}; console: ${LOGS}`)
  })
