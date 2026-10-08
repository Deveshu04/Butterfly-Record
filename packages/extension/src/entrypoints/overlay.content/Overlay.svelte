<script lang="ts">
  import { onMount } from 'svelte'
  import { Butterfly, Icon, type IconName } from '@butterfly-record/ui'
  import Annotate from './Annotate.svelte'
  import type {
    BackgroundRequest,
    CropRect,
    DeviceChoice,
    DeviceList,
    RecordScope,
    RecordingPhase,
  } from '../../lib/messages.ts'
  import {
    CAMERA_MAX_SIZE,
    CAMERA_MIN_SIZE,
    DEFAULT_SETTINGS,
    QUALITY_CHOICES,
    ROUNDED_ASPECT,
    loadSettings,
    onSettingsChanged,
    saveSettings,
    type CountdownSeconds,
    type Settings,
  } from '../../lib/settings.ts'
  import {
    onFolderNameChanged,
    onFolderNeedsReconnectChanged,
    readFolderName,
    readFolderNeedsReconnect,
  } from '../../lib/save-destination.ts'

  interface State {
    phase: RecordingPhase
    elapsed: number
    countdownEndsAt: number | null
    micMuted: boolean
    error: string | null
  }

  const SCOPES: Array<{ value: RecordScope; label: string; icon: IconName; hint: string }> = [
    {
      value: 'screen',
      label: 'Full Screen',
      icon: 'monitor',
      hint: 'A whole display, including other apps',
    },
    { value: 'tab', label: 'Current Tab', icon: 'browser', hint: 'This tab only, with its audio' },
    { value: 'window', label: 'Window', icon: 'window', hint: 'One application window' },
  ]

  type View = 'main' | 'scope' | 'camera' | 'microphone' | 'settings'
  let view = $state<View>('main')

  const FPS_CHOICES: ReadonlyArray<30 | 60> = [30, 60]
  const COUNTDOWN_CHOICES: ReadonlyArray<CountdownSeconds> = [0, 3, 5, 10]

  let cameras = $state<DeviceChoice[]>([])
  let microphones = $state<DeviceChoice[]>([])
  let devicesLabelled = $state(false)
  let grantingAccess = $state(false)

  // Enumerated by the offscreen document: this content script runs at the host
  // page's origin, which holds no media grant and so sees no device labels.
  async function loadDevices() {
    try {
      const list = await ask<DeviceList>({ target: 'background', type: 'list-devices' })
      cameras = list.cameras
      microphones = list.microphones
      devicesLabelled = list.labelled
    } catch {
      // The worker may be restarting; the panel keeps its previous list.
    }
  }

  /** Opens the recorder tab, which prompts at the extension's own origin. */
  async function grantAccess() {
    grantingAccess = true
    try {
      await run({ target: 'background', type: 'request-permissions' })
      await loadDevices()
    } finally {
      grantingAccess = false
    }
  }


  const MARGIN = 24
  const BUBBLE_KEY = `butterfly:bubble:${location.origin}`

  let settings = $state<Settings>(DEFAULT_SETTINGS)
  /** The recordings folder's name; null means Downloads. */
  let folderName = $state<string | null>(null)
  /** Chrome dropped the folder's permission, so recordings go to Downloads until it is reconnected. */
  let folderNeedsReconnect = $state(false)
  const folderUnavailable = $derived(folderName !== null && folderNeedsReconnect)
  let phase = $state<RecordingPhase>('idle')
  let elapsed = $state(0)
  let countdownLeft = $state<number | null>(null)
  let micMuted = $state(false)
  let error = $state<string | null>(null)
  let busy = $state(false)

  let panelOpen = $state(true)
  let bubblePos = $state({ x: MARGIN, y: 400 })
  let bubbleHovered = $state(false)
  let drawing = $state(false)
  let showPalette = $state(false)

  // If the host page's Permissions Policy blocks the extension-origin bubble
  // iframe, the camera can instead be opened at the page's own origin. Opt-in,
  // since that prompts for permission on the host site.
  type BubbleFeed = 'loading' | 'live' | 'denied' | 'missing' | 'blocked'
  let bubbleFeed = $state<BubbleFeed>('loading')
  let bubbleDetail = $state<string | null>(null)
  let usePageCamera = $state(false)
  let pageCameraError = $state<string | null>(null)
  let pageCameraVideo: HTMLVideoElement | null = $state(null)
  let pageCameraStream: MediaStream | null = null

  const cameraNeedsHelp = $derived(
    settings.cameraEnabled && !usePageCamera && (bubbleFeed === 'blocked' || bubbleFeed === 'denied'),
  )

  async function openPageCamera() {
    pageCameraError = null
    try {
      const constraints: MediaTrackConstraints =
        settings.cameraShape === 'circle'
          ? { aspectRatio: 1, width: { ideal: 720 }, height: { ideal: 720 } }
          : { aspectRatio: 16 / 9, width: { ideal: 1280 }, height: { ideal: 720 } }

      const opened = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false })
      closePageCamera()
      pageCameraStream = opened
      usePageCamera = true
      // The <video> may not exist yet; the effect below binds it once mounted.
      if (pageCameraVideo) {
        pageCameraVideo.srcObject = opened
        await pageCameraVideo.play().catch(() => {})
      }
    } catch (cause) {
      pageCameraError =
        cause instanceof DOMException
          ? `${cause.name}: ${cause.message}`
          : String(cause)
    }
  }

  function closePageCamera() {
    for (const track of pageCameraStream?.getTracks() ?? []) track.stop()
    pageCameraStream = null
  }

  $effect(() => {
    if (usePageCamera && pageCameraVideo && pageCameraStream && !pageCameraVideo.srcObject) {
      pageCameraVideo.srcObject = pageCameraStream
      void pageCameraVideo.play().catch(() => {})
    }
  })

  const PEN_COLOURS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'] as const

  // `cameraSize` is the height for both shapes: rounded is 16:9, circle is square.
  const bubbleHeight = $derived(settings.cameraSize)
  const bubbleWidth = $derived(
    settings.cameraShape === 'rounded'
      ? Math.round(settings.cameraSize * ROUNDED_ASPECT)
      : settings.cameraSize,
  )

  const scopeLabel = $derived(SCOPES.find((s) => s.value === settings.scope)?.label ?? 'Screen')
  const cameraLabel = $derived(
    !settings.cameraEnabled
      ? 'No camera'
      : (cameras.find((d) => d.deviceId === settings.cameraId)?.label ?? 'Integrated Webcam'),
  )
  const micLabel = $derived(
    !settings.microphoneEnabled
      ? 'No microphone'
      : (microphones.find((d) => d.deviceId === settings.microphoneId)?.label ??
        'Default microphone'),
  )

  const recording = $derived(phase === 'recording' || phase === 'paused')
  const active = $derived(recording || phase === 'finalizing' || countdownLeft !== null)
  const showBubble = $derived(settings.cameraEnabled && (panelOpen || active))

  let micLevel = $state(0)
  /** Speech RMS peaks around 0.25; ×4 makes a normal voice fill the bar. */
  const displayLevel = $derived(Math.min(1, micLevel * 4))

  /** Whether a start-monitor has been sent and not yet matched by a stop. */
  let monitorOn = false

  // The offscreen document owns the mic; this effect only starts/stops it and polls the level.
  $effect(() => {
    // Re-runs on device change; a repeated start-monitor reacquires, avoiding a stop/start race.
    void settings.microphoneId
    const wanted = panelOpen && !active && settings.microphoneEnabled

    if (!wanted) {
      if (monitorOn) {
        monitorOn = false
        void ask({ target: 'background', type: 'stop-monitor' }).catch(() => {})
      }
      micLevel = 0
      return
    }

    monitorOn = true
    void ask({ target: 'background', type: 'start-monitor' }).catch(() => {})
    const timer = setInterval(async () => {
      try {
        const levels = await ask<Record<string, number>>({ target: 'background', type: 'levels' })
        micLevel = levels.mic ?? 0
      } catch {
        // The worker may be restarting; the next tick picks it up.
      }
    }, 125)

    return () => clearInterval(timer)
  })

  // With the HUD hidden, a brief toast is the only sign that recording started.
  let startToast = $state(false)
  $effect(() => {
    if (recording && !settings.showHud) {
      startToast = true
      const timer = setTimeout(() => (startToast = false), 4000)
      return () => clearTimeout(timer)
    }
    startToast = false
  })

  async function ask<T>(request: BackgroundRequest): Promise<T> {
    const reply = await chrome.runtime.sendMessage(request)
    if (!reply?.ok) throw new Error(reply?.error ?? 'The recorder did not respond.')
    return reply.value as T
  }

  async function poll() {
    try {
      const state = await ask<State>({ target: 'background', type: 'get-state' })
      phase = state.phase
      elapsed = state.elapsed
      micMuted = state.micMuted
      if (state.error) error = state.error
      countdownLeft =
        state.countdownEndsAt === null
          ? null
          : Math.max(0, Math.ceil((state.countdownEndsAt - Date.now()) / 1000))
      if (recording) panelOpen = false
    } catch {
      // The worker may be restarting; the next tick picks it up.
    }
  }

  async function run(request: BackgroundRequest) {
    busy = true
    error = null
    try {
      await ask(request)
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause)
      if (text !== 'cancelled') error = text
    } finally {
      busy = false
      await poll()
    }
  }

  const start = () =>
    run({
      target: 'background',
      type: 'start-recording',
      scope: settings.scope,
      crop: settings.scope === 'region' ? regionRect : null,
    })

  const openLibrary = () => run({ target: 'background', type: 'open-library' })

  /** Set by the region drag-select; null for every other scope. */
  let regionRect = $state<CropRect | null>(null)

  async function update(patch: Partial<Settings>) {
    settings = await saveSettings(patch)
  }

  async function turnCameraOff() {
    closePageCamera()
    usePageCamera = false
    bubbleFeed = 'loading'
    pageCameraError = null
    await update({ cameraEnabled: false })
  }

  function chooseCamera(device: DeviceChoice) {
    closePageCamera()
    usePageCamera = false
    bubbleFeed = 'loading'
    return update({ cameraEnabled: true, cameraId: device.deviceId, cameraLabel: device.label })
  }

  function clampToViewport(x: number, y: number, width: number, height: number) {
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    }
  }

  function dragBubble(event: PointerEvent) {
    const target = event.target as HTMLElement
    if (target.closest('button') || target.closest('.grip')) return

    const host = event.currentTarget as HTMLElement
    const box = host.getBoundingClientRect()
    const offsetX = event.clientX - box.left
    const offsetY = event.clientY - box.top

    host.setPointerCapture(event.pointerId)
    event.preventDefault()

    const onMove = (move: PointerEvent) => {
      // Applied via translate3d, not left/top, to avoid a host-page relayout per frame.
      bubblePos = clampToViewport(
        move.clientX - offsetX,
        move.clientY - offsetY,
        bubbleWidth,
        bubbleHeight,
      )
    }
    const onUp = () => {
      host.releasePointerCapture(event.pointerId)
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', onUp)
      void chrome.storage.local.set({ [BUBBLE_KEY]: bubblePos })
    }

    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerup', onUp)
  }

  /** Saved to settings only on release, to avoid a storage write per pointermove. */
  function resizeBubble(event: PointerEvent) {
    event.stopPropagation()
    event.preventDefault()

    const grip = event.currentTarget as HTMLElement
    grip.setPointerCapture(event.pointerId)

    const originX = bubblePos.x
    const originY = bubblePos.y
    let next = settings.cameraSize

    const onMove = (move: PointerEvent) => {
      const height =
        settings.cameraShape === 'rounded'
          ? move.clientY - originY
          : // A circle has one dimension; follow whichever axis was pulled further.
            Math.max(move.clientX - originX, move.clientY - originY)

      next = Math.round(Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, height)))
      settings = { ...settings, cameraSize: next }
    }

    const onUp = () => {
      grip.releasePointerCapture(event.pointerId)
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      void update({ cameraSize: next })
      bubblePos = clampToViewport(bubblePos.x, bubblePos.y, bubbleWidth, bubbleHeight)
    }

    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  onMount(() => {
    bubblePos = { x: MARGIN, y: window.innerHeight - DEFAULT_SETTINGS.cameraSize - MARGIN }

    void loadSettings().then((loaded) => {
      settings = loaded
    })
    void loadDevices()
    navigator.mediaDevices?.addEventListener('devicechange', loadDevices)
    const unsubscribe = onSettingsChanged((next) => (settings = next))
    void readFolderName().then((name) => (folderName = name))
    const stopFolderWatch = onFolderNameChanged((name) => (folderName = name))
    void readFolderNeedsReconnect().then((needed) => (folderNeedsReconnect = needed))
    const stopReconnectWatch = onFolderNeedsReconnectChanged(
      (needed) => (folderNeedsReconnect = needed),
    )
    // Permission can lapse with a browser restart; the answer arrives through the watch above.
    void ask({ target: 'background', type: 'check-folder' }).catch(() => {})

    void chrome.storage.local.get(BUBBLE_KEY).then((stored) => {
      const saved = stored[BUBBLE_KEY] as { x: number; y: number } | undefined
      if (saved) bubblePos = clampToViewport(saved.x, saved.y, bubbleWidth, bubbleHeight)
    })

    // Toolbar clicks reach an already-injected overlay here instead of injecting a second copy.
    const onMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      const request = message as { target?: string; type?: string } | null
      if (request?.target !== 'overlay') return false
      if (request.type === 'toggle-panel' && !active) panelOpen = !panelOpen
      if (request.type === 'toggle-draw') {
        drawing = !drawing
        showPalette = drawing
      }
      sendResponse({ ok: true })
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)

    // The bubble iframe is cross-origin, so it reports its feed state via postMessage.
    const onBubbleStatus = (event: MessageEvent) => {
      const data = event.data as { source?: string; feed?: BubbleFeed; detail?: string | null }
      if (data?.source !== 'butterfly-bubble' || !data.feed) return
      bubbleFeed = data.feed
      bubbleDetail = data.detail ?? null
    }
    window.addEventListener('message', onBubbleStatus)

    void poll()
    const timer = setInterval(poll, 250)

    const onResize = () =>
      (bubblePos = clampToViewport(bubblePos.x, bubblePos.y, bubbleWidth, bubbleHeight))
    window.addEventListener('resize', onResize)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (drawing) {
        drawing = false
        showPalette = false
      } else if (panelOpen && !active) {
        panelOpen = false
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      clearInterval(timer)
      unsubscribe()
      stopFolderWatch()
      stopReconnectWatch()
      chrome.runtime.onMessage.removeListener(onMessage)
      navigator.mediaDevices?.removeEventListener('devicechange', loadDevices)
      window.removeEventListener('message', onBubbleStatus)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
      closePageCamera()
      // The meter effect's cleanup only clears its interval; release the mic here.
      if (monitorOn) {
        monitorOn = false
        void ask({ target: 'background', type: 'stop-monitor' }).catch(() => {})
      }
    }
  })

  function clock(seconds: number): string {
    const total = Math.floor(seconds)
    const hh = Math.floor(total / 3600)
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
  }

  const bubbleUrl = chrome.runtime.getURL('/bubble.html')
