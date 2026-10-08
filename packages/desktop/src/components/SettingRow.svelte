<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Icon, type IconName } from '@butterfly-record/ui'

  let {
    label,
    description,
    icon,
    for: forId,
    labelId,
    stacked = false,
    children,
    below,
  }: {
    label: string
    description?: string | undefined
    icon?: IconName | undefined
    /** Id of the control, so clicking the label focuses it. */
    for?: string | undefined
    /** Id for the label text, for controls that use aria-labelledby. */
    labelId?: string | undefined
    /** Puts the control under the text instead of at the right. */
    stacked?: boolean
    children?: Snippet
    /** Full-width content under the row, such as a level meter. */
    below?: Snippet
  } = $props()
</script>

<div class="row" class:stacked>
  <div class="main">
    {#if icon}<span class="icon"><Icon name={icon} size={20} /></span>{/if}
    <div class="text">
      {#if forId}
        <label id={labelId} for={forId}>{label}</label>
      {:else}
        <span class="label" id={labelId}>{label}</span>
      {/if}
      {#if description}<p class="description">{description}</p>{/if}
    </div>
    {#if children}<div class="control">{@render children()}</div>{/if}
  </div>
  {#if below}<div class="below">{@render below()}</div>{/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 56px;
    padding: var(--space-3) var(--space-4);
    justify-content: center;
  }

  .row:not(:first-child) {
    border-top: 1px solid var(--hairline);
  }

  .main {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .stacked .main {
    flex-wrap: wrap;
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    color: var(--fg-muted);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  label,
  .label {
    line-height: 20px;
  }

  .description {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .control {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }

  .stacked .control {
    flex: 1 1 100%;
  }

  .below {
    padding-left: 0;
  }

  .row:has(.icon) .below {
    padding-left: calc(20px + var(--space-4));
  }
</style>
