// Must stay the first import: in mock mode it installs the IPC stubs before any module talks to Tauri.
import './dev/mock.ts'

import '@butterfly-record/ui/tokens.css'
import './app.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { mount } from 'svelte'

import App from './App.svelte'
import { applyTheme } from './components/theme.ts'
import { toasts } from './components/toasts.svelte.ts'
import { jobs } from './lib/jobs.svelte.ts'
import { library } from './lib/library.svelte.ts'
import { settings } from './lib/settings.svelte.ts'

/** Native menus only where they help: text fields and selectable text. */
function allowsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, [contenteditable="true"]')) return true
  for (let element: Element | null = target; element; element = element.parentElement) {
    const mode = getComputedStyle(element).userSelect
    if (mode === 'text' || mode === 'all') return true
    if (mode === 'none') return false
  }
  return false
}

document.addEventListener('contextmenu', (event) => {
  if (!event.defaultPrevented && !allowsNativeMenu(event.target)) event.preventDefault()
})

await settings.load()
applyTheme(settings.value.theme)

mount(App, { target: document.getElementById('app')! })

const listed = library.refresh().catch((error: unknown) => {
  toasts.error(error)
})
jobs.resumePending().catch((error: unknown) => toasts.error(error))

// The window is created hidden. Showing it once the library has painted avoids a flash of
// empty state, but a slow disk must never keep the app invisible.
await Promise.race([listed, new Promise((resolve) => setTimeout(resolve, 1500))])
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    getCurrentWindow()
      .show()
      .catch((error: unknown) => console.warn('[butterfly-record] could not show the window', error))
  })
})
