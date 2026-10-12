<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Icon } from '@butterfly-record/ui'
  import { getCurrentWindow, LogicalSize, type PhysicalSize } from '@tauri-apps/api/window'

  import {
    DEFAULT_CAMERA_EFFECTS,
    normalizeCameraEffects,
    type CameraEffects,
  } from '../lib/camera-effects.ts'
  import {
    aspectOf,
    CAMERA_SIZE_STEP,
    clampCameraSize,
    cornerRadius,
    cssRadius,
    MIN_CAMERA_SIZE,
    overlaySize,
    type CameraShape,
  } from '../lib/camera-layout.ts'
  import { emitCameraState, onCameraConfig, type CameraEffectState } from '../lib/ipc.ts'
  import { OverlayEffect } from './overlay-effect.ts'

  /** How long to wait for the first `camera-config` before falling back to the default camera. */
  const FIRST_CONFIG_WAIT = 250
  /** A camera held by another app can resolve getUserMedia yet never deliver a frame. */
  const FIRST_FRAME_WAIT = 4000
  const NO_FRAMES = new Error('The camera opened but delivered no frames.')
  /**
   * A shape hint a camera cannot meet can be honoured by cropping to almost nothing: asking a
   * 16:9-only device for a square picture has been seen to yield a two-pixel frame. Anything
   * this small is not a picture, so the next rung of the ladder is tried instead.
   */
  const SMALLEST_PICTURE = 32
  /** Share of the corner radius that keeps the grip inside the clipped shape. */
  const GRIP_ARC = 0.293

  let deviceId = $state<string | null>(null)
  let shape = $state<CameraShape>('circle')
  let mirror = $state(true)
  let effects = $state.raw<CameraEffects>(DEFAULT_CAMERA_EFFECTS)
  let recording = $state(false)
  let configured = $state(false)
  /** A real config arrived, as opposed to the wait running out. */
  let adopted = $state(false)

  let phase = $state<'starting' | 'live' | 'error'>('starting')
  let frameWidth = $state(240)
  let frameHeight = $state(240)
  let video: HTMLVideoElement | undefined = $state()
  let effectCanvas: HTMLCanvasElement | undefined = $state()
  /** The effect canvas has a frame and covers the video. */
  let effectShown = $state(false)
  let effectState: CameraEffectState = { status: 'off', message: null }
  let overlayEffect: OverlayEffect | null = null
  /** The last state sent, so a change in the effect alone can be sent again with it. */
  let reported: { status: 'starting' | 'live' | 'error'; message: string | null } = {
    status: 'starting',
    message: null,
  }

  let stream: MediaStream | null = null
  /** Bumped per open so a slow getUserMedia cannot attach a stream that is already stale. */
  let generation = 0
  /** Device id → label, so a camera that comes back with a new id can still be found. */
  const labels = new Map<string, string>()
  let resizing = false
  let pendingResize: PhysicalSize | null = null

  const radius = $derived(cssRadius(shape, frameWidth, frameHeight))
  // The grip belongs inside the clipped shape, and on a circle that is nowhere near the
  // window's bottom-right corner.
  const gripInset = $derived(
    Math.max(6, Math.round(cornerRadius(shape, frameWidth, frameHeight) * GRIP_ARC) - 4),
  )
  const compact = $derived(Math.min(frameWidth, frameHeight) < 150)

  onMount(() => {
    measure()
    // The first config normally lands within a frame; waiting for it avoids opening the
    // default camera only to swap to the configured one a moment later.
    const timer = setTimeout(() => (configured = true), FIRST_CONFIG_WAIT)
    const unlisten = onCameraConfig((config) => {
      clearTimeout(timer)
      deviceId = config.deviceId
      shape = config.shape
      mirror = config.mirror
      effects = normalizeCameraEffects(config.effects)
      recording = config.recording
      configured = true
      adopted = true
    })
    // Only now is "the overlay is alive" true enough to act on. Registering the listener is a
    // round trip of its own, and events are not buffered, so saying it any earlier loses the
    // settings the main window sends back.
    void unlisten.then(() => report('starting', null)).catch(warn)
    const resized = getCurrentWindow().onResized(({ payload }) => void keepAspect(payload))

    window.addEventListener('resize', measure)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('pagehide', stopStream)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', measure)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('pagehide', stopStream)
      void unlisten.then((stop) => stop()).catch(warn)
      void resized.then((stop) => stop()).catch(warn)
      overlayEffect?.close()
      stopStream()
    }
  })

  $effect(() => {
    if (!video || !effectCanvas) return
    overlayEffect ??= new OverlayEffect(video, effectCanvas, {
      showing: (on) => (effectShown = on),
      state: (state) => {
        if (state.status === effectState.status && state.message === effectState.message) return
        effectState = state
        report(reported.status, reported.message)
      },
    })
    overlayEffect.update(effects, mirror, phase === 'live')
  })

  // Only the device may restart the camera: a new shape, mirror or recording flag must not
  // interrupt the picture, so the shape only seeds the hints of the next open.
  $effect(() => {
    if (!configured) return
    const id = deviceId
    untrack(() => void openStream(id, shape))
  })

  // A new shape keeps the width and derives a new height, so the window has to follow or a
  // wide frame would sit in a square window until the next drag.
  $effect(() => {
    const frame = shape
    // Never on the default shape: the main window already sized the window for the real one,
    // and "correcting" it from a shape nobody chose would undo that.
    if (!adopted) return
    untrack(() => {
      if (window.innerWidth < MIN_CAMERA_SIZE) return
      const target = overlaySize(frame, window.innerWidth)
      if (near(target.width, window.innerWidth) && near(target.height, window.innerHeight)) return
      void getCurrentWindow().setSize(new LogicalSize(target.width, target.height)).catch(warn)
    })
  })

  function warn(error: unknown) {
    console.warn('[butterfly-record] camera overlay', error)
  }

  function measure() {
    frameWidth = window.innerWidth
    frameHeight = window.innerHeight
  }

  function report(status: 'starting' | 'live' | 'error', message: string | null) {
    reported = { status, message }
    emitCameraState({ status, message, effect: effectState }).catch(warn)
  }

  /** Hints only, never `exact`: no camera may be excluded by the frame it will be shown in. */
  function shapeHints(frame: CameraShape): MediaTrackConstraints {
    const aspect = aspectOf(frame)
    // Cover-fitting a 16:9 feed into a square or portrait frame crops heads at the sides.
    return {
      aspectRatio: aspect,
      width: { ideal: Math.min(1280, Math.round(720 * aspect)) },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    }
  }

  async function labelledDevice(id: string | null): Promise<string | null> {
    if (!id) return null
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId)
      const exact = cameras.find((device) => device.deviceId === id)
      if (exact) {
        if (exact.label) labels.set(id, exact.label)
        return null
      }
      // The id is gone: a camera that was unplugged and replugged comes back with a new one.
      const label = labels.get(id)
      return cameras.find((device) => device.label && device.label === label)?.deviceId ?? null
    } catch {
      return null
    }
  }

  interface Rung {
    why: string
    video: MediaTrackConstraints
  }

  async function ladder(id: string | null, frame: CameraShape): Promise<Rung[]> {
    const hints = shapeHints(frame)
    const rungs: Rung[] = []
    if (id) rungs.push({ why: 'exact device id', video: { ...hints, deviceId: { exact: id } } })

    const byLabel = await labelledDevice(id)
    if (byLabel) {
      rungs.push({ why: 'device matched by label', video: { ...hints, deviceId: { exact: byLabel } } })
    }
    if (id) rungs.push({ why: 'preferred device id', video: { ...hints, deviceId: { ideal: id } } })

    rungs.push({ why: 'any camera, preferred shape', video: hints })
    // Unconstrained last, so a final failure reflects permission or hardware, not constraints.
    rungs.push({ why: 'any camera, no constraints', video: {} })
    return rungs
  }

  async function openStream(id: string | null, frame: CameraShape) {
    const token = ++generation
    stopStream()
    phase = 'starting'
    report('starting', null)

    let lastError: unknown = null
    for (const rung of await ladder(id, frame)) {
      if (token !== generation) return
      try {
        const opened = await navigator.mediaDevices.getUserMedia({ video: rung.video, audio: false })
        if (token !== generation) {
          for (const track of opened.getTracks()) track.stop()
          return
        }

        stream = opened
        if (video) {
          video.srcObject = opened
          await video.play().catch(() => undefined)
        }

        const live = await firstFrame()
        if (token !== generation) return
        if (!live) {
          lastError = NO_FRAMES
          stopStream()
          continue
        }

        console.info(
          `[butterfly-record] camera live via ${rung.why}:`,
          opened.getVideoTracks()[0]?.label || '(unnamed device)',
        )
        if (id) {
          const label = opened.getVideoTracks()[0]?.label
          if (label) labels.set(id, label)
        }
        phase = 'live'
        report('live', null)
        return
      } catch (error) {
        lastError = error
        console.warn(`[butterfly-record] camera rung "${rung.why}" failed`, error)
      }
    }

    if (token !== generation) return
    phase = 'error'
    report('error', describe(lastError))
  }

  function firstFrame(): Promise<boolean> {
    const element = video
    if (!element) return Promise.resolve(false)
    const usable = () => element.videoWidth >= SMALLEST_PICTURE && element.videoHeight >= SMALLEST_PICTURE
    if (element.readyState >= 2 && usable()) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        element.removeEventListener('loadeddata', onLoaded)
        resolve(value)
      }
      const onLoaded = () => finish(usable())
      const timer = setTimeout(() => finish(false), FIRST_FRAME_WAIT)
      element.addEventListener('loadeddata', onLoaded)
    })
  }

  function describe(error: unknown): string {
    if (error === NO_FRAMES) return 'The camera is in use by another app.'
    // OverconstrainedError is not a DOMException, so read the name off anything that has one.
    const name =
      typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
        ? error.name
        : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was denied.'
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found.'
    if (name === 'NotReadableError' || name === 'AbortError')
      return 'The camera is in use by another app.'
    return 'The camera could not be started.'
  }

  function stopStream() {
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    if (video) video.srcObject = null
  }

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const self = getCurrentWindow()
    if (target?.closest('.resize')) {
      self.startResizeDragging('SouthEast').catch(warn)
      return
    }
    self.startDragging().catch(warn)
  }

  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey) return
    // Ctrl + wheel is page zoom in a webview; the overlay resizes instead.
    event.preventDefault()
    const step = event.deltaY < 0 ? CAMERA_SIZE_STEP : -CAMERA_SIZE_STEP
    const target = overlaySize(shape, clampCameraSize(window.innerWidth + step))
    void getCurrentWindow().setSize(new LogicalSize(target.width, target.height)).catch(warn)
  }

  /** Puts the window back on the shape's aspect ratio after the user has dragged it. */
  async function keepAspect(size: PhysicalSize) {
    pendingResize = size
    if (resizing) return
    resizing = true
    try {
      const self = getCurrentWindow()
      while (pendingResize) {
        const physical = pendingResize
        pendingResize = null
        const logical = physical.toLogical(await self.scaleFactor())
        const target = overlaySize(shape, logical.width)
        // The corrective size raises another resize event; it lands here and stops.
        if (near(target.width, logical.width) && near(target.height, logical.height)) continue
        await self.setSize(new LogicalSize(target.width, target.height))
      }
    } catch (error) {
      warn(error)
    } finally {
      resizing = false
    }
  }

  function near(a: number, b: number): boolean {
    return Math.abs(a - b) <= 1
  }
