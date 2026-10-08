<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import { Icon, type IconName } from '@butterfly-record/ui'

  let {
    icon,
    label,
    size = 'md',
    variant = 'ghost',
    tone = 'default',
    pressed,
    type = 'button',
    class: className = '',
    element = $bindable(),
    ...rest
  }: Omit<HTMLButtonAttributes, 'class' | 'title' | 'aria-label' | 'children'> & {
    icon: IconName
    /** Tooltip and accessible name. */
    label: string
    size?: 'sm' | 'md' | 'lg'
    variant?: 'ghost' | 'secondary'
    tone?: 'default' | 'danger' | 'muted'
    /** Set for toggle buttons; renders aria-pressed. */
    pressed?: boolean | undefined
    class?: string
    element?: HTMLButtonElement | undefined
  } = $props()

  const iconSize = $derived(size === 'sm' ? 14 : size === 'lg' ? 20 : 16)
</script>

<button
  bind:this={element}
  {type}
  class="icon-btn {size} {variant} {tone} {className}"
  title={label}
  aria-label={label}
  aria-pressed={pressed}
  {...rest}
>
  <Icon name={icon} size={iconSize} />
</button>

<style>
  .icon-btn {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }

  .sm {
    width: 28px;
    height: 28px;
  }

  .lg {
    width: 40px;
    height: 40px;
  }

  .secondary {
    border-color: var(--hairline-strong);
    background: var(--bg-elevated);
  }

  .muted {
    color: var(--fg-muted);
  }

  .danger {
    color: var(--danger);
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--fill-hover);
    color: var(--fg);
  }

  .danger:hover:not(:disabled) {
    color: var(--danger);
  }

  .icon-btn:active:not(:disabled),
  .icon-btn[aria-pressed='true'] {
    background: var(--fill-active);
  }

  .icon-btn:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .icon-btn:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }
</style>
