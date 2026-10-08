import type { IconName } from '@butterfly-record/ui'

export type MenuEntry =
  | {
      kind?: 'item'
      label: string
      icon?: IconName | undefined
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string }

export interface MenuState {
  entries: MenuEntry[]
  x: number
  y: number
  /** Right edge alignment for menus opened from a button near the right side. */
  align: 'start' | 'end'
  anchor: HTMLElement | null
  /** Scrolling the container of this element dismisses the menu. */
  origin: Element | null
  /** Where keyboard focus goes back to when the menu closes. */
  returnFocus: HTMLElement | null
  label: string
}

function focused(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null
}

class MenuController {
  current = $state<MenuState | null>(null)

  openAt(event: MouseEvent, entries: MenuEntry[], label = 'Context menu') {
    event.preventDefault()
    const origin = event.target instanceof Element ? event.target : null
    this.current = {
      entries,
      x: event.clientX,
      y: event.clientY,
      align: 'start',
      anchor: null,
      origin,
      // A keyboard ContextMenu press can open over a menu that already holds focus.
      returnFocus: this.current?.returnFocus ?? focused(),
      label,
    }
  }

  openFrom(anchor: HTMLElement, entries: MenuEntry[], label: string, align: 'start' | 'end' = 'end') {
    if (this.current?.anchor === anchor) {
      this.close()
      return
    }
    const rect = anchor.getBoundingClientRect()
    this.current = {
      entries,
      x: align === 'end' ? rect.right : rect.left,
      y: rect.bottom + 4,
      align,
      anchor,
      origin: anchor,
      returnFocus: anchor,
      label,
    }
  }

  /** Closes from the keyboard or a chosen item; pointer dismissals clear `current` directly. */
  close() {
    const target = this.current?.returnFocus
    this.current = null
    if (target?.isConnected) target.focus()
  }
}

export const menu = new MenuController()
