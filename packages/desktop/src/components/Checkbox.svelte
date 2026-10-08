<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Icon } from '@butterfly-record/ui'

  let {
    checked = $bindable(false),
    disabled = false,
    onchange,
    children,
  }: {
    checked?: boolean
    disabled?: boolean
    onchange?: (checked: boolean) => void
    children: Snippet
  } = $props()
</script>

<label class="checkbox" class:disabled>
  <input type="checkbox" bind:checked {disabled} onchange={() => onchange?.(checked)} />
  <span class="box" aria-hidden="true">{#if checked}<Icon name="check" size={12} strokeWidth={2.4} />{/if}</span>
  <span class="text">{@render children()}</span>
</label>

<style>
  .checkbox {
    position: relative;
    display: inline-flex;
    align-items: flex-start;
    gap: var(--space-2);
    min-height: 20px;
    cursor: pointer;
  }

  .disabled {
    cursor: default;
    opacity: 0.45;
  }

  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .box {
    display: grid;
    flex: none;
    place-items: center;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border: 1px solid var(--fg-muted);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--accent-fg);
  }

  input:checked + .box {
    border-color: var(--accent);
    background: var(--accent);
  }

  .checkbox:hover:not(.disabled) .box {
    border-color: var(--fg);
  }

  .checkbox:active:not(.disabled) .box {
    background: var(--fill-active);
  }

  .checkbox:active:not(.disabled) input:checked + .box {
    background: var(--accent-hover);
  }

  input:focus-visible + .box {
    box-shadow: var(--focus);
  }

  .text {
    line-height: 20px;
  }
</style>
