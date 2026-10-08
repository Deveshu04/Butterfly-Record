<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { Icon, type IconName } from '@butterfly-record/ui'

  let {
    value = $bindable(''),
    icon,
    clearable = false,
    label,
    size = 'md',
    wide = false,
    invalid = false,
    element = $bindable(),
    class: className = '',
    ...rest
  }: Omit<HTMLInputAttributes, 'value' | 'size' | 'class'> & {
    value?: string
    icon?: IconName | undefined
    /** Shows a clear button while there is text; Esc also clears. */
    clearable?: boolean
    /** Accessible name when no <label for> points at this field. */
    label?: string | undefined
    size?: 'sm' | 'md'
    wide?: boolean
    invalid?: boolean
    element?: HTMLInputElement | undefined
    class?: string
  } = $props()

  function clear() {
    value = ''
    element?.dispatchEvent(new Event('input', { bubbles: true }))
    element?.focus()
  }

  function keydown(event: KeyboardEvent) {
    if (clearable && event.key === 'Escape' && value) {
      event.preventDefault()
      event.stopPropagation()
      clear()
    }
  }
</script>

<div class="field {size} {className}" class:wide class:has-icon={icon} class:has-clear={clearable && value}>
  {#if icon}<span class="lead" aria-hidden="true"><Icon name={icon} size={14} /></span>{/if}
  <input
    bind:this={element}
    bind:value
    aria-label={label}
    aria-invalid={invalid || undefined}
    autocomplete="off"
    spellcheck="false"
    onkeydowncapture={keydown}
    {...rest}
  />
  {#if clearable && value}
    <button type="button" class="clear" aria-label="Clear" title="Clear" onclick={clear}>
      <Icon name="close" size={12} />
    </button>
  {/if}
</div>

<style>
  .field {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }

  .wide {
    width: 100%;
  }

  input {
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
    background: var(--bg-elevated);
    color: var(--fg);
    font-size: var(--text-md);
    line-height: 20px;
    user-select: text;
  }

  .sm input {
    height: 28px;
    font-size: var(--text-sm);
  }

  .has-icon input {
    padding-left: 32px;
  }

  .has-clear input {
    padding-right: 32px;
  }

  input::placeholder {
    color: var(--fg-faint);
  }

  input:hover:not(:disabled):not(:focus) {
    border-color: var(--fg-faint);
  }

  /* Windows text boxes mark focus with a heavier accent underline rather than a ring. */
  input:focus,
  input:focus-visible {
    border-bottom-color: var(--accent);
    outline: none;
    box-shadow: inset 0 -1px 0 var(--accent);
  }

  input[aria-invalid='true'] {
    border-color: var(--danger);
  }

  input:disabled {
    opacity: 0.45;
  }

  input[type='search']::-webkit-search-cancel-button {
    display: none;
  }

  .lead {
    position: absolute;
    left: 11px;
    color: var(--fg-muted);
    pointer-events: none;
  }

  .clear {
    position: absolute;
    right: 4px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
  }

  .sm .clear {
    width: 20px;
    height: 20px;
  }

  .clear:hover {
    background: var(--fill-hover);
    color: var(--fg);
  }

  .clear:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }
</style>
