<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    tone = 'neutral',
    dot = false,
    title,
    children,
  }: {
    tone?: 'neutral' | 'ok' | 'caution' | 'danger' | 'record'
    /** Leading status dot in the tone colour. */
    dot?: boolean
    title?: string | undefined
    children: Snippet
  } = $props()
</script>

<span class="badge {tone}" {title}>
  {#if dot}<span class="dot" aria-hidden="true"></span>{/if}
  <span class="text">{@render children()}</span>
</span>

<style>
  .badge {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 6px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 18px;
    white-space: nowrap;
    max-width: 100%;
  }

  /* text-overflow does not reach text placed directly in a flex container. */
  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .ok {
    color: var(--ok);
  }

  .caution {
    border-color: color-mix(in srgb, var(--caution) 40%, transparent);
    color: var(--caution);
  }

  .danger {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
  }

  .record {
    border-color: color-mix(in srgb, var(--record) 40%, transparent);
    color: var(--record);
  }
</style>
