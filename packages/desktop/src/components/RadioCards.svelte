<script lang="ts" generics="T extends string">
  let {
    value = $bindable(),
    options,
    label,
    name,
  }: {
    value: T
    options: { value: T; label: string; description?: string | undefined; disabled?: boolean }[]
    label: string
    name: string
  } = $props()
</script>

<div class="cards" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <label class="card" class:checked={value === option.value} class:disabled={option.disabled}>
      <input type="radio" {name} value={option.value} bind:group={value} disabled={option.disabled} />
      <span class="mark" aria-hidden="true"></span>
      <span class="text">
        <span class="title">{option.label}</span>
        {#if option.description}<span class="description">{option.description}</span>{/if}
      </span>
    </label>
  {/each}
</div>

<style>
  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .card {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 10px var(--space-3);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    cursor: pointer;
  }

  .card:hover:not(.disabled) {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 4%);
  }

  .card:active:not(.disabled) {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 8%);
  }

  .card.checked {
    border-color: var(--accent);
  }

  .card.disabled {
    cursor: default;
    opacity: 0.5;
  }

  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .mark {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border: 1px solid var(--fg-muted);
    border-radius: 50%;
  }

  .checked .mark {
    border: 5px solid var(--accent);
  }

  .card:has(input:focus-visible) {
    box-shadow: var(--focus);
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .title {
    font-weight: 500;
    line-height: 20px;
  }

  .description {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }
</style>
