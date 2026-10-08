<script lang="ts">
  let {
    checked = $bindable(false),
    onchange,
    id,
    label,
    labelledby,
    describedby,
    disabled = false,
  }: {
    checked?: boolean
    onchange?: (checked: boolean) => void
    id?: string | undefined
    label?: string | undefined
    labelledby?: string | undefined
    describedby?: string | undefined
    disabled?: boolean
  } = $props()

  function toggle() {
    checked = !checked
    onchange?.(checked)
  }
</script>

<button
  {id}
  type="button"
  role="switch"
  class="switch"
  aria-checked={checked}
  aria-label={label}
  aria-labelledby={labelledby}
  aria-describedby={describedby}
  {disabled}
  onclick={toggle}
>
  <span class="knob"></span>
</button>

<style>
  .switch {
    position: relative;
    flex: none;
    width: 40px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--fg-muted);
    border-radius: var(--radius-pill);
    background: transparent;
    cursor: pointer;
    transition:
      background-color var(--motion),
      border-color var(--motion);
  }

  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--fg-muted);
    transition:
      transform var(--motion),
      background-color var(--motion);
  }

  .switch:hover:not(:disabled) {
    background: var(--fill-hover);
  }

  .switch[aria-checked='true'] {
    border-color: var(--accent);
    background: var(--accent);
  }

  .switch[aria-checked='true']:hover:not(:disabled) {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
  }

  .switch[aria-checked='true'] .knob {
    background: var(--accent-fg);
    transform: translateX(20px);
  }

  .switch:active:not(:disabled) .knob {
    width: 14px;
  }

  .switch[aria-checked='true']:active:not(:disabled) .knob {
    transform: translateX(18px);
  }

  .switch:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .switch:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }
</style>
