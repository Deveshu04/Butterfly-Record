import { chromium } from 'playwright'
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'chrome-mv3')
export const WORKDIR = path.dirname(fileURLToPath(import.meta.url))

export function freshDir(name) {
  const dir = path.join(WORKDIR, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function launch({ profileDir, port, fakeUI = true }) {
  const args = [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--auto-select-desktop-capture-source=Entire screen',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
  ]
  if (fakeUI) args.push('--use-fake-ui-for-media-stream')

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args,
    // Recordings download automatically when they finish.
    acceptDownloads: true,
  })
  return context
}

export async function extensionId(context, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))
    if (sw) return new URL(sw.url()).host
    if (Date.now() > deadline) throw new Error('extension service worker never appeared')
    await new Promise((r) => setTimeout(r, 250))
  }
}

// Raw CDP, because Playwright does not expose the offscreen document's console.
export async function attachConsoleCollector(port, logFile) {
  // The DevTools http endpoint can lag the browser launch slightly.
  let wsUrl = null
  const deadline = Date.now() + 15000
  while (!wsUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      wsUrl = (await res.json()).webSocketDebuggerUrl
    } catch {
      if (Date.now() > deadline) throw new Error(`CDP endpoint on :${port} never came up`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })

  const sessions = new Map() // sessionId -> {type, url}
  const attached = new Set()
  const lines = []

  const record = (sessionId, level, text) => {
    const src = sessions.get(sessionId) ?? { type: '?', url: '?' }
    const entry = { ts: new Date().toISOString(), targetType: src.type, targetUrl: src.url, level, text }
    lines.push(entry)
    fs.appendFileSync(logFile, `${entry.ts} [${entry.targetType}] [${entry.level}] ${entry.targetUrl} :: ${entry.text}\n`)
  }

  const fmtArg = (a) => {
    if (a == null) return 'null'
    if ('value' in a) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)
    if (a.unserializableValue) return a.unserializableValue
    if (a.preview?.properties) {
      return `{${a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')}}`
    }
    return a.description ?? a.type
  }

  const tryAttach = async (info) => {
    if (attached.has(info.targetId)) return
    if (info.type === 'browser' || info.type === 'tab') return
    attached.add(info.targetId)
    try {
      await send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    } catch {
      /* target already gone */
    }
  }

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
    switch (msg.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        void tryAttach(msg.params.targetInfo)
        break
      case 'Target.targetDestroyed':
        fs.appendFileSync(logFile, `${new Date().toISOString()} [lifecycle] targetDestroyed ${msg.params.targetId}\n`)
        break
      case 'Target.targetCrashed':
        fs.appendFileSync(
          logFile,
          `${new Date().toISOString()} [lifecycle] targetCrashed ${msg.params.targetId} status=${msg.params.status} code=${msg.params.errorCode}\n`,
        )
        break
      case 'Target.detachedFromTarget':
        sessions.delete(msg.params.sessionId)
        break
      case 'Target.attachedToTarget': {
        const { sessionId, targetInfo } = msg.params
        sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url })
        void send('Runtime.enable', {}, sessionId).catch(() => {})
        break
      }
      case 'Runtime.consoleAPICalled': {
        if (!msg.sessionId) break
        const { type, args } = msg.params
        record(msg.sessionId, type, args.map(fmtArg).join(' '))
        break
      }
      case 'Runtime.exceptionThrown': {
        if (!msg.sessionId) break
        const d = msg.params.exceptionDetails
        const desc = d.exception?.description ?? d.text
        record(msg.sessionId, 'exception', desc)
        break
      }
    }
  })

  await send('Target.setDiscoverTargets', { discover: true })

  return {
    lines,
    grep: (re) => lines.filter((l) => re.test(l.text)),
    close: () => {
      try {
        ws.close()
      } catch {}
    },
  }
}

export function toBackground(page, message) {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), message)
}

export async function waitForPhase(page, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await toBackground(page, { target: 'background', type: 'get-state' })
    const state = last?.ok ? last.value : null
    if (state && predicate(state)) return state
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(last)}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}
