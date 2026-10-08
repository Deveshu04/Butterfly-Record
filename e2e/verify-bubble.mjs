/*
  Checks that the camera bubble gets live video during a screen recording.
  Pass --no-fake-ui to use real permission prompts instead of auto-grant.
*/
import fs from 'node:fs'
import http from 'node:http'
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

const FAKE_UI = !process.argv.includes('--no-fake-ui')
const PORT = FAKE_UI ? 9334 : 9335
const HTTP_PORT = FAKE_UI ? 8907 : 8908
const suffix = FAKE_UI ? '' : '-noprompt'

const report = {
  goal: `camera-bubble${suffix}`,
  fakePermissionUI: FAKE_UI,
  startedAt: new Date().toISOString(),
  steps: [],
  verdict: 'UNKNOWN',
}
const step = (name, data) => {
  report.steps.push({ name, ...data })
  console.log(`[step] ${name}: ${JSON.stringify(data)}`)
}

// Content scripts do not run on file://, so serve the test page over http.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    '<!doctype html><title>bubble test</title><h1>Butterfly bubble test page</h1><p>plain http page, no Permissions-Policy header</p>',
  )
})
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r))

const profileDir = freshDir(`profile-bubble${suffix}`)
const logFile = path.join(WORKDIR, `logs-bubble${suffix}.txt`)
fs.writeFileSync(logFile, '')

