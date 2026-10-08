<script lang="ts">
  import { tick } from 'svelte'
  import { Icon } from '@butterfly-record/ui'
  import { menu, type MenuEntry } from './menu.svelte.ts'

  let element: HTMLDivElement | undefined = $state()
  let position = $state({ left: 0, top: 0 })

  const current = $derived(menu.current)

  $effect(() => {
    if (!current) return
    void place()
  })

  async function place() {
    await tick()
    if (!element || !current) return
    const { width, height } = element.getBoundingClientRect()
    const margin = 8
    let left = current.align === 'end' ? current.x - width : current.x
    let top = current.y
    if (left + width > innerWidth - margin) left = innerWidth - margin - width
    if (top + height > innerHeight - margin) {
      top = current.anchor ? current.anchor.getBoundingClientRect().top - height - 4 : current.y - height
    }
    position = { left: Math.max(margin, left), top: Math.max(margin, top) }
    items()[0]?.focus()
  }

  function items(): HTMLButtonElement[] {
    return element ? [...element.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')] : []
  }

  function select(entry: MenuEntry) {
    if (entry.kind === 'separator' || entry.kind === 'heading') return
    menu.close()
    entry.onSelect()
  }

  function keydown(event: KeyboardEvent) {
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: HTMLButtonElement | undefined
    switch (event.key) {
      case 'ArrowDown':
        next = list[(index + 1) % list.length]
        break
      case 'ArrowUp':
        next = list[(index - 1 + list.length) % list.length]
        break
      case 'Home':
        next = list[0]
        break
      case 'End':
        next = list[list.length - 1]
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        menu.close()
        return
      case 'Tab':
        event.preventDefault()
        menu.close()
        return
      default:
        return
    }
    event.preventDefault()
    next?.focus()
  }

  function outside(event: PointerEvent) {
    if (!current || !element) return
    const target = event.target as Node
    if (element.contains(target)) return
    // The opening button toggles the menu itself.
    if (current.anchor?.contains(target)) return
    menu.current = null
  }

  function dismiss() {
    if (menu.current) menu.current = null
  }

  function scrolled(event: Event) {
    const origin = current?.origin
    if (!origin) return
    const target = event.target
    if (target === document || (target instanceof Node && target.contains(origin))) dismiss()
  }
</script>

<svelte:window onpointerdowncapture={outside} onresize={dismiss} onblur={dismiss} />
<svelte:document onscrollcapture={scrolled} />

{#if current}
  <div
    bind:this={element}
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label={current.label}
    style:left="{position.left}px"
    style:top="{position.top}px"
    onkeydown={keydown}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each current.entries as entry, index (index)}
      {#if entry.kind === 'separator'}
        <div class="separator" role="separator"></div>
      {:else if entry.kind === 'heading'}
        <div class="heading" role="presentation">{entry.label}</div>
      {:else}
        <button
          type="button"
          role="menuitem"
          class:danger={entry.danger}
          disabled={entry.disabled}
          onclick={() => select(entry)}
        >
          <span class="icon">{#if entry.icon}<Icon name={entry.icon} size={16} />{/if}</span>
          {entry.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    max-width: 320px;
    padding: var(--space-1);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-card);
    background: var(--bg-overlay);
    box-shadow: var(--shadow-pop);
    animation: enter var(--motion);
  }

  .menu:focus {
    outline: none;
  }

  button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-3) 0 var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg);
    font-size: var(--text-md);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .icon {
    display: grid;
    width: 16px;
    place-items: center;
    color: var(--fg-muted);
  }

  button:hover:not(:disabled),
  button:focus-visible {
    outline: none;
    background: var(--fill-hover);
  }

  button:active:not(:disabled) {
    background: var(--fill-active);
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .danger,
  .danger .icon {
    color: var(--danger);
  }

  .separator {
    height: 1px;
    margin: var(--space-1) calc(-1 * var(--space-1));
    background: var(--hairline);
  }

  .heading {
    padding: var(--space-2) var(--space-2) var(--space-1);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 16px;
  }

  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }
</style>