</script>

{#if countdownLeft !== null && countdownLeft > 0}
  <div class="countdown" aria-live="assertive" aria-label="Recording starts in {countdownLeft}">
    <div class="countdown-disc">
      {#key countdownLeft}<span class="numeral">{countdownLeft}</span>{/key}
    </div>
  </div>
{/if}

{#if active || drawing}
  <Annotate
    {drawing}
    colour={settings.penColour}
    clickHighlight={settings.showClickHighlight}
    cursorSpotlight={settings.showCursorSpotlight}
  />
{/if}

{#if showBubble}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="bubble"
    class:rounded={settings.cameraShape === 'rounded'}
    style="width: {bubbleWidth}px; height: {bubbleHeight}px; transform: translate3d({bubblePos.x}px, {bubblePos.y}px, 0)"
    onpointerdown={dragBubble}
    onpointerenter={() => (bubbleHovered = true)}
    onpointerleave={() => (bubbleHovered = false)}
  >
    {#if usePageCamera}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={pageCameraVideo}
        class:mirrored={settings.mirrorCamera}
        autoplay
        muted
        playsinline
      ></video>
    {:else}
      <!-- Without allow="camera", getUserMedia in this cross-origin frame fails with NotAllowedError. -->
      <iframe src={bubbleUrl} title="Camera preview" allow="camera; microphone"></iframe>
    {/if}

    {#if cameraNeedsHelp}
      <div class="bubble-help" title={bubbleDetail ?? ''}>
        <p>
          {bubbleFeed === 'blocked'
            ? 'This site will not let Butterfly’s camera frame run.'
            : 'Chrome has not granted the camera to Butterfly yet.'}
        </p>
        <div class="bubble-help-actions">
          {#if bubbleFeed === 'denied'}
            <button onclick={grantAccess} disabled={grantingAccess}>
              {grantingAccess ? 'Waiting…' : 'Allow camera'}
            </button>
          {/if}
          <button onclick={openPageCamera}>Use this site’s camera</button>
        </div>
        {#if pageCameraError}<p class="bubble-help-error">{pageCameraError}</p>{/if}
      </div>
    {/if}

    {#if bubbleHovered && !recording}
      <div class="bubble-rail">
        <button
          onclick={() => update({ cameraShape: 'circle' })}
          class:on={settings.cameraShape === 'circle'}
          title="Circle frame"
          aria-label="Circle frame"
        >
          <span class="shape circle"></span>
        </button>
        <button
          onclick={() => update({ cameraShape: 'rounded' })}
          class:on={settings.cameraShape === 'rounded'}
          title="Rounded frame"
          aria-label="Rounded frame"
        >
          <span class="shape rect"></span>
        </button>
        <button
          onclick={turnCameraOff}
          aria-label="Turn the camera off"
          title="Turn the camera off"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="grip"
        onpointerdown={resizeBubble}
        title="Drag to resize"
      ></span>
    {/if}
  </div>
{/if}

{#if panelOpen && !active}
  <div class="panel">
    <header>
      {#if view === 'main'}
        <button
          class="icon"
          title="Open the library"
          onclick={() => run({ target: 'background', type: 'open-library' })}
        >
          <Butterfly size={18} state="idle" />
        </button>
        <span class="brand">Butterfly Record</span>
      {:else}
        <button class="icon" onclick={() => (view = 'main')} aria-label="Back">
          <Icon name="chevron-left" />
        </button>
        <span class="brand">
          {view === 'scope'
            ? 'What to record'
            : view === 'camera'
              ? 'Camera'
              : view === 'microphone'
                ? 'Microphone'
                : 'Settings'}
        </span>
      {/if}
      <button class="icon" onclick={() => (panelOpen = false)} aria-label="Close">
        <Icon name="close" size={16} />
      </button>
    </header>

    {#if view === 'main'}
      <div class="rows">
        <button class="row" onclick={() => (view = 'scope')}>
          <Icon name={SCOPES.find((s) => s.value === settings.scope)?.icon ?? 'monitor'} />
          <span class="row-label">{scopeLabel}</span>
          <Icon name="chevron-right" size={16} class="muted" />
        </button>

        <button class="row" onclick={() => (view = 'camera')}>
          <Icon name={settings.cameraEnabled ? 'camera' : 'camera-off'} />
          <span class="row-label">{cameraLabel}</span>
          <span class="badge" class:on={settings.cameraEnabled}>
            {settings.cameraEnabled ? 'On' : 'Off'}
          </span>
        </button>

        <button class="row" onclick={() => (view = 'microphone')}>
          <Icon name={settings.microphoneEnabled ? 'mic' : 'mic-off'} />
          <span class="stack">
            <span class="row-label">{micLabel}</span>
            {#if settings.microphoneEnabled}
              <span class="meter" aria-hidden="true">
                <span class="meter-fill" style="transform: scaleX({displayLevel})"></span>
              </span>
            {/if}
          </span>
          <span class="badge" class:on={settings.microphoneEnabled}>
            {settings.microphoneEnabled ? 'On' : 'Off'}
          </span>
        </button>

        <button class="row" onclick={() => (view = 'settings')}>
          <!-- The shared icon set has no gear; drawn inline to match it. -->
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3.2" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.65 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.65h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"
            />
          </svg>
          <span class="row-label">Settings</span>
          <Icon name="chevron-right" size={16} class="muted" />
        </button>
      </div>

      <button class="start" onclick={start} disabled={busy}>
        {busy ? 'Starting…' : 'Start Recording'}
      </button>
      {#if folderUnavailable}
        <p class="folder-warning">
          Recordings will go to Downloads until you reconnect “{folderName}” in the
          <button class="link" onclick={openLibrary}>library</button>.
        </p>
      {:else}
        <p class="limit">No time limit · nothing leaves this machine</p>
      {/if}
    {:else if view === 'scope'}
      <div class="rows">
        {#each SCOPES as scope (scope.value)}
          <button
            class="row tall"
            class:selected={settings.scope === scope.value}
            onclick={() => {
              void update({ scope: scope.value })
              view = 'main'
            }}
          >
            <Icon name={scope.icon} />
            <span class="stack">
              <span class="row-label">{scope.label}</span>
              <span class="row-hint">{scope.hint}</span>
            </span>
            {#if settings.scope === scope.value}<Icon name="check" size={16} class="tick" />{/if}
          </button>
        {/each}
      </div>
    {:else if view === 'camera'}
      <div class="rows">
        <button
          class="row"
          class:selected={!settings.cameraEnabled}
          onclick={turnCameraOff}
        >
          <Icon name="camera-off" />
          <span class="row-label">No camera</span>
          {#if !settings.cameraEnabled}<Icon name="check" size={16} class="tick" />{/if}
        </button>

        {#each cameras as device (device.deviceId)}
          <button
            class="row"
            class:selected={settings.cameraEnabled && settings.cameraId === device.deviceId}
            onclick={() => chooseCamera(device)}
          >
            <Icon name="camera" />
            <span class="row-label">{device.label}</span>
            {#if settings.cameraEnabled && settings.cameraId === device.deviceId}
              <Icon name="check" size={16} class="tick" />
            {/if}
          </button>
        {/each}

        {#if cameras.length === 0 || !devicesLabelled}
          <button class="row" onclick={grantAccess} disabled={grantingAccess}>
            <Icon name="camera" />
            <span class="row-label">
              {grantingAccess ? 'Waiting for permission…' : 'Allow camera access'}
            </span>
          </button>
          <p class="note">
            Chrome asks once, in a Butterfly Record tab. After that every camera
            you own is listed here by name.
          </p>
        {/if}

        {#if settings.cameraEnabled}
          <div class="shapes">
            <span class="shapes-label">Frame</span>
            <button
              class="shape-option"
              class:on={settings.cameraShape === 'circle'}
              onclick={() => update({ cameraShape: 'circle' })}
            >
              <span class="shape circle"></span>
              Circle
            </button>
            <button
              class="shape-option"
              class:on={settings.cameraShape === 'rounded'}
              onclick={() => update({ cameraShape: 'rounded' })}
            >
              <span class="shape rect"></span>
              Rounded
            </button>
          </div>

          <label class="toggle">
            <input
              type="checkbox"
              checked={settings.mirrorCamera}
              onchange={(event) => update({ mirrorCamera: event.currentTarget.checked })}
            />
            <span>Mirror my camera</span>
          </label>
          <p class="note">
            Drag the frame anywhere on the page, and pull its corner handle to
            resize it. Where you put it is where it records.
          </p>
        {/if}
      </div>
    {:else if view === 'settings'}
      <div class="rows">
        <div class="seg-row">
          <span class="seg-label">Quality</span>
          <div class="seg">
            {#each QUALITY_CHOICES as choice (choice.value)}
              <button
                class:on={settings.maxHeight === choice.value}
                onclick={() => update({ maxHeight: choice.value })}
              >
                {choice.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="seg-row">
          <span class="seg-label">Frame rate</span>
          <div class="seg">
            {#each FPS_CHOICES as fps (fps)}
              <button
                class:on={settings.frameRate === fps}
                onclick={() => update({ frameRate: fps })}
              >
                {fps} fps
              </button>
            {/each}
          </div>
        </div>

        <div class="seg-row">
          <span class="seg-label">Countdown</span>
          <div class="seg">
            {#each COUNTDOWN_CHOICES as seconds (seconds)}
              <button
                class:on={settings.countdownSeconds === seconds}
                onclick={() => update({ countdownSeconds: seconds })}
              >
                {seconds === 0 ? 'Off' : `${seconds}s`}
              </button>
            {/each}
          </div>
        </div>

        <label class="toggle">
          <input
            type="checkbox"
            checked={settings.showHud}
            onchange={(event) => update({ showHud: event.currentTarget.checked })}
          />
          <span>Show the toolbar while recording</span>
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            checked={settings.showClickHighlight}
            onchange={(event) => update({ showClickHighlight: event.currentTarget.checked })}
          />
          <span>Ripple where I click</span>
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            checked={settings.showCursorSpotlight}
            onchange={(event) => update({ showCursorSpotlight: event.currentTarget.checked })}
          />
          <span>Spotlight my cursor</span>
        </label>

        <p class="note">
          Quality and frame rate are ceilings — a recording never upscales past
          its source.
        </p>

        <div class="seg-row destination">
          <span class="seg-label">Save to</span>
          <span class="destination-name" title={folderName ?? 'Downloads/Butterfly Record'}>
            {folderName ?? 'Downloads'}
          </span>
        </div>
        <p class="note">
          {#if folderUnavailable}
            Chrome needs permission for this folder again; until then recordings go to
            Downloads. Reconnect it in the <button class="link" onclick={openLibrary}>library</button>.
          {:else}
            Change it in the <button class="link" onclick={openLibrary}>library</button>.
          {/if}
        </p>
      </div>
    {:else}
      <div class="rows">
        {#if settings.microphoneEnabled}
          <div class="meter-block">
            <span class="meter big" aria-hidden="true">
              <span class="meter-fill" style="transform: scaleX({displayLevel})"></span>
            </span>
            <p class="note">Say something — the bar moves with your voice.</p>
          </div>
        {/if}

        <button
          class="row"
          class:selected={!settings.microphoneEnabled}
          onclick={() => update({ microphoneEnabled: false })}
        >
          <Icon name="mic-off" />
          <span class="row-label">No microphone</span>
          {#if !settings.microphoneEnabled}<Icon name="check" size={16} class="tick" />{/if}
        </button>

        {#each microphones as device (device.deviceId)}
          <button
            class="row"
            class:selected={settings.microphoneEnabled && settings.microphoneId === device.deviceId}
            onclick={() => update({ microphoneEnabled: true, microphoneId: device.deviceId })}
          >
            <Icon name="mic" />
            <span class="row-label">{device.label}</span>
            {#if settings.microphoneEnabled && settings.microphoneId === device.deviceId}
              <Icon name="check" size={16} class="tick" />
            {/if}
          </button>
        {/each}

        {#if microphones.length === 0 || !devicesLabelled}
          <button class="row" onclick={grantAccess} disabled={grantingAccess}>
            <Icon name="mic" />
            <span class="row-label">
              {grantingAccess ? 'Waiting for permission…' : 'Allow microphone access'}
            </span>
          </button>
          <p class="note">
            Chrome asks once, in a Butterfly Record tab. After that every
            microphone you own is listed here by name.
          </p>
        {/if}

        {#if settings.scope === 'tab'}
          <label class="toggle">
            <input
              type="checkbox"
              checked={settings.tabAudioEnabled}
              onchange={(event) => update({ tabAudioEnabled: event.currentTarget.checked })}
            />
            <span>Also record this tab’s audio</span>
          </label>
        {/if}
      </div>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}
  </div>
{/if}

{#if startToast}
  <div class="start-toast" role="status">
    Recording — click the butterfly in the toolbar to stop
  </div>
{/if}

{#if active && settings.showHud}
  <div class="hud">
    <button
      class="stop"
      onclick={() => run({ target: 'background', type: 'stop-recording' })}
      title="Stop and save"
      aria-label="Stop recording"
    ></button>

    <span class="hud-time">
      {phase === 'finalizing' ? '···' : clock(elapsed)}
    </span>

    <button
      onclick={() =>
        run({
          target: 'background',
          type: phase === 'paused' ? 'resume-recording' : 'pause-recording',
        })}
      aria-label={phase === 'paused' ? 'Resume' : 'Pause'}
      title={phase === 'paused' ? 'Resume' : 'Pause'}
    >
      <Icon name={phase === 'paused' ? 'play' : 'pause'} size={19} />
    </button>

    <button
      onclick={() => run({ target: 'background', type: 'restart-recording' })}
      aria-label="Restart"
      title="Discard this take and start again"
    >
      <Icon name="restart" size={19} />
    </button>

    <div class="pen-slot">
      <button
        class:on={drawing}
        onclick={() => {
          drawing = !drawing
          showPalette = drawing
        }}
        aria-label={drawing ? 'Put the pen away' : 'Draw on the page'}
        title="Draw on the page — strokes fade on their own"
      >
        <Icon name="pen" size={19} />
      </button>

      {#if showPalette && drawing}
        <div class="palette">
          {#each PEN_COLOURS as swatch (swatch)}
            <button
              class="swatch"
              class:on={settings.penColour === swatch}
              style="--swatch: {swatch}"
              onclick={() => update({ penColour: swatch })}
              aria-label="Pen colour {swatch}"
            ></button>
          {/each}
        </div>
      {/if}
    </div>

    <button
      class:on={settings.showClickHighlight}
      onclick={() => update({ showClickHighlight: !settings.showClickHighlight })}
      aria-label="Highlight clicks"
      title="Ripple where you click"
    >
      <Icon name="cursor" size={19} />
    </button>

    <button
      class="danger"
      onclick={() => run({ target: 'background', type: 'cancel-recording' })}
      aria-label="Delete"
      title="Delete and stop"
    >
      <Icon name="trash" size={19} />
    </button>

    <button
      class:off={micMuted}
      onclick={() => run({ target: 'background', type: 'set-mic-muted', muted: !micMuted })}
      aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
      title={micMuted ? 'Unmute microphone' : 'Mute microphone'}
    >
      <Icon name={micMuted ? 'mic-off' : 'mic'} size={19} />
    </button>
  </div>
{/if}

<style>
  /* z-indexes sit near the 32-bit ceiling so host-page modals cannot cover the overlay. */

  .countdown {
    position: fixed;
    inset: 0;
    z-index: 2147482999;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(2px);
    pointer-events: none;
  }

  .countdown-disc {
    display: grid;
    place-items: center;
    width: 168px;
    height: 168px;
    border-radius: 50%;
    background: rgba(20, 20, 20, 0.72);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14);
  }

  .numeral {
    color: #fff;
    font: 700 84px/1 var(--font-ui, system-ui, sans-serif);
    font-variant-numeric: tabular-nums;
    /* Re-keyed each second, so the animation replays per digit. */
    animation: swell 1s cubic-bezier(0.2, 0, 0, 1) forwards;
  }

  @keyframes swell {
    from {
      transform: scale(0.72);
      opacity: 0;
    }
    35% {
      transform: scale(1);
      opacity: 1;
    }
    to {
      transform: scale(1.18);
      opacity: 0;
    }
  }

  .panel {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483002;
    width: 320px;
    padding: 12px;
    border-radius: 16px;
    background: #232323;
    color: #ededed;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    font-family: var(--font-ui, system-ui, sans-serif);
    font-size: 14px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px 12px;
  }

  .brand {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 13px 14px;
    border: 0;
    border-radius: 10px;
    background: #2e2e2e;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .row:hover {
    background: #3a3a3a;
  }

  .row.selected {
    background: #3a3a3a;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }

  .row :global(.tick),
  .row :global(.muted) {
    color: #9a9a9a;
  }

  .row-label {
    flex: 1;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.tall {
    align-items: flex-start;
    padding: 12px 14px;
  }

  .stack {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .row-hint {
    color: #9a9a9a;
    font-size: 12px;
    font-weight: 400;
  }

  .shapes {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 14px 0;
  }

  .shapes-label {
    flex: 1;
    color: #9a9a9a;
    font-size: 13px;
  }

  .shape-option {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 11px;
    border: 0;
    border-radius: 8px;
    background: #2e2e2e;
    color: #ededed;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .shape-option:hover {
    background: #3a3a3a;
  }

  .shape-option.on {
    background: #3a3a3a;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 14px;
    color: #ededed;
    font-size: 13px;
    cursor: pointer;
  }

  .toggle input {
    accent-color: #ededed;
  }

  .note {
    margin: 0;
    padding: 0 14px 4px;
    color: #9a9a9a;
    font-size: 12px;
    line-height: 1.45;
  }

  .meter {
    display: block;
    width: 100%;
    height: 3px;
    margin-top: 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    overflow: hidden;
  }

  .meter.big {
    height: 6px;
    margin: 0 0 8px;
  }

  .meter-fill {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    background: #5fc98f;
    transform: scaleX(0);
    transform-origin: left;
    /* Slightly longer than the 125ms poll, so the bar glides between reads. */
    transition: transform 140ms linear;
  }

  .meter-block {
    padding: 6px 14px 0;
  }

  .meter-block .note {
    padding: 0;
  }

  .seg-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 14px;
  }

  .seg-label {
    flex: 1;
    color: #9a9a9a;
    font-size: 13px;
  }

  .destination {
    margin-top: 6px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .destination-name {
    max-width: 190px;
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: #ededed;
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .link:hover {
    color: #ffffff;
  }

  .seg {
    display: flex;
    gap: 4px;
  }

  .seg button {
    padding: 6px 9px;
    border: 0;
    border-radius: 7px;
    background: #2e2e2e;
    color: #ededed;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .seg button:hover {
    background: #3a3a3a;
  }

  .seg button.on {
    background: #3a3a3a;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
    font-weight: 600;
  }

  .badge {
    padding: 3px 9px;
    border-radius: 6px;
    background: rgba(255, 115, 105, 0.16);
    color: #ff7369;
    font-size: 12px;
    font-weight: 600;
  }

  .badge.on {
    background: rgba(95, 201, 143, 0.16);
    color: #5fc98f;
  }

  .start {
    width: 100%;
    margin-top: 12px;
    padding: 14px;
    border: 0;
    border-radius: 10px;
    /* White label needs 4.5:1; the lighter record red falls short. */
    background: var(--record-strong, #d13438);
    color: #fff;
    font: inherit;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }

  .start:hover:not(:disabled) {
    background: #b92b2f;
  }

  .start:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .limit {
    margin: 10px 0 2px;
    color: #9a9a9a;
    font-size: 12px;
    text-align: center;
  }

  .folder-warning {
    margin: 10px 0 2px;
    color: #d9b64a;
    font-size: 12px;
    line-height: 1.45;
    text-align: center;
  }

  .error {
    margin: 8px 0 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255, 115, 105, 0.12);
    color: #ff7369;
    font-size: 12px;
    line-height: 1.45;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .icon:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .bubble {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147483001;
    border-radius: 50%;
    box-shadow:
      0 0 0 3px rgba(255, 255, 255, 0.9),
      0 10px 32px rgba(0, 0, 0, 0.4);
    cursor: grab;
    overflow: visible;
  }

  .bubble.rounded {
    border-radius: 16px;
  }

  .bubble:active {
    cursor: grabbing;
  }

  .bubble iframe,
  .bubble > video {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: inherit;
    /* Would otherwise swallow the pointer events the drag needs. */
    pointer-events: none;
  }

  .bubble > video {
    display: block;
    background: #1a1a1a;
    object-fit: cover;
  }

  .bubble > video.mirrored {
    transform: scaleX(-1);
  }

  .bubble-help {
    position: absolute;
    top: calc(100% + 12px);
    left: 50%;
    width: 232px;
    padding: 10px 12px;
    border-radius: 10px;
    background: #232323;
    color: #ededed;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    font-family: var(--font-ui, system-ui, sans-serif);
    font-size: 12px;
    line-height: 1.45;
    transform: translateX(-50%);
  }

  .bubble-help p {
    margin: 0;
    color: #c9c9c9;
  }

  .bubble-help-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .bubble-help-actions button {
    padding: 5px 10px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 999px;
    background: transparent;
    color: #ededed;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .bubble-help-actions button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
  }

  .bubble-help-error {
    margin-top: 6px;
    color: #ff7369;
  }

  .grip {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #232323;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9);
    cursor: nwse-resize;
  }

  .grip::after {
    content: '';
    position: absolute;
    inset: 5px;
    border-right: 2px solid #ededed;
    border-bottom: 2px solid #ededed;
    border-bottom-right-radius: 2px;
  }

  .bubble:not(.rounded) .grip {
    /* Inset to where the circle meets its bounding box's diagonal. */
    right: 6%;
    bottom: 6%;
  }

  .shape {
    display: block;
    width: 13px;
    height: 13px;
    border: 1.6px solid currentColor;
  }

  .shape.circle {
    border-radius: 50%;
  }

  .shape.rect {
    width: 16px;
    height: 11px;
    border-radius: 3px;
  }

  .bubble-rail {
    position: absolute;
    bottom: -40px;
    left: 50%;
    display: flex;
    gap: 3px;
    padding: 4px;
    border-radius: 999px;
    background: #232323;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    transform: translateX(-50%);
  }

  .bubble-rail button {
    min-width: 26px;
    height: 26px;
    padding: 0 6px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: #ededed;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .bubble-rail button:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  .bubble-rail button.on {
    background: rgba(255, 255, 255, 0.18);
    font-weight: 700;
  }

  .hud {
    position: fixed;
    top: 50%;
    left: 20px;
    z-index: 2147483000;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 8px;
    border-radius: 16px;
    background: #232323;
    color: #ededed;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
    font-family: var(--font-ui, system-ui, sans-serif);
    transform: translateY(-50%);
  }

  .hud button {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 15px;
    cursor: pointer;
  }

  .hud button:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .hud button.off {
    opacity: 0.5;
  }

  .hud button.on {
    background: rgba(255, 255, 255, 0.18);
  }

  .pen-slot {
    position: relative;
  }

  /* Beside the HUD rather than below, so it never covers the stop button. */
  .palette {
    position: absolute;
    top: 50%;
    left: calc(100% + 8px);
    display: flex;
    gap: 5px;
    padding: 6px;
    border-radius: 999px;
    background: #232323;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    transform: translateY(-50%);
  }

  .swatch {
    width: 20px !important;
    height: 20px !important;
    border-radius: 50% !important;
    background: var(--swatch) !important;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
  }

  .swatch.on {
    box-shadow:
      0 0 0 2px #232323,
      0 0 0 4px var(--swatch);
  }

  .hud button.danger:hover {
    background: rgba(255, 115, 105, 0.18);
  }

  .hud .stop {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    background: #ededed;
  }

  .hud .stop:hover {
    background: #fff;
  }

  .hud-time {
    padding: 2px 0 6px;
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  @media (prefers-reduced-motion: reduce) {
    .numeral {
      animation: none;
    }
  }
</style>
