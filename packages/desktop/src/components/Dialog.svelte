<script lang="ts">
  import type { Snippet } from 'svelte'
  import Toasts from './Toasts.svelte'
  import { toasts } from './toasts.svelte.ts'

  let {
    open = $bindable(false),
    title,
    description,
    width = 440,
    onclose,
    children,
    footer,
  }: {
    open?: boolean
    title: string
    description?: string | undefined
    width?: number
    onclose?: () => void
    children?: Snippet
    footer?: Snippet
  } = $props()

  const uid = $props.id()
  let dialog: HTMLDialogElement | undefined = $state()
  let pressedOnBackdrop = false

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  })

  $effect(() => {
    if (open) return toasts.host(uid)
  })

  function closed() {
    open = false
    onclose?.()
  }

  function focusables(): HTMLElement[] {
    if (!dialog) return []
    return [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null)
  }

  // Modal dialogs make the page inert, but Tab can still leave for the window chrome; keep it inside.
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const items = focusables()
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // The dialog box has no padding of its own, so a press on the element itself is a press on the backdrop.
  function pointerdown(event: PointerEvent) {
    pressedOnBackdrop = event.target === dialog
  }

  function click(event: MouseEvent) {
    if (pressedOnBackdrop && event.target === dialog) open = false
    pressedOnBackdrop = false
  }
</script>

<dialog
  bind:this={dialog}
  style:width="min({width}px, calc(100vw - 32px))"
  aria-labelledby="{uid}-title"
  aria-describedby={description ? `${uid}-description` : undefined}
  onclose={closed}
  onkeydown={keydown}
  onpointerdown={pointerdown}
  onclick={click}
>
  {#if open}
    <div class="box">
      <h2 id="{uid}-title">{title}</h2>
      {#if description}<p id="{uid}-description" class="description">{description}</p>{/if}
      {#if children}<div class="body">{@render children()}</div>{/if}
    </div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
    <Toasts host={uid} />
  {/if}
</dialog>

<style>
  dialog {
    max-height: calc(100vh - 64px);
    padding: 0;
    overflow: auto;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-overlay);
    color: var(--fg);
    box-shadow: var(--shadow-pop);
  }

  dialog::backdrop {
    background: var(--scrim);
  }

  dialog[open] {
    animation: enter var(--motion-slow);
  }

  .box {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-6) var(--space-6) var(--space-5);
  }

  h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    line-height: 28px;
  }

  .description {
    margin: 0;
    color: var(--fg-muted);
    line-height: 20px;
    user-select: text;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-6);
    border-top: 1px solid var(--hairline);
    background: var(--bg-sunken);
  }

  @keyframes enter {
    from {
      opacity: 0;
      transform: scale(0.98);
    }
  }
</style>
