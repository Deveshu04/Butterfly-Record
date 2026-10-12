<script lang="ts">
  import { Icon } from '@butterfly-record/ui'
  import { storageAccess } from '../lib/storage-access.svelte.ts'
  import Button from './Button.svelte'

  const access = $derived(storageAccess.status)

  const text = $derived(
    access?.reason === 'blocked' && access.folderName
      ? `Windows Security is blocking saves to your ${access.folderName} folder. New recordings and imports can’t be saved.`
      : (access?.detail ?? ''),
  )
</script>

{#if access && !access.ok}
  <div class="notice" role="status">
    <Icon name="alert" size={16} />
    <p>{text}</p>
    <Button size="sm" onclick={() => storageAccess.open()}>Fix…</Button>
  </div>
{/if}

<style>
  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
  }

  .notice > :global(svg) {
    flex: none;
    color: var(--caution);
  }

  p {
    flex: 1;
    min-width: 0;
    margin: 0;
    line-height: 20px;
  }
</style>
