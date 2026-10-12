<script lang="ts">
  import { onMount } from 'svelte'
  import { Icon, type IconName } from '@butterfly-record/ui'
  import { camera, listCameras } from '../lib/camera.svelte.ts'
  import {
    CAMERA_SIZE_STEP,
    MAX_CAMERA_SIZE,
    MIN_CAMERA_SIZE,
    type CameraShape,
  } from '../lib/camera-layout.ts'
  import { listMicrophones, recorder } from '../lib/recorder.svelte.ts'
  import { settings, type AppSettings } from '../lib/settings.svelte.ts'
  import { storageAccess } from '../lib/storage-access.svelte.ts'
  import Button from '../components/Button.svelte'
  import IconButton from '../components/IconButton.svelte'
  import LevelMeter from '../components/LevelMeter.svelte'
  import ProgressBar from '../components/ProgressBar.svelte'
  import Select from '../components/Select.svelte'
  import SettingRow from '../components/SettingRow.svelte'
  import StorageNotice from '../components/StorageNotice.svelte'
  import Switch from '../components/Switch.svelte'
  import { confirmDialog } from '../components/confirm.svelte.ts'
  import { formatBytes, formatClock } from '../components/format.ts'
  import { toasts } from '../components/toasts.svelte.ts'
  import CameraEffectSettings from './record/CameraEffectSettings.svelte'

  type Recording = AppSettings['recording']
  type Camera = Recording['camera']

  const uid = $props.id()
  const recording = $derived(settings.value.recording)
  const cam = $derived(recording.camera)
  const phase = $derived(recorder.phase)
  const live = $derived(phase === 'recording' || phase === 'paused')

  let microphones = $state<{ id: string; label: string }[]>([])
  let microphonesLoaded = $state(false)
  let cameras = $state<{ id: string; label: string }[]>([])
  let camerasLoaded = $state(false)
  let startButton: HTMLButtonElement | undefined = $state()

  const SOURCES: { value: Recording['scope']; label: string; description: string; icon: IconName }[] = [
    { value: 'screen', label: 'Screen', description: 'A whole display', icon: 'monitor' },
    { value: 'window', label: 'Window', description: 'One app window', icon: 'window' },
  ]

  const QUALITY = [
    { value: '720p' as const, label: '720p' },
    { value: '1080p' as const, label: '1080p' },
    { value: '1440p' as const, label: '1440p' },
    { value: '2160p' as const, label: '2160p (4K)' },
  ]

  const FRAME_RATES = [
    { value: 30 as const, label: '30 fps' },
    { value: 60 as const, label: '60 fps' },
  ]

  const FRAMES: { value: CameraShape; label: string; icon: IconName }[] = [
    { value: 'circle', label: 'Circle', icon: 'shape-circle' },
    { value: 'rounded', label: 'Rounded', icon: 'shape-rounded' },
    { value: 'wide', label: 'Wide', icon: 'shape-wide' },
    { value: 'tall', label: 'Tall', icon: 'shape-tall' },
  ]

  /** The saved device is gone; the recorder will use the system default instead. */
  const missingMic = $derived(
    microphonesLoaded &&
      recording.microphoneId !== null &&
      !microphones.some((mic) => mic.id === recording.microphoneId),
  )

  const microphoneOptions = $derived([
    { value: null, label: 'System default' },
    ...(missingMic ? [{ value: recording.microphoneId, label: 'Unavailable device (using system default)' }] : []),
    ...microphones.map((mic) => ({ value: mic.id, label: mic.label })),
  ])

  const missingCamera = $derived(
    camerasLoaded && cam.deviceId !== null && !cameras.some((device) => device.id === cam.deviceId),
  )

  const cameraOptions = $derived([
    { value: null, label: 'Default camera' },
    ...(missingCamera ? [{ value: cam.deviceId, label: 'Unavailable camera (using the default)' }] : []),
    ...cameras.map((device) => ({ value: device.id, label: device.label })),
  ])

  /** Quiet line under the switch: the overlay shows its own placeholder. */
  const cameraNotice = $derived(
    !cam.enabled
      ? null
      : camera.status === 'error'
        ? (camera.error ?? 'The camera is unavailable. The recording will have no camera.')
        : missingCamera
          ? 'That camera is no longer connected, so the default one is used.'
          : null,
  )

  const statusText = $derived(
    phase === 'starting'
      ? 'Choose what to share'
      : phase === 'countdown'
        ? `Starting in ${recorder.countdown ?? ''}`
        : phase === 'finalizing'
          ? 'Saving'
          : phase === 'paused'
            ? 'Paused'
            : phase === 'recording'
              ? 'Recording'
              : '',
  )

  async function change(patch: (draft: Recording) => void) {
    try {
      await settings.update((draft) => patch(draft.recording))
    } catch (error) {
      toasts.error(error)
    }
  }

  /** Camera settings reach the overlay window as well as the settings file. */
  async function changeCamera(patch: (draft: Camera) => void) {
    await change((draft) => patch(draft.camera))
    await camera.apply()
  }

  async function loadMicrophones() {
    try {
      microphones = await listMicrophones()
      microphonesLoaded = true
    } catch (error) {
      toasts.error(error)
    }
  }

  async function loadCameras() {
    try {
      cameras = await listCameras()
      camerasLoaded = true
    } catch (error) {
      toasts.error(error)
    }
  }

  async function toggleCamera(on: boolean) {
    await change((draft) => (draft.camera.enabled = on))
    if (on && cameras.length === 0) void loadCameras()
    await camera.preview(on)
  }

  async function setScope(scope: Recording['scope']) {
    await change((draft) => (draft.scope = scope))
    // Screen recordings capture the overlay where it sits; window recordings must not.
    await camera.apply()
  }

  onMount(() => {
    // Ahead of the click: Start must reach the picker without awaiting anything.
    void storageAccess.check()
    if (recording.microphoneEnabled) void loadMicrophones()
    if (recording.camera.enabled) void loadCameras()
    void camera.preview(true)
    // Arriving from the tray or Alt+Shift+R: one key press away from the picker.
    if (phase === 'idle') startButton?.focus()
    const refresh = () => {
      void loadMicrophones()
      if (recording.camera.enabled) void loadCameras()
    }
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', refresh)
      // A running recording keeps the overlay; otherwise the camera light goes out here.
      void camera.preview(false)
    }
  })

  function sourceKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = recording.scope === 'screen' ? 'window' : 'screen'
    void setScope(next)
    document.getElementById(`${uid}-source-${next}`)?.focus()
  }

  function step(event: KeyboardEvent): number {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return 1
    return 0
  }

  function frameKey(event: KeyboardEvent) {
    const move = step(event)
    if (move === 0) return
    event.preventDefault()
    const index = FRAMES.findIndex((frame) => frame.value === cam.shape)
    const next = FRAMES[(index + move + FRAMES.length) % FRAMES.length]
    if (!next) return
    void changeCamera((draft) => (draft.shape = next.value))
    document.getElementById(`${uid}-frame-${next.value}`)?.focus()
  }

  async function discard() {
    const confirmed = await confirmDialog.ask({
      title: 'Discard this recording?',
      message: 'Everything recorded so far is deleted.',
      confirmLabel: 'Discard',
      danger: true,
    })
    if (confirmed) await recorder.discard()
  }