</script>

<div class="frame" class:recording style="--radius: {radius}; --grip: {gripInset}px">
  <!-- svelte-ignore a11y_media_has_caption -- a live camera preview has nothing to caption -->
  <video bind:this={video} class:mirrored={mirror} autoplay muted playsinline></video>
  <canvas bind:this={effectCanvas} class="effect" class:shown={effectShown} aria-hidden="true"></canvas>

  {#if phase === 'error'}
    <div class="placeholder">
      {#if !compact}<Icon name="camera-off" size={20} />{/if}
      <span>Camera unavailable</span>
    </div>
  {/if}

  <div class="outline" aria-hidden="true"></div>
  <div class="resize" title="Drag to resize"><Icon name="grip" size={14} /></div>
</div>

<style>
  :global(#camera) {
    width: 100%;
    height: 100%;
  }

  .frame {
    /* The overlay floats over the desktop rather than inside the app, so it carries its own
       neutral palette instead of the themed tokens. */
    --surface: #1f1f1f;
    --on-surface: #b4b4b4;
    --ring: rgba(255, 255, 255, 0.55);

    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: var(--radius);
    background: var(--surface);
    /* border-radius alone leaves the video layer with a stair-stepped edge; clip-path is
       anti-aliased, which a transparent window needs. */
    clip-path: inset(0 round var(--radius));
    color: var(--on-surface);
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  }

  video {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
  }

  video.mirrored {
    transform: scaleX(-1);
  }

  /* Drawn already cropped and mirrored, over the video it takes its frames from. */
  .effect {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    visibility: hidden;
  }

  .effect.shown {
    visibility: visible;
  }

  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    padding: 8px 12%;
    background: var(--surface);
    line-height: 1.35;
    text-align: center;
  }

  .outline {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--ring);
    opacity: 0;
    transition: opacity 120ms ease;
    pointer-events: none;
  }

  .resize {
    position: absolute;
    right: calc(var(--grip) - 2px);
    bottom: calc(var(--grip) - 2px);
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    color: rgba(255, 255, 255, 0.85);
    opacity: 0;
    transition: opacity 120ms ease;
    cursor: nwse-resize;
  }

  .frame:hover .outline,
  .frame:hover .resize {
    opacity: 1;
  }

  /* While recording the overlay is captured as it stands: no chrome at all. The resize zone
     stays where it is, just invisible. */
  .frame.recording .outline,
  .frame.recording .resize {
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .outline,
    .resize {
      transition: none;
    }
  }
</style>
