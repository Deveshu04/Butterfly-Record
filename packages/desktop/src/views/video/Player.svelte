<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Icon, type IconName } from '@butterfly-record/ui'
  import Button from '../../components/Button.svelte'
  import Dialog from '../../components/Dialog.svelte'
  import { formatClock } from '../../components/format.ts'
  import { PLAYER_SHORTCUTS, SEEK_STEP, playerKeydown } from '../../components/player-shortcuts.ts'
  import { mainWindow } from '../../components/window-state.svelte.ts'
  import PlayerMenu from './PlayerMenu.svelte'

  let {
    src,
    poster,
    captionsUrl,
    captionsLanguage,
    captionOptions,
    captions,
    oncaptions,
    ontogglecaptions,
    currentTime = $bindable(0),
    video = $bindable(),
    aspect,
    overlay,
  }: {
    src: string | null
    poster: string | null
    captionsUrl: string | null
    captionsLanguage: string
    /** Includes the "off" entry (value null). */
    captionOptions: { value: string | null; label: string }[]
    captions: string | null
    oncaptions: (value: string | null) => void
    /** The C shortcut. */
    ontogglecaptions: () => void
    currentTime?: number
    video?: HTMLVideoElement | undefined
    /** width / height of the source, for the letterbox. */
    aspect: number
    /** Replaces the video, e.g. for recordings that cannot play. */
    overlay?: Snippet | undefined
  } = $props()

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => ({
    value,
    label: value === 1 ? 'Normal' : `${value}×`,
  }))
  const HIDE_AFTER_MS = 2500
  const VOLUME_KEY = 'player.volume'
  const MUTED_KEY = 'player.muted'

  let screen: HTMLDivElement | undefined = $state()
  let bar: HTMLDivElement | undefined = $state()
  let captionsButton: HTMLButtonElement | undefined = $state()
  let speedButton: HTMLButtonElement | undefined = $state()

  let failed = $state(false)
  let paused = $state(true)
  let ended = $state(false)
  let duration = $state(Number.NaN)
  let buffered = $state<{ start: number; end: number }[]>([])
  let volume = $state(readNumber(VOLUME_KEY, 1))
  let muted = $state(readNumber(MUTED_KEY, 0) === 1)
  let rate = $state(1)
  let fullscreen = $state(false)
  let active = $state(true)
  let menu = $state<'captions' | 'speed' | null>(null)
  let shortcutsOpen = $state(false)
  let scrubTime = $state<number | null>(null)
  let hoverTime = $state<number | null>(null)
  let cueText = $state('')
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const playable = $derived(!overlay && Boolean(src) && !failed)
  const canSeek = $derived(Number.isFinite(duration) && duration > 0)
  const shownTime = $derived(scrubTime ?? currentTime)
  const played = $derived(canSeek ? Math.min(1, shownTime / duration) : 0)
  const bufferedEnd = $derived.by(() => {
    if (!canSeek) return 0
    const range = buffered.find((r) => r.start <= currentTime + 0.5 && r.end >= currentTime)
    return Math.min(1, (range?.end ?? 0) / duration)
  })
  const silent = $derived(muted || volume === 0)
  const volumeIcon = $derived<IconName>(silent ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume')
  const speedLabel = $derived(rate === 1 ? '1×' : `${rate}×`)
  const hidden = $derived(fullscreen && !paused && !active && menu === null && !shortcutsOpen && scrubTime === null)

  function readNumber(key: string, fallback: number): number {
    try {
      const value = Number(localStorage.getItem(key) ?? Number.NaN)
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
    } catch {
      return fallback
    }
  }

  function remember(key: string, value: number) {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      // Only a convenience: the next video starts at full volume.
    }
  }

  $effect(() => {
    void src
    failed = false
  })

  $effect(() => {
    remember(VOLUME_KEY, volume)
    remember(MUTED_KEY, muted ? 1 : 0)
  })

  // Closing the window to the tray keeps the page running; the sound must not.
  $effect(() => {
    if (!mainWindow.shown) video?.pause()
  })

  $effect(() => {
    if (paused) return
    return mainWindow.watch()
  })

  // Captions are drawn here rather than by the browser so they clear the control bar.
  // Svelte re-creates <track> when the URL changes; its mode has to be re-applied each time.
  $effect(() => {
    const element = video
    const on = captions !== null
    void captionsUrl
    if (!element) return
    let track: TextTrack | null = null
    const update = () => {
      const cues = on && track?.activeCues ? [...track.activeCues] : []
      cueText = cues
        .map((cue) => (cue instanceof VTTCue ? (cue.getCueAsHTML().textContent ?? '') : ''))
        .filter(Boolean)
        .join('\n')
    }
    const apply = () => {
      track?.removeEventListener('cuechange', update)
      track = null
      for (const candidate of element.textTracks) {
        candidate.mode = on ? 'hidden' : 'disabled'
        track = candidate
      }
      track?.addEventListener('cuechange', update)
      update()
    }
    apply()
    element.textTracks.addEventListener('addtrack', apply)
    element.textTracks.addEventListener('removetrack', apply)
    return () => {
      element.textTracks.removeEventListener('addtrack', apply)
      element.textTracks.removeEventListener('removetrack', apply)
      track?.removeEventListener('cuechange', update)
      cueText = ''
    }
  })

  $effect(() => () => clearTimeout(hideTimer))

  /** Shows the controls again; in full screen they fade after a pause in activity. */
  function poke() {
    active = true
    clearTimeout(hideTimer)
    if (!fullscreen) return
    hideTimer = setTimeout(() => {
      if (bar?.querySelector(':focus-visible')) poke()
      else active = false
    }, HIDE_AFTER_MS)
  }

  function togglePlay() {
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  function toggleFullscreen() {
    if (!screen) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void screen.requestFullscreen().catch(() => {})
  }

  function toggleMute() {
    if (!silent) {
      muted = true
      return
    }
    muted = false
    if (volume === 0) volume = 0.5
  }

  function seekTo(seconds: number) {
    if (!video || !canSeek) return
    video.currentTime = Math.max(0, Math.min(duration, seconds))
  }

  function setVolume(next: number) {
    volume = Math.round(Math.max(0, Math.min(1, next)) * 100) / 100
    muted = volume === 0
  }

  function setRate(next: number) {
    rate = next
    // Survives switching to a dubbed copy, which reloads the element.
    if (video) video.defaultPlaybackRate = next
  }

  /** Position along a slider's rail, 0..1. */
  function fraction(event: PointerEvent, slider: HTMLElement): number {
    const rail = slider.querySelector('.rail') ?? slider
    const rect = rail.getBoundingClientRect()
    return rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0
  }

  function scrubDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (event.button !== 0 || !canSeek) return
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubTime = fraction(event, event.currentTarget) * duration
    seekTo(scrubTime)
  }

  function scrubMove(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (!canSeek) return
    const time = fraction(event, event.currentTarget) * duration
    hoverTime = time
    if (scrubTime === null) return
    scrubTime = time
    seekTo(time)
  }

  function scrubUp() {
    scrubTime = null
  }

  function scrubKey(event: KeyboardEvent) {
    if (!canSeek) return
    const page = Math.max(SEEK_STEP, duration / 10)
    const steps: Record<string, number> = {
      ArrowLeft: currentTime - SEEK_STEP,
      ArrowDown: currentTime - SEEK_STEP,
      ArrowRight: currentTime + SEEK_STEP,
      ArrowUp: currentTime + SEEK_STEP,
      PageDown: currentTime - page,
      PageUp: currentTime + page,
      Home: 0,
      End: duration,
    }
    const target = steps[event.key]
    if (target === undefined) return
    event.preventDefault()
    seekTo(target)
  }

  function volumeDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setVolume(fraction(event, event.currentTarget))
  }

  function volumeMove(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) setVolume(fraction(event, event.currentTarget))
  }

  function volumeKey(event: KeyboardEvent) {
    const level = silent ? 0 : volume
    const steps: Record<string, number> = {
      ArrowLeft: level - 0.05,
      ArrowDown: level - 0.05,
      ArrowRight: level + 0.05,
      ArrowUp: level + 0.05,
      PageDown: level - 0.2,
      PageUp: level + 0.2,
      Home: 0,
      End: 1,
    }
    const target = steps[event.key]
    if (target === undefined) return
    event.preventDefault()
    setVolume(target)
  }

  function closeMenu(refocus: boolean) {
    const button = menu === 'captions' ? captionsButton : speedButton
    menu = null
    if (refocus) button?.focus()
    poke()
  }

  const shortcuts = playerKeydown({
    video: () => video,
    toggleCaptions: () => ontogglecaptions(),
    toggleFullscreen,
  })

  function keydown(event: KeyboardEvent) {
    if (fullscreen) poke()
    shortcuts(event)
  }
