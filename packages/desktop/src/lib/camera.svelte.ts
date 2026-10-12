// The main window's half of the camera overlay. The overlay itself is a separate window
// drawn over the desktop; this owns when it exists, tells it what to show, and remembers
// wherever the user drags or resizes it. The camera is released with the window, so the
// camera light never stays on after the Record page or a recording is done with it.

import type { UnlistenFn } from '@tauri-apps/api/event'
import { Window } from '@tauri-apps/api/window'

import type { AppSettings } from './app-settings.ts'
import { clampCameraSize, overlaySize, type CameraAnchor } from './camera-layout.ts'
import {
  cameraAnchor,
  cameraClose,
  cameraOpen,
  cameraResetPosition,
  cameraSetProtected,
  cameraSetSize,
  cameraSetVisible,
  emitCameraConfig,
  errorMessage,
  onCameraState,
  type CameraPlacement,
  type CameraState,
} from './ipc.ts'
import { settings } from './settings.svelte.ts'
import type { OverlayPlacement } from './workers/composite-protocol.ts'

export type CameraStatus = 'off' | 'starting' | 'live' | 'error'

type Scope = AppSettings['recording']['scope']
type PlacementWatcher = (placement: OverlayPlacement) => void

/** Long enough that a drag or a resize saves once, not on every pixel. */
const SAVE_DELAY_MS = 300

function warn(context: string) {
  return (error: unknown) => console.warn(`[butterfly-record] ${context}`, error)
}

function samePlacement(a: CameraPlacement | null, b: CameraPlacement | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y
}

class CameraOverlay {
  #open = $state(false)
  #status = $state<CameraStatus>('off')
  #error = $state<string | null>(null)
  #visible = $state(true)

  /** The Record page is showing with the camera turned on. */
  #previewing = false
  /** A recording that uses the camera is running. */
  #recording = false
  #scope: Scope | null = null

  /** Opening and closing are serialized: a fast switch must not leave a stray window. */
  #queue: Promise<void> = Promise.resolve()
  #unlistenState: UnlistenFn | null = null
  #unlistenWindow: UnlistenFn[] = []
  #saveTimer: ReturnType<typeof setTimeout> | null = null
  #movedTo: CameraPlacement | null = null
  #resizedTo: number | null = null
  /** A window recording in progress, following the overlay around the desktop. */
  #placementWatchers = new Set<PlacementWatcher>()
  /** Events are not buffered: the first push can land before the overlay is listening. */
  #greet = false

  get open(): boolean {
    return this.#open
  }
  get status(): CameraStatus {
    return this.#status
  }
  get error(): string | null {
    return this.#error
  }
  get visible(): boolean {
    return this.#visible
  }

  /** Record page mount and unmount, and the Camera switch. */
  async preview(on: boolean): Promise<void> {
    this.#previewing = on && settings.value.recording.camera.enabled
    await this.#sync()
  }

