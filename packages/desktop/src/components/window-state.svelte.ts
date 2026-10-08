import { getCurrentWindow } from '@tauri-apps/api/window'

// Closing the main window only hides it in the tray, so the page (and anything it plays or
// listens to) keeps running. Hiding deactivates the window, so focus changes drive a re-check;
// the slow poll covers a hide that arrives without one (a taskbar Close on an inactive window).

const POLL_MS = 2000

let shown = $state(true)
let minimized = $state(false)
let pageHidden = $state(typeof document !== 'undefined' && document.hidden)
let watchers = 0
let poll: ReturnType<typeof setInterval> | undefined
let started = false

async function sync(): Promise<void> {
  try {
    const current = getCurrentWindow()
    const [visible, isMinimized] = await Promise.all([current.isVisible(), current.isMinimized()])
    shown = visible !== false
    minimized = isMinimized === true
  } catch {
    // Keep the last known state.
  }
}

function start() {
  if (started) return
  started = true
  const current = getCurrentWindow()
  void current.onFocusChanged(() => void sync()).catch(() => {})
  void current.onResized(() => void sync()).catch(() => {})
  document.addEventListener('visibilitychange', () => {
    pageHidden = document.hidden
    void sync()
  })
}

export const mainWindow = {
  /** On screen: not hidden in the tray. A minimized window still counts. */
  get shown(): boolean {
    return shown
  },
  /** Shown, not minimized, and the page is not reported hidden. */
  get visible(): boolean {
    return shown && !minimized && !pageHidden
  },
  /** Keeps the state fresh while something depends on it; returns the stop function. */
  watch(): () => void {
    start()
    watchers += 1
    if (watchers === 1) {
      void sync()
      poll = setInterval(() => void sync(), POLL_MS)
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      watchers -= 1
      if (watchers === 0) clearInterval(poll)
    }
  },
}
