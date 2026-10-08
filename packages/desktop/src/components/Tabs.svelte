<script lang="ts" generics="T extends string">
  let {
    tabs,
    value,
    onchange,
    label,
    idPrefix,
  }: {
    tabs: { id: T; label: string; count?: number | undefined }[]
    value: T
    onchange: (id: T) => void
    label: string
    idPrefix: string
  } = $props()

  let list: HTMLDivElement | undefined = $state()

  function keydown(event: KeyboardEvent) {
    const index = tabs.findIndex((tab) => tab.id === value)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const tab = tabs[next]
    if (!tab) return
    onchange(tab.id)
    list?.querySelector<HTMLButtonElement>(`#${idPrefix}-tab-${tab.id}`)?.focus()
  }
</script>

<div class="tabs" role="tablist" aria-label={label} bind:this={list} tabindex="-1" onkeydown={keydown}>
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      role="tab"
      id="{idPrefix}-tab-{tab.id}"
      aria-selected={tab.id === value}
      aria-controls="{idPrefix}-panel-{tab.id}"
      tabindex={tab.id === value ? 0 : -1}
      onclick={() => onchange(tab.id)}
    >
      {tab.label}
      {#if tab.count}<span class="count">{tab.count}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border-bottom: 1px solid var(--hairline);
  }

  .tabs:focus {
    outline: none;
  }

  button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    padding: 0 var(--space-2);
    border: none;
    border-radius: var(--radius-control) var(--radius-control) 0 0;
    background: transparent;
    color: var(--fg-muted);
    font-size: var(--text-md);
    font-weight: 500;
    cursor: pointer;
  }

  button:hover {
    color: var(--fg);
  }

  button:active {
    background: var(--fill-hover);
  }

  button[aria-selected='true'] {
    color: var(--fg);
  }

  button[aria-selected='true']::after {
    position: absolute;
    right: var(--space-2);
    bottom: -1px;
    left: var(--space-2);
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
    content: '';
  }

  button:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: var(--radius-pill);
    background: var(--fill-active);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 16px;
    text-align: center;
  }
</style>