  /** Pushes the current settings to an open overlay. */
  async apply(): Promise<void> {
    if (!this.#open) return
    const camera = settings.value.recording.camera
    const { width, height } = overlaySize(camera.shape, camera.size)
    try {
      await cameraSetSize(width, height)
      await cameraSetProtected(this.#protectedNow())
    } catch (error) {
      warn('camera overlay could not be updated')(error)
    }
    await this.#push()
  }

  async resetPosition(): Promise<void> {
    const { corner } = settings.value.recording.camera
    this.#cancelSave()
    if (!this.#open) {
      await this.#store({ position: null })
      return
    }
    try {
      await this.#store({ position: await cameraResetPosition(corner) })
    } catch (error) {
      warn('camera overlay could not be moved')(error)
    }
    await this.#publishPlacement()
  }

  /**
   * Where the overlay sits on its monitor, as fractions of the work area. Null when it is
   * closed, off every monitor, or its position cannot be read.
   */
  async anchor(): Promise<CameraAnchor | null> {
    if (!this.#open) return null
    try {
      return await cameraAnchor()
    } catch (error) {
      warn('camera position could not be read')(error)
      return null
    }
  }

  /** Reports where and how big the overlay is after each settled drag or resize. */
  onPlacementChange(watcher: PlacementWatcher): () => void {
    this.#placementWatchers.add(watcher)
    return () => {
      this.#placementWatchers.delete(watcher)
    }
  }

  async #publishPlacement(): Promise<void> {
    if (this.#placementWatchers.size === 0) return
    const placement: OverlayPlacement = {
      anchor: await this.anchor(),
      size: settings.value.recording.camera.size,
    }
    for (const watcher of this.#placementWatchers) watcher(placement)
  }

  /** The recording bar's camera toggle. */
  async setVisible(visible: boolean): Promise<void> {
    this.#visible = visible
    if (!this.#open) return
    await cameraSetVisible(visible).catch(warn('camera overlay could not be hidden'))
  }

  async close(): Promise<void> {
    this.#previewing = false
    this.#recording = false
    this.#scope = null
    await this.#sync()
  }

  /**
   * The recorder holds the overlay for the length of a take: it stays open even if the
   * Record page goes away, and content protection follows what is being recorded.
   * Returns whether the camera can be used.
   */
  async beginRecording(scope: Scope): Promise<boolean> {
    this.#recording = true
    this.#scope = scope
    this.#visible = true
    await this.#sync()
    if (!this.#open) return false
    try {
      await cameraSetProtected(this.#protectedNow())
      await cameraSetVisible(true)
    } catch (error) {
      warn('camera overlay could not be prepared')(error)
    }
    await this.#push()
    return this.#status !== 'error'
  }

  async endRecording(): Promise<void> {
    if (!this.#recording) return
    this.#recording = false
    this.#scope = null
    this.#visible = true
    await this.#sync()
    if (!this.#open) return
    await cameraSetProtected(this.#protectedNow()).catch(warn('camera protection not restored'))
    await this.#push()
  }

  /** A window recording cannot show the overlay, so there it is a preview kept out of captures. */
  #protectedNow(): boolean {
    return (this.#scope ?? settings.value.recording.scope) === 'window'
  }

  #push(): Promise<void> {
    const camera = settings.value.recording.camera
    return emitCameraConfig({
      deviceId: camera.deviceId,
      shape: camera.shape,
      mirror: camera.mirror,
      recording: this.#recording,
    }).catch(warn('camera settings not sent'))
  }

  #sync(): Promise<void> {
    const wanted = this.#previewing || this.#recording
    this.#queue = this.#queue
      .then(async () => {
        if (wanted === this.#open) return
        if (wanted) await this.#openWindow()
        else await this.#closeWindow()
      })
      .catch(warn('camera overlay'))
    return this.#queue
  }

  async #openWindow(): Promise<void> {
    const camera = settings.value.recording.camera
    const { width, height } = overlaySize(camera.shape, camera.size)
    this.#status = 'starting'
    this.#error = null
    this.#greet = true
    this.#unlistenState ??= await onCameraState((state) => this.#onState(state)).catch(
      (error: unknown) => {
        warn('camera status unavailable')(error)
        return null
      },
    )
    try {
      const placement = await cameraOpen({
        width,
        height,
        x: camera.position ? camera.position.x : null,
        y: camera.position ? camera.position.y : null,
        corner: camera.corner,
        protected: this.#protectedNow(),
      })
      this.#open = true
      this.#visible = true
      await this.#push()
      await this.#watch()
      await this.#store({ position: placement })
    } catch (error) {
      this.#status = 'error'
      this.#error = errorMessage(error)
      this.#greet = false
      this.#unwatch()
      await cameraClose().catch(() => {})
    }
  }

  async #closeWindow(): Promise<void> {
    this.#unwatch()
    await this.#flushSave()
    this.#greet = false
    this.#open = false
    this.#status = 'off'
    this.#error = null
    this.#visible = true
    await cameraClose().catch(warn('camera overlay could not be closed'))
    const unlisten = this.#unlistenState
    this.#unlistenState = null
    unlisten?.()
  }

  #onState(state: CameraState): void {
    this.#status = state.status
    this.#error = state.status === 'error' ? (state.message ?? 'The camera is unavailable.') : null
    // The first word from the overlay is proof it is listening; the settings sent while it
    // was still loading went nowhere.
    if (!this.#greet) return
    this.#greet = false
    void this.#push()
  }

  /** The overlay is dragged and resized by hand, so the window itself reports the result. */
  async #watch(): Promise<void> {
    try {
      const overlay = await Window.getByLabel('camera')
      if (!overlay) return
      this.#unlistenWindow.push(
        await overlay.onMoved(({ payload }) => {
          this.#movedTo = { x: payload.x, y: payload.y }
          this.#scheduleSave()
        }),
        await overlay.onResized(({ payload }) => {
          this.#resizedTo = payload.width
          this.#scheduleSave()
        }),
      )
    } catch (error) {
      warn('camera overlay position will not be remembered')(error)
    }
  }

  #unwatch(): void {
    for (const unlisten of this.#unlistenWindow.splice(0)) unlisten()
  }

  #cancelSave(): void {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    this.#movedTo = null
    this.#resizedTo = null
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null
      void this.#flushSave()
    }, SAVE_DELAY_MS)
  }

  async #flushSave(): Promise<void> {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    const position = this.#movedTo
    const physicalWidth = this.#resizedTo
    this.#movedTo = null
    this.#resizedTo = null
    if (!position && physicalWidth === null) return
    const scale = physicalWidth === null ? 1 : await this.#scale()
    const size = physicalWidth === null ? null : clampCameraSize(Math.round(physicalWidth / scale))
    await this.#store({
      ...(position ? { position } : {}),
      ...(size === null ? {} : { size }),
    })
    // A resize moves the frame's centre as surely as a drag does.
    await this.#publishPlacement()
  }

  async #scale(): Promise<number> {
    try {
      const overlay = await Window.getByLabel('camera')
      const factor = overlay ? await overlay.scaleFactor() : 1
      return factor > 0 ? factor : 1
    } catch {
      return 1
    }
  }

  async #store(update: { position?: CameraPlacement | null; size?: number }): Promise<void> {
    const camera = settings.value.recording.camera
    const position = update.position === undefined ? camera.position : update.position
    const size = update.size === undefined ? camera.size : clampCameraSize(update.size)
    if (samePlacement(position, camera.position) && size === camera.size) return
    await settings
      .update((draft) => {
        draft.recording.camera.position = position
        draft.recording.camera.size = size
      })
      .catch(warn('camera position not saved'))
  }
}

export const camera = new CameraOverlay()

export async function listCameras(): Promise<{ id: string; label: string }[]> {
  const videoInputs = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'videoinput',
    )

  let inputs = await videoInputs()
  if (inputs.some((device) => !device.label)) {
    // Labels stay empty until the page has been granted camera access once.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true })
      for (const track of probe.getTracks()) track.stop()
      inputs = await videoInputs()
    } catch (error) {
      warn('camera permission not granted')(error)
    }
  }

  // "default" is an alias; null already means the default camera.
  return inputs
    .filter((device) => device.deviceId && device.deviceId !== 'default')
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    }))
}

/** The stream the compositor draws into window recordings; null when the camera will not open. */
export async function openCameraStream(deviceId: string | null): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
  } catch (error) {
    if (deviceId) return openCameraStream(null)
    warn('camera unavailable')(error)
    return null
  }
}
