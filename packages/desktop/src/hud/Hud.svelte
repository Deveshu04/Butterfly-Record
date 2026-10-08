<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Icon } from '@butterfly-record/ui'
  import { emitHudAction, onRecorderStatus, type HudActionName, type RecorderStatus } from '../lib/ipc.ts'
  import { formatClock } from '../components/format.ts'

  let status = $state<RecorderStatus | null>(null)
  let confirmingDiscard = $state(false)
  let confirmButton: HTMLButtonElement | undefined = $state()
  let confirmTimer: ReturnType<typeof setTimeout> | undefined

  const phase = $derived(status?.phase ?? 'starting')
  const live = $derived(phase === 'recording' || phase === 'paused')

  onMount(() => {
    const unlisten = onRecorderStatus((next) => (status = next))
    return () => {
      clearTimeout(confirmTimer)
      void unlisten.then((stop) => stop())
    }
  })

  function send(action: HudActionName) {
    emitHudAction(action).catch((error: unknown) => console.warn('[butterfly-record] HUD action not sent', error))
  }

  // One click on a floating bar is too easy to make by accident; the second click confirms.
  function discard() {
    if (confirmingDiscard) {
      clearTimeout(confirmTimer)
      confirmingDiscard = false
      send('discard')
      return
    }
    confirmingDiscard = true
    confirmTimer = setTimeout(() => (confirmingDiscard = false), 3000)
    // The trash button is gone; keep keyboard focus on the bar.
    void tick().then(() => confirmButton?.focus())
  }
</script>

<div class="hud">
  <div class="drag" data-tauri-drag-region>
    <span class="grip"><Icon name="grip" size={16} /></span>
    {#if phase === 'countdown'}
      <span class="label">Starting in {status?.countdown ?? ''}</span>
    {:else if phase === 'finalizing'}
      <span class="label">Saving…</span>
    {:else if live}
      <span class="dot" class:paused={phase === 'paused'}></span>
      <!-- The bar has no room for a "Paused" label: the grey dot, muted timer and Resume button say it. -->
      <span class="timer" class:muted={phase === 'paused'}>
        {formatClock(status?.elapsed ?? 0)}{#if phase === 'paused'}<span class="sr-only"> Paused</span>{/if}
      </span>
    {:else}
      <span class="label muted">Starting…</span>
    {/if}
  </div>

  {#if live}
    <div class="actions">
      {#if confirmingDiscard}
        <!-- Pause and mute step aside while confirming, so a long timer still fits. -->
        <button bind:this={confirmButton} type="button" class="confirm" onclick={discard}>Discard?</button>
      {:else}
        {#if phase === 'paused'}
          <button type="button" class="icon" title="Resume" aria-label="Resume" onclick={() => send('resume')}>
            <Icon name="play" size={16} />
          </button>
        {:else}
          <button type="button" class="icon" title="Pause" aria-label="Pause" onclick={() => send('pause')}>
            <Icon name="pause" size={16} />
          </button>
        {/if}
        {#if status?.hasMic}
          <button
            type="button"
            class="icon"
            class:off={status.micMuted}
            title={status.micMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-label={status.micMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={status.micMuted}
            onclick={() => send(status?.micMuted ? 'unmute' : 'mute')}
          >
            <Icon name={status.micMuted ? 'mic-off' : 'mic'} size={16} />
          </button>
        {/if}
        <button type="button" class="icon" title="Discard recording" aria-label="Discard recording" onclick={discard}>
          <Icon name="trash" size={16} />
        </button>
      {/if}
      <button type="button" class="stop" onclick={() => send('stop')}>
        <Icon name="stop" size={14} />
        Stop
      </button>
    </div>
  {:else if phase === 'countdown'}
    <div class="actions">
      <button type="button" class="text" onclick={() => send('discard')}>Cancel</button>
    </div>
  {/if}
</div>

<style>
  :global(html),
  :global(body) {
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: var(--chrome-bg-solid);
  }

  :global(#hud) {
    height: 100%;
  }

  .hud {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    box-sizing: border-box;
    height: 100%;
    padding: 0 var(--space-3) 0 var(--space-1);
    border: 1px solid var(--chrome-hairline);
    background: var(--chrome-bg-solid);
    color: var(--chrome-fg);
    font-family: var(--font-ui);
    font-size: var(--text-md);
    user-select: none;
    cursor: default;
  }

  .drag {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-2);
    align-self: stretch;
    min-width: 0;
    overflow: hidden;
  }

  /* Children must not swallow the press, or the window will not move. */
  .drag > * {
    pointer-events: none;
  }

  .grip {
    display: grid;
    flex: none;
    width: 20px;
    place-items: center;
    color: var(--chrome-fg-muted);
  }

  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--record);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .dot.paused {
    background: var(--chrome-fg-muted);
    animation: none;
  }

  .timer {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-variant-numeric: tabular-nums;
    line-height: 20px;
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .muted {
    color: var(--chrome-fg-muted);
  }

  .actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--chrome-fg);
    font: inherit;
    cursor: pointer;
  }

  button:hover {
    background: var(--chrome-fill-hover);
  }

  button:active {
    background: var(--chrome-fill-active);
  }

  button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--chrome-fg);
  }

  .icon {
    width: 32px;
  }

  .icon.off {
    color: var(--chrome-fg-muted);
  }

  .text,
  .confirm {
    padding: 0 var(--space-3);
  }

  .confirm {
    color: var(--danger);
    font-weight: 600;
  }

  .stop {
    margin-left: var(--space-1);
    padding: 0 var(--space-3);
    background: var(--record-strong);
    color: var(--record-fg);
    font-weight: 600;
  }

  .stop:hover {
    background: color-mix(in srgb, var(--record-strong) 88%, black);
  }

  .stop:active {
    background: color-mix(in srgb, var(--record-strong) 78%, black);
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
