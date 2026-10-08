<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Icon, type IconName } from '@butterfly-record/ui'

  let {
    icon,
    title,
    message,
    tone = 'default',
    compact = false,
    actions,
  }: {
    icon: IconName
    title?: string | undefined
    message: string
    tone?: 'default' | 'danger' | 'caution'
    compact?: boolean
    actions?: Snippet
  } = $props()
</script>

<div class="empty {tone}" class:compact>
  <span class="icon"><Icon name={icon} size={compact ? 20 : 24} /></span>
  {#if title}<h2>{title}</h2>{/if}
  <p>{message}</p>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    max-width: 400px;
    margin: 0 auto;
    padding: var(--space-8) var(--space-4);
    text-align: center;
  }

  .compact {
    padding: var(--space-6) var(--space-3);
  }

  .icon {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    color: var(--fg-muted);
  }

  .compact .icon {
    width: 40px;
    height: 40px;
    margin-bottom: var(--space-1);
  }

  .danger .icon {
    color: var(--danger);
  }

  .caution .icon {
    color: var(--caution);
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 22px;
  }

  p {
    margin: 0;
    color: var(--fg-muted);
    line-height: 20px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
</style>
