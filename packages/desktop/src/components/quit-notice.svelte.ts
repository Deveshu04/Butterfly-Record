import { untrack } from 'svelte'

import { onQuitRequested } from '../lib/ipc.ts'
import { recorder } from '../lib/recorder.svelte.ts'
import { toasts } from './toasts.svelte.ts'

const MESSAGE = 'Finishing your recording before closing…'

/**
 * Quit waits for the recorder to save the current take; this says so in the main window
 * until the recorder is idle again. Call once, from a component that is always mounted.
 */
export function quitNotice(): void {
  let notice: number | null = null

  $effect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    onQuitRequested(() => {
      const phase = recorder.phase
      // Starting and countdown are cancelled rather than saved, which is immediate.
      if (notice !== null || (phase !== 'recording' && phase !== 'paused' && phase !== 'finalizing')) return
      notice = toasts.push(MESSAGE, { timeout: Number.POSITIVE_INFINITY })
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) => console.warn('[butterfly-record] quit notice unavailable', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  })

  $effect(() => {
    if (recorder.phase !== 'idle' || notice === null) return
    const id = notice
    notice = null
    untrack(() => toasts.dismiss(id))
  })
}
