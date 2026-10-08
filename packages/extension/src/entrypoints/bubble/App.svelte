<script lang="ts">
  // Runs in an extension-origin iframe so one camera grant covers every site. Chrome salts
  // deviceIds per (origin, top-level site), so ids from the offscreen document may not resolve
  // here; the camera is opened through progressively looser constraints and matched by label.
  import { onDestroy, onMount } from 'svelte'
  import { Butterfly } from '@butterfly-record/ui'
  import { loadSettings, onSettingsChanged, type Settings } from '../../lib/settings.ts'

  type Feed = 'loading' | 'live' | 'denied' | 'missing' | 'blocked'

  interface BubbleStatus {
    source: 'butterfly-bubble'
    feed: Feed
    error: string | null
    detail: string | null
  }

  let video: HTMLVideoElement | null = $state(null)
  let stream: MediaStream | null = null
  let feed = $state<Feed>('loading')
  let mirrored = $state(false)
  let rounded = $state(false)
  let detail = $state<string | null>(null)
  let attempt = $state(0)

  const MESSAGES: Record<Exclude<Feed, 'loading' | 'live'>, string> = {
    denied: 'Camera blocked',
    missing: 'No camera found',
    blocked: 'This site blocks the camera',
  }

  // A camera held by another app can resolve getUserMedia yet never deliver a frame.
  const FIRST_FRAME_TIMEOUT_MS = 4000

  /** Shape hints only. Never `exact`, so no camera can be excluded by them. */
  function shapeFor(settings: Settings): MediaTrackConstraints {
    return settings.cameraShape === 'circle'
      ? // Square: cover-fitting 16:9 into a circle crops heads at the sides.
        { aspectRatio: 1, width: { ideal: 720 }, height: { ideal: 720 } }
      : { aspectRatio: 16 / 9, width: { ideal: 1280 }, height: { ideal: 720 } }
  }

  // Labels are empty until this origin holds a camera grant, so this is null on first run.
  async function deviceIdForLabel(label: string | null): Promise<string | null> {
    if (!label) return null
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const match = devices.find(
        (device) => device.kind === 'videoinput' && device.label === label && device.deviceId,
      )
      return match?.deviceId ?? null
    } catch {
      return null
    }
  }

  interface Rung {
    why: string
    video: MediaTrackConstraints
  }

  async function ladder(settings: Settings): Promise<Rung[]> {
    const shape = shapeFor(settings)
    const rungs: Rung[] = []

    if (settings.cameraId) {
      rungs.push({ why: 'exact device id', video: { ...shape, deviceId: { exact: settings.cameraId } } })
    }

    const byLabel = await deviceIdForLabel(settings.cameraLabel)
    if (byLabel && byLabel !== settings.cameraId) {
      rungs.push({ why: 'device matched by label', video: { ...shape, deviceId: { exact: byLabel } } })
    }

    if (settings.cameraId) {
      rungs.push({ why: 'preferred device id', video: { ...shape, deviceId: { ideal: settings.cameraId } } })
    }

    rungs.push({ why: 'any camera, preferred shape', video: shape })
    // Unconstrained last, so a final failure reflects permission or hardware, not constraints.
    rungs.push({ why: 'any camera, no constraints', video: {} })
    return rungs
  }

  async function open(settings: Settings) {
    stop()
    feed = 'loading'
    detail = null
    const run = ++attempt

    if (!navigator.mediaDevices?.getUserMedia) {
      feed = 'blocked'
      detail = 'This page does not expose mediaDevices to embedded frames.'
      report()
      return
    }

    let lastError: unknown = null

    for (const rung of await ladder(settings)) {
      // Superseded by a newer open().
      if (run !== attempt) return
      try {
        const opened = await navigator.mediaDevices.getUserMedia({ video: rung.video, audio: false })
        if (run !== attempt) {
          for (const track of opened.getTracks()) track.stop()
          return
        }

        stream = opened
        if (video) {
          video.srcObject = opened
          await video.play().catch(() => {})
        }

        const live = await firstFrame()
        if (run !== attempt) return

        if (!live) {
          lastError = new Error('The camera opened but delivered no frames.')
          stop()
          continue
        }

        console.info(
          `[butterfly-record] camera live via ${rung.why}:`,
          opened.getVideoTracks()[0]?.label || '(unnamed device)',
        )
        feed = 'live'
        detail = null
        report()
        return
      } catch (error) {
        lastError = error
        console.warn(`[butterfly-record] camera rung "${rung.why}" failed`, error)
      }
    }

    if (run !== attempt) return
    feed = classify(lastError)
    detail = describe(lastError)
    console.warn('[butterfly-record] camera unavailable', lastError)
    report()
  }

  function firstFrame(): Promise<boolean> {
    const element = video
    if (!element) return Promise.resolve(false)
    if (element.readyState >= 2 && element.videoWidth > 0) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        element.removeEventListener('loadeddata', onLoaded)
        resolve(value)
      }
      const onLoaded = () => finish(element.videoWidth > 0)
      const timer = setTimeout(() => finish(false), FIRST_FRAME_TIMEOUT_MS)
      element.addEventListener('loadeddata', onLoaded)
    })
  }

  function classify(error: unknown): Feed {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
    if (name === 'NotReadableError' || name === 'AbortError') return 'missing'
    // A Permissions Policy refusal by the embedding page is also a NotAllowedError.
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return cameraAllowedByPolicy() ? 'denied' : 'blocked'
    }
    return 'denied'
  }

  function describe(error: unknown): string {
    if (error instanceof DOMException) return `${error.name}: ${error.message}`
    if (error instanceof Error) return error.message
    return String(error)
  }

  // `document.featurePolicy` is Chrome-only and untyped; if absent, assume the camera is allowed.
  function cameraAllowedByPolicy(): boolean {
    const policy = (document as Document & { featurePolicy?: { allowsFeature(f: string): boolean } })
      .featurePolicy
    if (!policy?.allowsFeature) return true
    try {
      return policy.allowsFeature('camera')
    } catch {
      return true
    }
  }

  // The overlay is cross-origin and cannot observe this frame. Targeted at '*' because the
  // embedder can be any site; the message carries nothing sensitive.
  function report() {
    const status: BubbleStatus = {
      source: 'butterfly-bubble',
      feed,
      error: null,
      detail,
    }
    try {
      window.parent?.postMessage(status, '*')
    } catch {
      // Sandboxed embedder; the in-bubble label still shows.
    }
  }

  function stop() {
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    if (video) video.srcObject = null
  }

  let current: Settings | null = null

  onMount(() => {
    let unsubscribe = () => {}
    void loadSettings().then((settings) => {
      current = settings
      mirrored = settings.mirrorCamera
      rounded = settings.cameraShape === 'rounded'
      void open(settings)

      unsubscribe = onSettingsChanged((next) => {
        const previous = current
        current = next
        mirrored = next.mirrorCamera
        const nextRounded = next.cameraShape === 'rounded'
        // Only shape (aspect ratio) and device changes need a new stream.
        if (
          nextRounded !== rounded ||
          next.cameraId !== previous?.cameraId ||
          next.cameraLabel !== previous?.cameraLabel
        ) {
          rounded = nextRounded
          void open(next)
        }
      })
    })
    return () => unsubscribe()
  })

  onDestroy(stop)
</script>

<div class="bubble" class:mirrored class:rounded>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} autoplay muted playsinline></video>

  {#if feed !== 'live'}
    <div class="fallback" title={detail ?? ''}>
      {#if feed === 'loading'}
        <Butterfly size={34} state="busy" />
      {:else}
        <Butterfly size={30} state="idle" />
        <span>{MESSAGES[feed]}</span>
        <button onclick={() => current && open(current)}>Try again</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bubble {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    overflow: hidden;
    background: #1a1a1a;
  }

  .bubble.rounded {
    border-radius: 14px;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .bubble.mirrored video {
    transform: scaleX(-1);
  }

  .fallback {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px;
    color: #9a9a9a;
    font-family: var(--font-ui, system-ui, sans-serif);
    font-size: 11px;
    text-align: center;
    line-height: 1.35;
  }

  .fallback button {
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 999px;
    background: transparent;
    color: #ededed;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .fallback button:hover {
    background: rgba(255, 255, 255, 0.1);
  }
</style>
