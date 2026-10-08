import { untrack } from 'svelte'

import { errorMessage } from '../lib/ipc.ts'

export type ToastTone = 'info' | 'ok' | 'error'

export interface ToastAction {
  label: string
  run: () => void | Promise<void>
}

export interface Toast {
  id: number
  tone: ToastTone
  message: string
  action: ToastAction | null
  timeout: number
}

let nextId = 1

class Toasts {
  list = $state<Toast[]>([])
  /** Text for the polite live region; errors use role="alert" on the toast itself. */
  announcement = $state('')
  /** Open modal dialogs, innermost last. The rest of the page is inert, so the stack renders inside the innermost. */
  hosts = $state<string[]>([])
  /** Due times, shared so a toast keeps its time when the stack moves into a dialog. */
  readonly expiry = new Map<number, number>()

  push(message: string, options: { tone?: ToastTone; action?: ToastAction; timeout?: number } = {}): number {
    const tone = options.tone ?? 'info'
    const toast: Toast = {
      id: nextId++,
      tone,
      message,
      action: options.action ?? null,
      timeout: options.timeout ?? (tone === 'error' ? 8000 : 5000),
    }
    // Keep the stack short; the oldest gives way.
    this.list = [...this.list.slice(-3), toast]
    if (tone !== 'error') {
      // Cleared first so a repeated message is announced again.
      this.announcement = ''
      setTimeout(() => (this.announcement = message), 50)
      // Emptied afterwards so a region mounted later (inside a dialog) does not repeat it.
      setTimeout(() => {
        if (this.announcement === message) this.announcement = ''
      }, 3000)
    }
    return toast.id
  }

  error(error: unknown, action?: ToastAction): number {
    return this.push(errorMessage(error), action ? { tone: 'error', action } : { tone: 'error' })
  }

  dismiss(id: number) {
    this.list = this.list.filter((toast) => toast.id !== id)
    this.expiry.delete(id)
  }

  /** Registers an open modal dialog; returns the function that unregisters it. */
  host(id: string): () => void {
    this.hosts = [...untrack(() => this.hosts), id]
    return () => {
      this.hosts = this.hosts.filter((host) => host !== id)
    }
  }
}

export const toasts = new Toasts()
