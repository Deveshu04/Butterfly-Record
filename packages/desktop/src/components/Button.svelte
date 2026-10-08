<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import { Icon, type IconName } from '@butterfly-record/ui'

  let {
    variant = 'secondary',
    size = 'md',
    icon,
    busy = false,
    wide = false,
    disabled = false,
    type = 'button',
    class: className = '',
    element = $bindable(),
    children,
    ...rest
  }: Omit<HTMLButtonAttributes, 'class'> & {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'record'
    size?: 'sm' | 'md' | 'lg'
    icon?: IconName | undefined
    busy?: boolean
    wide?: boolean
    class?: string
    element?: HTMLButtonElement | undefined
    children?: Snippet
  } = $props()

  const iconSize = $derived(size === 'sm' ? 14 : 16)
</script>

<button
  bind:this={element}
  {type}
  class="btn {variant} {size} {className}"
  class:wide
  disabled={disabled || busy}
  aria-busy={busy || undefined}
  {...rest}
>
  {#if busy}
    <span class="spinner" aria-hidden="true"></span>
  {:else if icon}
    <Icon name={icon} size={iconSize} />
  {/if}
  {#if children}<span class="label">{@render children()}</span>{/if}
</button>

<style>
  .btn {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    font-size: var(--text-md);
    font-weight: 500;
    line-height: 20px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      color var(--motion-fast);
  }

  .btn.sm {
    height: 28px;
    padding: 0 var(--space-2);
    gap: 6px;
    font-size: var(--text-sm);
  }

  .btn.lg {
    height: 40px;
    padding: 0 var(--space-5);
    font-size: var(--text-md);
    font-weight: 600;
  }

  .btn.wide {
    width: 100%;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .primary {
    background: var(--accent);
    color: var(--accent-fg);
  }

  .primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .primary:active:not(:disabled) {
    background: var(--accent);
    opacity: 0.88;
  }

  .secondary,
  .danger {
    border-color: var(--hairline-strong);
    background: var(--bg-elevated);
  }

  .secondary:hover:not(:disabled),
  .danger:hover:not(:disabled),
  .ghost:hover:not(:disabled) {
    background: var(--fill-hover);
  }

  .secondary:active:not(:disabled),
  .danger:active:not(:disabled),
  .ghost:active:not(:disabled) {
    background: var(--fill-active);
  }

  .danger {
    color: var(--danger);
  }

  .ghost {
    color: var(--fg);
  }

  .record {
    background: var(--record-strong);
    color: var(--record-fg);
  }

  .record:hover:not(:disabled) {
    background: color-mix(in srgb, var(--record-strong) 88%, black);
  }

  .record:active:not(:disabled) {
    background: color-mix(in srgb, var(--record-strong) 78%, black);
  }

  .btn:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .btn[aria-busy='true'] {
    opacity: 0.75;
  }

  .btn:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