</script>

<svelte:window onkeydown={keydown} />
<svelte:document
  onfullscreenchange={() => {
    fullscreen = document.fullscreenElement !== null && document.fullscreenElement === screen
    poke()
  }}
/>

<div
  bind:this={screen}
  role="group"
  aria-label="Video player"
  class="screen"
  class:blank={overlay}
  class:fullscreen
  class:idle={hidden}
  onpointermove={poke}
  onpointerdown={poke}
>
  <div class="frame" style:aspect-ratio={fullscreen ? undefined : aspect}>
    {#if overlay}
      {@render overlay()}
    {:else if playable}
      <!-- Pointer shortcuts for the picture; the bar below has keyboard equivalents for both. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_media_has_caption -->
      <video
        bind:this={video}
        bind:currentTime
        bind:paused
        bind:ended
        bind:duration
        bind:buffered
        bind:volume
        bind:muted
        bind:playbackRate={rate}
        {src}
        poster={poster ?? undefined}
        preload="metadata"
        onclick={togglePlay}
        ondblclick={toggleFullscreen}
        onerror={() => (failed = true)}
      >
        {#if captionsUrl}
          {#key captionsUrl}
            <track kind="subtitles" src={captionsUrl} srclang={captionsLanguage} />
          {/key}
        {/if}
      </video>
      {#if cueText}
        <p class="cue" lang={captionsLanguage || undefined}><span>{cueText}</span></p>
      {/if}
    {:else}
      <div class="message">
        <p>{failed ? 'This video can’t be played here.' : 'There is no video file to play.'}</p>
        {#if failed}
          <p class="hint">It may use a format the built-in player doesn’t support. Use Open in the Details tab to play it in another app.</p>
        {/if}
      </div>
    {/if}
  </div>

  {#if playable}
    <div bind:this={bar} class="bar" role="group" aria-label="Player controls">
      <div
        class="scrubber"
        class:disabled={!canSeek}
        class:dragging={scrubTime !== null}
        role="slider"
        tabindex={canSeek ? 0 : -1}
        aria-label="Seek"
        aria-disabled={!canSeek}
        aria-valuemin={0}
        aria-valuemax={canSeek ? Math.floor(duration) : 0}
        aria-valuenow={Math.floor(shownTime)}
        aria-valuetext={canSeek ? `${formatClock(shownTime)} of ${formatClock(duration)}` : 'Not available'}
        onpointerdown={scrubDown}
        onpointermove={scrubMove}
        onpointerup={scrubUp}
        onpointercancel={scrubUp}
        onpointerleave={() => (hoverTime = null)}
        onkeydown={scrubKey}
      >
        <span class="rail">
          <span class="track">
            <span class="fill buffered" style:width="{bufferedEnd * 100}%"></span>
            <span class="fill played" style:width="{played * 100}%"></span>
          </span>
          <span class="thumb" style:left="{played * 100}%"></span>
          {#if hoverTime !== null && canSeek}
            <span class="tip" style:left="clamp(24px, {(hoverTime / duration) * 100}%, calc(100% - 24px))">
              {formatClock(hoverTime)}
            </span>
          {/if}
        </span>
      </div>

      <div class="row">
        <button
          type="button"
          class="control"
          aria-label={paused ? (ended ? 'Replay' : 'Play') : 'Pause'}
          title={paused ? (ended ? 'Replay (K)' : 'Play (K)') : 'Pause (K)'}
          onclick={togglePlay}
        >
          <Icon name={paused ? (ended ? 'restart' : 'play') : 'pause'} size={18} />
        </button>

        <div class="volume">
          <button
            type="button"
            class="control"
            aria-label={silent ? 'Unmute' : 'Mute'}
            title={silent ? 'Unmute (M)' : 'Mute (M)'}
            onclick={toggleMute}
          >
            <Icon name={volumeIcon} size={18} />
          </button>
          <div
            class="level"
            role="slider"
            tabindex="0"
            aria-label="Volume"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={silent ? 0 : Math.round(volume * 100)}
            aria-valuetext={silent ? 'Muted' : `${Math.round(volume * 100)}%`}
            onpointerdown={volumeDown}
            onpointermove={volumeMove}
            onkeydown={volumeKey}
          >
            <span class="rail">
              <span class="track"><span class="fill played" style:width="{silent ? 0 : volume * 100}%"></span></span>
              <span class="thumb" style:left="{silent ? 0 : volume * 100}%"></span>
            </span>
          </div>
        </div>

        <span class="time">
          {formatClock(shownTime)}<span class="sep" aria-hidden="true">/</span>{canSeek ? formatClock(duration) : '--:--'}
        </span>

        <span class="spacer"></span>

        {#if captionOptions.length > 1}
          <div class="anchor">
            <button
              bind:this={captionsButton}
              type="button"
              class="control"
              class:on={captions !== null}
              aria-label={captions !== null ? 'Captions, on' : 'Captions, off'}
              title="Captions (C)"
              aria-haspopup="menu"
              aria-expanded={menu === 'captions'}
              onclick={() => (menu = menu === 'captions' ? null : 'captions')}
            >
              <Icon name="captions" size={18} />
            </button>
            {#if menu === 'captions'}
              <PlayerMenu
                label="Captions"
                options={captionOptions}
                selected={captions}
                onselect={oncaptions}
                onclose={closeMenu}
              />
            {/if}
          </div>
        {/if}

        <div class="anchor">
          <button
            bind:this={speedButton}
            type="button"
            class="control speed"
            aria-label="Playback speed, {speedLabel}"
            title="Playback speed"
            aria-haspopup="menu"
            aria-expanded={menu === 'speed'}
            onclick={() => (menu = menu === 'speed' ? null : 'speed')}
          >
            {speedLabel}
          </button>
          {#if menu === 'speed'}
            <PlayerMenu label="Playback speed" options={SPEEDS} selected={rate} onselect={setRate} onclose={closeMenu} />
          {/if}
        </div>

        <button
          type="button"
          class="control"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          aria-haspopup="dialog"
          onclick={() => (shortcutsOpen = true)}
        >
          <Icon name="keyboard" size={18} />
        </button>

        <button
          type="button"
          class="control"
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          title={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
          onclick={toggleFullscreen}
        >
          <Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={18} />
        </button>
      </div>
    </div>
  {/if}
</div>

<Dialog bind:open={shortcutsOpen} title="Keyboard shortcuts">
  <dl class="shortcuts">
    {#each PLAYER_SHORTCUTS as shortcut (shortcut.action + shortcut.keys.join())}
      <dt>
        {#each shortcut.keys as key, index (key)}
          {#if index > 0}<span class="or">or</span>{/if}<kbd>{key}</kbd>
        {/each}
      </dt>
      <dd>{shortcut.action}</dd>
    {/each}
  </dl>
  {#snippet footer()}
    <Button variant="primary" onclick={() => (shortcutsOpen = false)}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .screen {
    --bar-height: 52px;
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: 100%;
    min-height: 0;
    border-radius: var(--radius-card);
    background: #000;
    color: var(--chrome-fg);
    container-type: inline-size;
  }

  .frame {
    position: relative;
    display: grid;
    flex: 0 1 auto;
    width: 100%;
    min-height: 120px;
    overflow: hidden;
    place-items: center;
    border-radius: var(--radius-card) var(--radius-card) 0 0;
  }

  .blank .frame,
  .frame:last-child {
    border-radius: var(--radius-card);
  }

  .blank {
    border: 1px solid var(--hairline);
    background: var(--bg-sunken);
    color: var(--fg);
  }

  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .cue {
    position: absolute;
    right: 0;
    bottom: 5%;
    left: 0;
    margin: 0;
    padding: 0 8%;
    font-family: var(--font-ui);
    font-size: clamp(13px, 2.6cqw, 34px);
    line-height: 1.35;
    text-align: center;
    white-space: pre-line;
    pointer-events: none;
  }

  .cue span {
    padding: 0.1em 0.4em;
    border-radius: var(--radius-sm);
    background: rgba(0, 0, 0, 0.78);
    color: #fff;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  .message {
    max-width: 360px;
    padding: var(--space-6);
    color: var(--chrome-fg);
    text-align: center;
  }

  .message p {
    margin: 0;
  }

  .message .hint {
    margin-top: var(--space-2);
    color: var(--chrome-fg-muted);
    font-size: var(--text-sm);
  }

  .bar {
    flex: none;
    height: var(--bar-height);
    padding: 0 var(--space-2);
    border-top: 1px solid var(--chrome-hairline);
    border-radius: 0 0 var(--radius-card) var(--radius-card);
    background: var(--chrome-bg-solid);
    transition: opacity var(--motion);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 36px;
  }

  .spacer {
    flex: 1;
  }

  .control {
    position: relative;
    display: inline-grid;
    flex: none;
    place-items: center;
    min-width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--chrome-fg);
    cursor: pointer;
  }

  .control:hover {
    background: var(--chrome-fill-hover);
  }

  .control:active,
  .control[aria-expanded='true'] {
    background: var(--chrome-fill-active);
  }

  .control.on::after {
    position: absolute;
    right: 8px;
    bottom: 3px;
    left: 8px;
    height: 2px;
    border-radius: 1px;
    background: currentColor;
    content: '';
  }

  .control.speed {
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .control:focus-visible,
  .scrubber:focus-visible,
  .level:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--chrome-fg);
  }

  .anchor {
    position: relative;
  }

  .volume {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .time {
    margin-left: var(--space-2);
    color: var(--chrome-fg);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .sep {
    margin: 0 4px;
    color: var(--chrome-fg-muted);
  }

  /* Both sliders: a thin track inside a taller hit area. */
  .scrubber,
  .level {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    cursor: pointer;
    touch-action: none;
  }

  .scrubber {
    height: 16px;
  }

  .level {
    width: 72px;
    height: 28px;
    margin-right: var(--space-1);
    padding: 0 6px;
  }

  .scrubber.disabled {
    cursor: default;
  }

  .rail {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    height: 100%;
  }

  .track {
    position: relative;
    flex: 1;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--chrome-hairline);
    transition: height var(--motion-fast);
  }

  .scrubber:hover .track,
  .scrubber.dragging .track {
    height: 6px;
  }

  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
  }

  .fill.buffered {
    background: color-mix(in srgb, var(--chrome-fg) 32%, transparent);
  }

  .fill.played {
    background: var(--chrome-fg);
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--chrome-fg);
    opacity: 0;
    transform: translate(-50%, -50%);
    transition: opacity var(--motion-fast);
    pointer-events: none;
  }

  .scrubber:hover .thumb,
  .scrubber:focus-visible .thumb,
  .scrubber.dragging .thumb,
  .level:hover .thumb,
  .level:focus-visible .thumb {
    opacity: 1;
  }

  .scrubber.disabled .thumb {
    display: none;
  }

  .tip {
    position: absolute;
    bottom: calc(100% + 6px);
    padding: 2px 6px;
    border: 1px solid var(--chrome-hairline);
    border-radius: var(--radius-sm);
    background: var(--chrome-bg-solid);
    color: var(--chrome-fg);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 16px;
    white-space: nowrap;
    transform: translateX(-50%);
    pointer-events: none;
  }

  /* Full screen: the picture takes the whole display and the bar sits over its bottom edge. */
  .screen.fullscreen {
    width: 100%;
    height: 100%;
    max-height: none;
    border-radius: 0;
  }

  .fullscreen .frame {
    flex: 1;
    border-radius: 0;
  }

  .fullscreen .bar {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    padding: 0 var(--space-4);
    border-radius: 0;
  }

  .fullscreen:not(.idle) .cue {
    bottom: calc(var(--bar-height) + 4%);
  }

  .idle {
    cursor: none;
  }

  .idle .bar {
    opacity: 0;
    pointer-events: none;
  }

  .shortcuts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2) var(--space-5);
    align-items: center;
    margin: 0;
  }

  .shortcuts dt {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .shortcuts dd {
    margin: 0;
    color: var(--fg-muted);
  }

  .or {
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }

  @container (max-width: 420px) {
    .level {
      display: none;
    }
  }
</style>
