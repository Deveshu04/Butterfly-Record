/** Seconds per J/L or arrow press; the seek bar steps by the same amount. */
export const SEEK_STEP = 6

export const PLAYER_SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['Space', 'K'], action: 'Play or pause' },
  { keys: ['J', 'L'], action: `Back or forward ${SEEK_STEP} seconds` },
  { keys: ['←', '→'], action: `Back or forward ${SEEK_STEP} seconds` },
  { keys: [',', '.'], action: 'Back or forward 1 second' },
  { keys: ['F'], action: 'Full screen' },
  { keys: ['M'], action: 'Mute or unmute' },
  { keys: ['C'], action: 'Captions on or off' },
]

const TEXT_ENTRY = /^(INPUT|TEXTAREA|SELECT)$/
const OWN_SPACE = 'button, a[href], [role="option"], [role="tab"], [role="switch"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="checkbox"]'
const OWN_ARROWS = '[role="listbox"], [role="tablist"], [role="menu"], [role="radiogroup"], [role="slider"], input[type="range"]'

export interface PlayerControls {
  video: () => HTMLVideoElement | undefined
  toggleCaptions: () => void
  toggleFullscreen: () => void
}

/** A window keydown handler; returns early for keys that belong to the focused control. */
export function playerKeydown(controls: PlayerControls) {
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target && (TEXT_ENTRY.test(target.tagName) || target.isContentEditable)) return
    if (document.querySelector('dialog[open], [role="menu"], :popover-open')) return
    const video = controls.video()
    if (!video || !Number.isFinite(video.duration)) return

    const key = event.key
    if (key === ' ' && target?.closest(OWN_SPACE)) return
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && target?.closest(OWN_ARROWS)) return

    const nudge = (seconds: number) => {
      video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds))
    }

    switch (key.toLowerCase()) {
      case ' ':
      case 'k':
        if (video.paused) void video.play().catch(() => {})
        else video.pause()
        break
      case 'j':
      case 'arrowleft':
        nudge(-SEEK_STEP)
        break
      case 'l':
      case 'arrowright':
        nudge(SEEK_STEP)
        break
      case ',':
        nudge(-1)
        break
      case '.':
        nudge(1)
        break
      case 'f':
        controls.toggleFullscreen()
        break
      case 'm':
        video.muted = !video.muted
        break
      case 'c':
        controls.toggleCaptions()
        break
      default:
        return
    }
    event.preventDefault()
  }
}
