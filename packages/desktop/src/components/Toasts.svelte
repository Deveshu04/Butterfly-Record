<script lang="ts">
  import { Icon, type IconName } from '@butterfly-record/ui'
  import { toasts, type Toast } from './toasts.svelte.ts'

  const ICONS: Record<Toast['tone'], IconName> = {
    info: 'info',
    ok: 'check-circle',
    error: 'x-circle',
  }

  let { host = null }: { host?: string | null } = $props()

  /** Only one instance renders: inside the innermost open modal dialog, else the page's own. */
  const active = $derived((toasts.hosts.at(-1) ?? null) === host)
  const expiry = toasts.expiry

  let hovering = $state(false)
  let hoverStarted = 0

  $effect(() => {
    if (!active) return
    const now = Date.now()
    for (const toast of toasts.list) if (!expiry.has(toast.id)) expiry.set(toast.id, now + toast.timeout)
  })

  // Hovering the stack pauses every countdown so a toast never vanishes under the pointer.
  $effect(() => {
    if (!active || hovering || toasts.list.length === 0) return
    const timer = setInterval(() => {
      const now = Date.now()
      for (const toast of toasts.list) {
        if ((expiry.get(toast.id) ?? Infinity) <= now) toasts.dismiss(toast.id)
      }
    }, 250)
    return () => clearInterval(timer)
  })

  function enter() {
    hovering = true
    hoverStarted = Date.now()
  }

  function leave() {
    const paused = Date.now() - hoverStarted
    for (const [id, at] of expiry) expiry.set(id, at + paused)
    hovering = false
  }

  async function run(toast: Toast) {
    toasts.dismiss(toast.id)
    try {
      await toast.action?.run()
    } catch (error) {
      toasts.error(error)
    }
  }
</script>

{#if active}
  <!-- Present before any toast: a live region inserted along with its text is often not read. -->
  <div class="announcer" role="status" aria-live="polite" aria-atomic="true">{toasts.announcement}</div>
  <section
    class="stack"
    aria-label="Notifications"
    onpointerenter={enter}
    onpointerleave={leave}
  >
    {#each toasts.list as toast (toast.id)}
      <div class="toast {toast.tone}" role={toast.tone === 'error' ? 'alert' : undefined}>
        <span class="icon"><Icon name={ICONS[toast.tone]} size={16} /></span>
        <p class="message">{toast.message}</p>
        {#if toast.action}
          <button type="button" class="action" onclick={() => run(toast)}>{toast.action.label}</button>
        {/if}
        <button
          type="button"
          class="close"
          aria-label="Dismiss notification"
          title="Dismiss"
          onclick={() => toasts.dismiss(toast.id)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    {/each}
  </section>
{/if}

<style>
  .announcer {
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

  .stack {
    position: fixed;
    right: var(--space-4);
    bottom: var(--space-4);
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 360px;
    max-width: calc(100vw - 32px);
    padding: 10px var(--space-2) 10px var(--space-3);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-card);
    background: var(--bg-overlay);
    box-shadow: var(--shadow-pop);
    pointer-events: auto;
    animation: enter var(--motion-slow);
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    height: 20px;
    color: var(--fg-muted);
  }

  .ok .icon {
    color: var(--ok);
  }

  .error .icon {
    color: var(--danger);
  }

  .message {
    flex: 1;
    min-width: 0;
    margin: 0;
    line-height: 20px;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .action {
    flex: none;
    height: 20px;
    padding: 0 var(--space-1);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: var(--hairline-strong);
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .action:hover {
    text-decoration-color: currentColor;
  }

  .close {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
  }

  .close:hover {
    background: var(--fill-hover);
    color: var(--fg);
  }

  .action:focus-visible,
  .close:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
