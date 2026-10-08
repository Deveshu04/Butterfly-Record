<script lang="ts">
  import { openLevelMeter } from '../lib/recorder.svelte.ts'
  import { mainWindow } from './window-state.svelte.ts'

  let {
    deviceId,
    label = 'Microphone level',
  }: {
    deviceId: string | null
    label?: string
  } = $props()

  const SEGMENTS = 24
  let level = $state(0)
  let failed = $state(false)

  $effect(() => mainWindow.watch())

  $effect(() => {
    const device = deviceId
    level = 0
    failed = false
    // A hidden or minimized window must not keep the microphone open.
    if (!mainWindow.visible) return
    let meter: { level(): number; close(): void } | null = null
    let frame = 0
    let disposed = false

    // Like the recorder, an unplugged device falls back to the system default.
    openLevelMeter(device)
      .catch((error: unknown) => (device ? openLevelMeter(null) : Promise.reject(error)))
      .then((opened) => {
        if (disposed) {
          opened.close()
          return
        }
        meter = opened
        const loop = () => {
          if (!meter) return
          // Fast attack, slow release, so speech reads as a steady bar rather than flicker.
          const next = meter.level()
          level = next > level ? next : level * 0.88 + next * 0.12
          frame = requestAnimationFrame(loop)
        }
        frame = requestAnimationFrame(loop)
      })
      .catch(() => {
        if (!disposed) failed = true
      })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      meter?.close()
      meter = null
    }
  })

  const lit = $derived(Math.round(Math.min(1, level) * SEGMENTS))
</script>

<div
  class="meter"
  class:failed
  role="meter"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(level * 100)}
>
  {#each { length: SEGMENTS }, index (index)}
    <span class:on={index < lit} class:hot={index >= SEGMENTS - 3}></span>
  {/each}
</div>
{#if failed}
  <p class="failed-text">The microphone could not be opened. Check that it is connected and not in use.</p>
{/if}

<style>
  .meter {
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    gap: 2px;
    width: 100%;
    height: 8px;
  }

  span {
    border-radius: 1px;
    background: var(--fill-active);
  }

  span.on {
    background: var(--ok);
  }

  span.on.hot {
    background: var(--caution);
  }

  .failed span {
    background: var(--hairline);
  }

  .failed-text {
    margin: var(--space-2) 0 0;
    color: var(--danger);
    font-size: var(--text-sm);
    line-height: 16px;
  }
</style>
