// Camera permission for the extension origin, top level vs. iframe; fresh profile, no fake permission UI.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { launch, freshDir, extensionId, attachConsoleCollector, WORKDIR } from './common.mjs'

const PORT = 9336
const HTTP_PORT = 8909
const report = { goal: 'permission-model-probe', fakePermissionUI: false, startedAt: new Date().toISOString(), steps: [] }
const step = (name, data) => {
  report.steps.push({ name, ...data })
  console.log(`[step] ${name}: ${JSON.stringify(data)}`)
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>probe</title><h1>permission probe page</h1>')
})
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r))

const profileDir = freshDir('profile-probe')
const logFile = path.join(WORKDIR, 'logs-probe.txt')
fs.writeFileSync(logFile, '')

let context
let collector
try {
  context = await launch({ profileDir, port: PORT, fakeUI: false })
  collector = await attachConsoleCollector(PORT, logFile)
  const id = await extensionId(context)

  const lib = await context.newPage()
  await lib.goto(`chrome-extension://${id}/library.html`, { waitUntil: 'domcontentloaded' })

  const pre = await lib.evaluate(async () => ({
    camera: (await navigator.permissions.query({ name: 'camera' })).state,
    microphone: (await navigator.permissions.query({ name: 'microphone' })).state,
  }))
  step('extension-origin-pre-use', pre)

  // Race a timeout so an unanswered prompt shows up as pending.
  const topGum = await lib.evaluate(() =>
    Promise.race([
      navigator.mediaDevices
        .getUserMedia({ video: true })
        .then((s) => {
          const labels = s.getVideoTracks().map((t) => t.label)
          s.getTracks().forEach((t) => t.stop())
          return { result: 'stream', labels }
        })
        .catch((e) => ({ result: 'rejected', name: e.name, message: e.message })),
      new Promise((r) => setTimeout(() => r({ result: 'pending-after-8s (prompt shown, nobody answered)' }), 8000)),
    ]),
  )
  step('extension-origin-top-level-gum', topGum)

  const post = await lib.evaluate(async () => ({
    camera: (await navigator.permissions.query({ name: 'camera' })).state,
  }))
  step('extension-origin-post-gum', post)

  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'load' })
  await page.bringToFront()
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
    const probe = await frame.evaluate(async () => {
      const until = Date.now() + 10000
      let v = null
      while (Date.now() < until) {
        v = document.querySelector('video')
        if (v && v.videoWidth > 0) break
        await new Promise((r) => setTimeout(r, 250))
      }
      return {
        live: !!v && v.videoWidth > 0,
        videoWidth: v?.videoWidth ?? 0,
        permission: (await navigator.permissions.query({ name: 'camera' })).state,
        fallbackLabel: document.querySelector('.fallback span')?.textContent ?? null,
        fallbackTitle: document.querySelector('.fallback')?.getAttribute('title') || null,
      }
    })
    step('iframe-probe', probe)
  }
} catch (e) {
  report.error = e.message
  console.error(e)
} finally {
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(WORKDIR, 'report-permission-probe.json'), JSON.stringify(report, null, 2))
  collector?.close()
  await context?.close().catch(() => {})
  server.close()
}
