<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    title,
    id,
    description,
    children,
  }: {
    title?: string | undefined
    id?: string | undefined
    description?: string | undefined
    children: Snippet
  } = $props()
</script>

<section class="group" {id} aria-labelledby={title && id ? `${id}-title` : undefined}>
  {#if title}<h2 id={id ? `${id}-title` : undefined}>{title}</h2>{/if}
  {#if description}<p class="description">{description}</p>{/if}
  <div class="card">{@render children()}</div>
</section>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    scroll-margin-top: var(--space-6);
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 22px;
  }

  .description {
    margin: 0 0 var(--space-1);
    color: var(--fg-muted);
    line-height: 20px;
    user-select: text;
  }

  .card {
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
  }
</style>