</script>

<div class="page">
  <!-- Phase changes are announced from one persistent region; the timer and byte count stay quiet. -->
  <p class="sr-only" role="status">{statusText}</p>
  {#if phase === 'idle'}
    <div class="column">
      <h1>New recording</h1>

      <StorageNotice />

      {#if recorder.error}
        <div class="alert" role="alert">
          <Icon name="alert" size={16} />
          <p>{recorder.error}</p>
          <IconButton icon="close" size="sm" label="Dismiss" onclick={() => recorder.clearError()} />
        </div>
      {/if}

      <div class="sources" role="radiogroup" aria-label="What to record">
        {#each SOURCES as source (source.value)}
          {@const checked = recording.scope === source.value}
          <button
            type="button"
            id="{uid}-source-{source.value}"
            class="source"
            role="radio"
            aria-checked={checked}
            tabindex={checked ? 0 : -1}
            onclick={() => setScope(source.value)}
            onkeydown={sourceKey}
          >
            <span class="source-icon"><Icon name={source.icon} size={28} strokeWidth={1.4} /></span>
            <span class="source-label">{source.label}</span>
            <span class="source-description">{source.description}</span>
            {#if checked}<span class="source-check"><Icon name="check-circle" size={18} /></span>{/if}
          </button>
        {/each}
      </div>

      <div class="options">
        <SettingRow label="Microphone" labelId="{uid}-mic">
          {#if recording.microphoneEnabled}
            <Select
              size="md"
              label="Microphone device"
              value={recording.microphoneId}
              options={microphoneOptions}
              onchange={(id) => change((draft) => (draft.microphoneId = id))}
            />
          {/if}
          <Switch
            labelledby="{uid}-mic"
            checked={recording.microphoneEnabled}
            onchange={(on) => {
              void change((draft) => (draft.microphoneEnabled = on))
              if (on && microphones.length === 0) void loadMicrophones()
            }}
          />
          {#snippet below()}
            {#if recording.microphoneEnabled}
              <LevelMeter deviceId={missingMic ? null : recording.microphoneId} />
            {/if}
          {/snippet}
        </SettingRow>
        <SettingRow label="Camera" labelId="{uid}-camera">
          {#if cam.enabled}
            <Select
              size="md"
              label="Camera device"
              value={cam.deviceId}
              options={cameraOptions}
              onchange={(id) => changeCamera((draft) => (draft.deviceId = id))}
            />
          {/if}
          <Switch labelledby="{uid}-camera" checked={cam.enabled} onchange={toggleCamera} />
          {#snippet below()}
            {#if cameraNotice}
              <p class="camera-notice">{cameraNotice}</p>
            {/if}
          {/snippet}
        </SettingRow>
        {#if cam.enabled}
          <SettingRow label="Frame" stacked>
            <div class="frames" role="radiogroup" aria-label="Camera frame">
              {#each FRAMES as frame (frame.value)}
                {@const checked = cam.shape === frame.value}
                <button
                  type="button"
                  id="{uid}-frame-{frame.value}"
                  class="frame"
                  role="radio"
                  aria-checked={checked}
                  tabindex={checked ? 0 : -1}
                  onclick={() => changeCamera((draft) => (draft.shape = frame.value))}
                  onkeydown={frameKey}
                >
                  <Icon name={frame.icon} size={20} />
                  <span>{frame.label}</span>
                </button>
              {/each}
            </div>
          </SettingRow>
          <SettingRow label="Size" for="{uid}-size">
            <span class="scale">Small</span>
            <input
              id="{uid}-size"
              class="slider"
              type="range"
              min={MIN_CAMERA_SIZE}
              max={MAX_CAMERA_SIZE}
              step={CAMERA_SIZE_STEP}
              value={cam.size}
              onchange={(event) =>
                changeCamera((draft) => (draft.size = Number(event.currentTarget.value)))}
            />
            <span class="scale">Large</span>
          </SettingRow>
          <SettingRow label="Mirror" description="Shows your camera the way you see yourself." labelId="{uid}-mirror">
            <Switch
              labelledby="{uid}-mirror"
              checked={cam.mirror}
              onchange={(on) => changeCamera((draft) => (draft.mirror = on))}
            />
          </SettingRow>
          <CameraEffectSettings
            effects={cam.effects}
            overlay={camera.effect}
            onchange={(patch) => changeCamera((draft) => patch(draft.effects))}
          />
          <SettingRow
            label="Position"
            description="Drag the camera anywhere on your screen. Window recordings put it in the matching spot in the video."
          >
            <Button onclick={() => camera.resetPosition()}>Reset position</Button>
          </SettingRow>
        {/if}
        <SettingRow label="Quality" description="The most it records at. A smaller screen is never upscaled." for="{uid}-quality">
          <Select
            id="{uid}-quality"
            value={recording.quality}
            options={QUALITY}
            onchange={(quality) => change((draft) => (draft.quality = quality))}
          />
        </SettingRow>
        <SettingRow label="Frame rate" for="{uid}-fps">
          <Select
            id="{uid}-fps"
            value={recording.frameRate}
            options={FRAME_RATES}
            onchange={(rate) => change((draft) => (draft.frameRate = rate))}
          />
        </SettingRow>
        <SettingRow label="Countdown" description="Wait 3 seconds before recording starts." labelId="{uid}-countdown">
          <Switch
            labelledby="{uid}-countdown"
            checked={recording.countdown}
            onchange={(on) => change((draft) => (draft.countdown = on))}
          />
        </SettingRow>
        <SettingRow
          label="Hide window while recording"
          description="Minimizes Butterfly Record. The recording bar stays on top."
          labelId="{uid}-hide"
        >
          <Switch
            labelledby="{uid}-hide"
            checked={recording.hideWindow}
            onchange={(on) => change((draft) => (draft.hideWindow = on))}
          />
        </SettingRow>
      </div>

      <p class="note">
        <Icon name="info" size={14} />
        System audio: turn on “Share with system audio” in the picker (screen only).
      </p>

      <div class="start">
        <Button variant="primary" size="lg" bind:element={startButton} onclick={() => recorder.start()}>
          <span class="rec-dot" aria-hidden="true"></span>
          Start recording
        </Button>
        <span class="shortcut">or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> from anywhere to bring this up</span>
      </div>
    </div>
  {:else}
    <div class="live">
      {#if phase === 'starting'}
        <p class="status" aria-hidden="true">Choose what to share</p>
        <p class="hint">Pick a {recording.scope === 'screen' ? 'screen' : 'window'} in the dialog that opened.</p>
        <div class="controls">
          <Button onclick={() => recorder.discard()}>Cancel</Button>
        </div>
      {:else if phase === 'countdown'}
        <p class="status" aria-hidden="true">Starting in</p>
        <p class="timer" aria-hidden="true">{recorder.countdown ?? ''}</p>
        <div class="controls">
          <Button onclick={() => recorder.discard()}>Cancel</Button>
        </div>
      {:else if phase === 'finalizing'}
        <p class="status" aria-hidden="true">Saving…</p>
        <p class="timer" role="timer">{formatClock(recorder.elapsed)}</p>
        <div class="saving"><ProgressBar value={null} label="Saving the recording" /></div>
      {:else}
        <p class="status" aria-hidden="true">
          <span class="live-dot" class:paused={phase === 'paused'}></span>
          {phase === 'paused' ? 'Paused' : 'Recording'}
        </p>
        <p class="timer" role="timer">{formatClock(recorder.elapsed)}</p>
        <p class="hint">{formatBytes(recorder.bytes)} written</p>
        <div class="controls">
          {#if phase === 'paused'}
            <Button size="lg" icon="play" onclick={() => recorder.resume()}>Resume</Button>
          {:else}
            <Button size="lg" icon="pause" onclick={() => recorder.pause()}>Pause</Button>
          {/if}
          {#if recorder.hasMic}
            <Button size="lg" icon={recorder.micMuted ? 'mic-off' : 'mic'} aria-pressed={recorder.micMuted} onclick={() => recorder.toggleMute()}>
              {recorder.micMuted ? 'Unmute' : 'Mute'}
            </Button>
          {/if}
          <Button size="lg" variant="record" icon="stop" onclick={() => recorder.stop()}>Stop</Button>
          <IconButton icon="trash" size="lg" tone="danger" label="Discard recording" onclick={discard} />
        </div>
      {/if}
      {#if live && recorder.error}
        <p class="error" role="alert">{recorder.error}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 680px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-6) var(--space-7);
  }

  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: 32px;
  }

  .alert {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    border-radius: var(--radius-card);
    color: var(--danger);
  }

  .alert :global(svg) {
    margin-top: 6px;
  }

  .alert p {
    flex: 1;
    margin: 4px 0;
    color: var(--fg);
    line-height: 20px;
    user-select: text;
  }

  .sources {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .source {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast);
  }

  .source:hover {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 3%);
  }

  .source:active {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 6%);
  }

  .source[aria-checked='true'] {
    border-color: var(--accent);
  }

  .source:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  .source-icon {
    margin-bottom: var(--space-2);
    color: var(--fg-muted);
  }

  .source[aria-checked='true'] .source-icon {
    color: var(--fg);
  }

  .source-label {
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 22px;
  }

  .source-description {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .source-check {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    color: var(--fg);
  }

  .options {
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
  }

  .camera-notice {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .frames {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
  }

  .frame {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-1);
    border: none;
    border-left: 1px solid var(--hairline);
    background: var(--bg-elevated);
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-sm);
    line-height: 16px;
    cursor: pointer;
    transition: background-color var(--motion-fast);
  }

  .frame:first-child {
    border-left: none;
  }

  .frame:hover {
    background: var(--fill-hover);
  }

  .frame:active {
    background: var(--fill-active);
  }

  .frame[aria-checked='true'] {
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated));
    color: var(--fg);
    font-weight: 500;
  }

  /* The group is clipped to its rounded corners, which would cut a focus ring outside it. */
  .frame:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .scale {
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }

  .slider {
    width: 148px;
    height: 20px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .slider:focus-visible {
    outline: none;
    box-shadow: var(--focus);
    border-radius: var(--radius-pill);
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: -4px 0 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }

  .start {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-4);
  }

  .rec-dot {
    display: inline-block;
    margin-right: var(--space-2);
    vertical-align: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--record);
  }

  .shortcut {
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }

  .live {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 100%;
    padding: var(--space-8) var(--space-6);
    text-align: center;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-lg);
    font-weight: 500;
  }

  .live-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--record);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .live-dot.paused {
    background: var(--fg-muted);
    animation: none;
  }

  .timer {
    margin: 0;
    font-size: 64px;
    font-weight: 300;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 72px;
  }

  .hint {
    margin: 0;
    color: var(--fg-muted);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    margin-top: var(--space-6);
  }

  .saving {
    width: 240px;
    margin-top: var(--space-4);
  }

  .error {
    max-width: 480px;
    margin: var(--space-4) 0 0;
    color: var(--danger);
    user-select: text;
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (max-width: 760px) {
    .sources {
      grid-template-columns: 1fr;
    }
  }
</style>