let context
let collector
try {
  context = await launch({ profileDir, port: PORT, fakeUI: FAKE_UI })
  collector = await attachConsoleCollector(PORT, logFile)

  const id = await extensionId(context)
  step('extension-id', { id })

  await context.addInitScript(() => {
    window.__bubbleMsgs = []
    window.addEventListener('message', (e) => {
      if (e.data?.source === 'butterfly-bubble') window.__bubbleMsgs.push(e.data)
    })
  })

  const lib = await context.newPage()
  await lib.goto(`chrome-extension://${id}/library.html`, { waitUntil: 'domcontentloaded' })

  const settings = await lib.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings')
    const next = { ...(stored.settings ?? {}), cameraEnabled: true }
    await chrome.storage.local.set({ settings: next })
    return next
  })
  step('settings', { cameraEnabled: settings.cameraEnabled, cameraId: settings.cameraId ?? null })

  const testPage = await context.newPage()
  await testPage.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'load' })
  await testPage.bringToFront()
  await new Promise((r) => setTimeout(r, 500))

  // Starting a recording injects the overlay into the active tab.
  const startReply = await toBackground(lib, {
    target: 'background',
    type: 'start-recording',
    scope: 'screen',
    crop: null,
  })
  step('start-recording-reply', { reply: startReply })
  if (!startReply?.ok) throw new Error(`start-recording failed: ${JSON.stringify(startReply)}`)

  let bubbleFrame = null
  const frameDeadline = Date.now() + 30000
  while (!bubbleFrame && Date.now() < frameDeadline) {
    bubbleFrame = testPage.frames().find((f) => f.url().includes('bubble.html')) ?? null
    if (!bubbleFrame) {
      // A broken web_accessible_resources entry leaves the frame at about:blank.
      const blank = testPage.frames().filter((f) => f !== testPage.mainFrame() && f.url() === 'about:blank')
      if (blank.length && Date.now() > frameDeadline - 5000) bubbleFrame = blank[0]
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  step('bubble-frame', {
    found: !!bubbleFrame,
    url: bubbleFrame?.url() ?? null,
    allFrames: testPage.frames().map((f) => f.url()),
  })
  if (!bubbleFrame) throw new Error('bubble iframe never appeared in the frame tree')

  const probe = await bubbleFrame.evaluate(async () => {
    const out = {}
    const until = Date.now() + 10000
    let v = null
    while (Date.now() < until) {
      v = document.querySelector('video')
      if (v && v.videoWidth > 0) break
      await new Promise((r) => setTimeout(r, 250))
    }
    out.hasVideoEl = !!v
    out.videoWidth = v?.videoWidth ?? 0
    out.videoHeight = v?.videoHeight ?? 0
    out.readyState = v?.readyState ?? null
    out.live = !!v && v.videoWidth > 0
    out.fallbackLabel = document.querySelector('.fallback span')?.textContent ?? null
    out.fallbackTitle = document.querySelector('.fallback')?.getAttribute('title') || null

    const fp = document.featurePolicy
    out.featurePolicy = fp?.allowsFeature
      ? { camera: fp.allowsFeature('camera'), microphone: fp.allowsFeature('microphone') }
      : 'featurePolicy API missing'

    try {
      const st = await navigator.permissions.query({ name: 'camera' })
      out.permissionState = st.state
    } catch (e) {
      out.permissionState = `query failed: ${e.message}`
    }

    // Race a timeout so a pending prompt is distinguishable from a rejection.
    out.gum = await Promise.race([
      navigator.mediaDevices
        .getUserMedia({ video: true })
        .then((s) => {
          const labels = s.getVideoTracks().map((t) => t.label)
          s.getTracks().forEach((t) => t.stop())
          return { result: 'stream', labels }
        })
        .catch((e) => ({ result: 'rejected', name: e.name, message: e.message })),
      new Promise((r) => setTimeout(() => r({ result: 'pending-after-8s (a permission prompt is up or swallowed)' }), 8000)),
    ])

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      out.devices = devices.map((d) => ({ kind: d.kind, label: d.label, id: d.deviceId ? d.deviceId.slice(0, 8) : '' }))
    } catch (e) {
      out.devices = `enumerate failed: ${e.message}`
    }
    return out
  })
  step('bubble-probe', probe)

  const top = await testPage.evaluate(async () => {
    const fp = document.featurePolicy
    const out = {
      featurePolicyCamera: fp?.allowsFeature ? fp.allowsFeature('camera') : 'featurePolicy API missing',
      bubbleMsgs: window.__bubbleMsgs ?? [],
    }
    try {
      const st = await navigator.permissions.query({ name: 'camera' })
      out.permissionState = st.state
    } catch (e) {
      out.permissionState = `query failed: ${e.message}`
    }
    return out
  })
  step('top-frame', top)

  const extPerm = await lib.evaluate(async () => {
    try {
      const st = await navigator.permissions.query({ name: 'camera' })
      return st.state
    } catch (e) {
      return `query failed: ${e.message}`
    }
  })
  step('extension-origin-permission', { libraryPage: extPerm })

  const cancelReply = await toBackground(lib, { target: 'background', type: 'cancel-recording' })
  step('cancel-recording-reply', { reply: cancelReply })
  await waitForPhase(lib, (s) => s.phase === 'idle', 30000, 'idle after cancel').catch((e) =>
    step('cancel-wait-error', { error: e.message }),
  )

  const permReply = await Promise.race([
    toBackground(lib, { target: 'background', type: 'request-permissions' }),
    new Promise((r) => setTimeout(() => r({ ok: false, error: 'no reply within 15s (a real permission prompt is pending in the recorder tab)' }), 15000)),
  ])
  await new Promise((r) => setTimeout(r, 4000))
  const pagesNow = context.pages().map((p) => p.url())
  step('request-permissions', { reply: permReply, pagesAfter: pagesNow })
  const extPermAfter = await lib.evaluate(async () => {
    try {
      return (await navigator.permissions.query({ name: 'camera' })).state
    } catch (e) {
      return `query failed: ${e.message}`
    }
  })
  step('extension-origin-permission-after-request', { libraryPage: extPermAfter })

  await new Promise((r) => setTimeout(r, 500))
  const camLines = collector.grep(/camera|bubble|getUserMedia|NotAllowed|Overconstrained|NotFound|NotReadable/i)
  report.consoleEvidence = camLines.map((l) => `[${l.targetType}] ${l.targetUrl} :: ${l.text}`)

  report.evidence = { probe, top, extPerm, extPermAfter }
  report.verdict = probe.live ? 'LIVE' : 'BROKEN'
} catch (e) {
  report.error = e.message
  if (report.verdict === 'UNKNOWN') report.verdict = 'BLOCKED'
  console.error(e)
} finally {
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(WORKDIR, `report-bubble${suffix}.json`), JSON.stringify(report, null, 2))
  collector?.close()
  await context?.close().catch(() => {})
  server.close()
  console.log(`\nVERDICT: ${report.verdict}`)
  process.exit(0)
}
