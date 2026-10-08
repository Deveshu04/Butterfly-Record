<script lang="ts" module>
  export interface SelectOption<V> {
    value: V
    label: string
    disabled?: boolean
  }
</script>

<script lang="ts" generics="T extends string | number | null">
  import { Icon } from '@butterfly-record/ui'

  let {
    value = $bindable(),
    options,
    onchange,
    id,
    label,
    disabled = false,
    size = 'md',
    wide = false,
  }: {
    value: T
    options: SelectOption<T>[]
    onchange?: (value: T) => void
    id?: string | undefined
    /** Accessible name when no <label for> points at this control. */
    label?: string | undefined
    disabled?: boolean
    size?: 'sm' | 'md'
    wide?: boolean
  } = $props()

  const selected = $derived(options.findIndex((option) => option.value === value))

  function change(event: Event & { currentTarget: HTMLSelectElement }) {
    const option = options[Number(event.currentTarget.value)]
    if (!option) return
    value = option.value
    onchange?.(option.value)
  }
</script>

<div class="select {size}" class:wide class:disabled>
  <select {id} aria-label={label} {disabled} onchange={change}>
    {#each options as option, index (index)}
      <option value={String(index)} selected={index === selected} disabled={option.disabled}>
        {option.label}
      </option>
    {/each}
  </select>
  <span class="chevron" aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
</div>

<style>
  .select {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }

  .wide {
    width: 100%;
  }

  select {
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 32px 0 var(--space-3);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
    background: var(--bg-elevated);
    color: var(--fg);
    font-size: var(--text-md);
    line-height: 20px;
    text-overflow: ellipsis;
    cursor: pointer;
    appearance: none;
    transition: background-color var(--motion-fast);
  }

  .sm select {
    height: 28px;
    padding-left: var(--space-2);
    font-size: var(--text-sm);
  }

  select option {
    background: var(--bg-overlay);
    color: var(--fg);
  }

  select:hover:not(:disabled) {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 4%);
  }

  select:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  select:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .chevron {
    position: absolute;
    top: 50%;
    right: 10px;
    color: var(--fg-muted);
    pointer-events: none;
    transform: translateY(-50%);
  }

  .disabled .chevron {
    opacity: 0.45;
  }
</style>
