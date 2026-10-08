// Camera bubble against real hardware: no fake devices, no fake permission UI.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { freshDir, extensionId, attachConsoleCollector, WORKDIR, EXT_PATH } from './common.mjs'
const PORT = 9339
const HTTP_PORT = 8911
const report = { goal: 'real-camera-bubble', fakeDevices: false, fakePermissionUI: false, startedAt: new Date().toISOString(), steps: [] }
const step = (name, data) => {
  report.steps.push({ name, ...data })
  console.log(`[step] ${name}: ${JSON.stringify(data)}`)
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>real-cam probe</title><h1>real camera probe page</h1>')
})
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r))

const profileDir = freshDir('profile-real-camera')
const logFile = path.join(WORKDIR, 'logs-real-camera.txt')
fs.writeFileSync(logFile, '')

let context
let collector
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
    ],
    acceptDownloads: true,
  })
  collector = await attachConsoleCollector(PORT, logFile)
  const id = await extensionId(context)
  step('extension-id', { id })

  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'load' })
  await page.bringToFront()

  // Labels are empty before a grant, but kinds are still reported.
  const devices = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label })),
  )
  step('page-devices', { devices, hasVideoInput: devices.some((d) => d.kind === 'videoinput') })

  await page.evaluate((extId) => {
    const f = document.createElement('iframe')
    f.src = `chrome-extension://${extId}/bubble.html`
    f.setAttribute('allow', 'camera; microphone')
    f.width = 300
    f.height = 300
    document.body.append(f)
  }, id)

  let frame = null
  const deadline = Date.now() + 15000
  while (!frame && Date.now() < deadline) {
    frame = page.frames().find((f) => f.url().includes('bubble.html')) ?? null
    await new Promise((r) => setTimeout(r, 300))
  }
  step('iframe', { loaded: !!frame, url: frame?.url() ?? null })

  if (frame) {
    // Camera startup can take several seconds on real hardware.
    const probe = await frame.evaluate(async () => {
      const until = Date.now() + 20000
      let v = null
      while (Date.now() < until) {
        v = document.querySelector('video')
        const fallback = document.querySelector('.fallback span')
        if ((v && v.videoWidth > 0) || fallback) break
        await new Promise((r) => setTimeout(r, 250))
      }
      let perm = 'unavailable'
      try {
        perm = (await navigator.permissions.query({ name: 'camera' })).state
      } catch {}
      return {
        live: !!v && (v?.videoWidth ?? 0) > 0,
        videoWidth: v?.videoWidth ?? 0,
        videoHeight: v?.videoHeight ?? 0,
        readyState: v?.readyState ?? null,
        permission: perm,
        fallbackLabel: document.querySelector('.fallback span')?.textContent ?? null,
        fallbackTitle: document.querySelector('.fallback')?.getAttribute('title') || null,
      }
    })
    step('iframe-probe', probe)
    report.verdict = probe.live ? 'LIVE' : 'NOT-LIVE'
  } else {
    report.verdict = 'IFRAME-DID-NOT-LOAD'
  }
} catch (e) {
  report.error = e.message
  console.error(e)
} finally {
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(WORKDIR, 'report-real-camera.json'), JSON.stringify(report, null, 2))
  collector?.close()
  await context?.close().catch(() => {})
  server.close()
}
