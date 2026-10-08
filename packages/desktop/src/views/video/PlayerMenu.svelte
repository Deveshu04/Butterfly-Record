<script lang="ts" generics="T">
  import { onMount } from 'svelte'
  import { Icon } from '@butterfly-record/ui'

  let {
    label,
    options,
    selected,
    onselect,
    onclose,
  }: {
    label: string
    options: { value: T; label: string }[]
    selected: T
    onselect: (value: T) => void
    /** `refocus` is false when the pointer dismissed the menu. */
    onclose: (refocus: boolean) => void
  } = $props()

  let element: HTMLDivElement | undefined = $state()

  function items(): HTMLButtonElement[] {
    return element ? [...element.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')] : []
  }

  onMount(() => {
    const list = items()
    ;(list.find((item) => item.getAttribute('aria-checked') === 'true') ?? list[0])?.focus()
  })

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
      case 'Tab':
        event.preventDefault()
        event.stopPropagation()
        onclose(true)
        return
      default:
        return
    }
    event.preventDefault()
    next?.focus()
  }

  function outside(event: PointerEvent) {
    if (!element || !(event.target instanceof Node)) return
    if (element.contains(event.target)) return
    // The opening button toggles the menu itself.
    if ((event.target as Element).closest?.('[aria-haspopup="menu"][aria-expanded="true"]')) return
    onclose(false)
  }
</script>

<svelte:window onpointerdowncapture={outside} onblur={() => onclose(false)} />

<div bind:this={element} class="menu" role="menu" tabindex="-1" aria-label={label} onkeydown={keydown}>
  {#each options as option, index (index)}
    {@const checked = option.value === selected}
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onclick={() => {
        onselect(option.value)
        onclose(true)
      }}
    >
      <span class="check">{#if checked}<Icon name="check" size={14} />{/if}</span>
      {option.label}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 2;
    display: flex;
    flex-direction: column;
    min-width: 168px;
    max-height: min(320px, 60vh);
    padding: var(--space-1);
    overflow-y: auto;
    border: 1px solid var(--chrome-hairline);
    border-radius: var(--radius-card);
    background: var(--chrome-bg-solid);
    color: var(--chrome-fg);
    box-shadow: var(--shadow-pop);
  }

  .menu:focus {
    outline: none;
  }

  button {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-3) 0 var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font-size: var(--text-md);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  button:hover,
  button:focus-visible {
    outline: none;
    background: var(--chrome-fill-hover);
  }

  button:active {
    background: var(--chrome-fill-active);
  }

  .check {
    display: grid;
    width: 14px;
    place-items: center;
  }
</style>
