<script lang="ts">
  import { onMount } from 'svelte'
  import {
    daysUntilPurge,
    deleteRecording,
    emptyTrash,
    formatBytes,
    formatDuration,
    listTrash,
    restoreRecording,
    TRASH_RETENTION_DAYS,
    type LibraryEntry,
  } from '@butterfly-record/core'

  const { onback }: { onback: () => void } = $props()

  let entries = $state<LibraryEntry[]>([])
  let loading = $state(true)
  let confirming = $state<{ kind: 'empty' } | { kind: 'one'; entry: LibraryEntry } | null>(null)
  let dialog: HTMLDialogElement | null = $state(null)

  $effect(() => {
    if (confirming && dialog && !dialog.open) dialog.showModal()
  })

  /** A click that lands on the dialog itself came from the backdrop. */
  function onDialogClick(event: MouseEvent) {
    if (dialog && event.target === dialog) dialog.close()
  }

  async function load() {
    entries = await listTrash()
    loading = false
  }

  function deletedAgo(iso: string | null): string {
    if (!iso) return 'Deleted'
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
    if (days <= 0) return 'Deleted today'
    return days === 1 ? 'Deleted 1 day ago' : `Deleted ${days} days ago`
  }

  function purgeIn(entry: LibraryEntry): string {
    const days = daysUntilPurge(entry.manifest)
    if (days <= 0) return 'purged on next visit'
    return days === 1 ? 'purged in 1 day' : `purged in ${days} days`
  }

  async function restore(id: string) {
    await restoreRecording(id)
    entries = entries.filter((entry) => entry.manifest.id !== id)
  }

  async function confirmDestroy() {
    if (!confirming) return
    if (confirming.kind === 'empty') await emptyTrash()
    else await deleteRecording(confirming.entry.manifest.id)
    dialog?.close()
    await load()
  }

  onMount(() => {
    void load()
  })
</script>

<div class="page">
  <div class="bar">
    <button class="back" onclick={onback}>‹ Library</button>
    <h1>Trash</h1>
    {#if entries.length > 0}
      <button class="danger" onclick={() => (confirming = { kind: 'empty' })}>
        Empty trash
      </button>
    {/if}
  </div>

  <p class="hint">
    Deleted recordings stay here for {TRASH_RETENTION_DAYS} days, then are
    removed for good.
  </p>

  {#if loading}
    <p class="empty">Reading the trash…</p>
  {:else if entries.length === 0}
    <p class="empty">The trash is empty.</p>
  {:else}
    <ul class="rows">
      {#each entries as entry (entry.manifest.id)}
        <li class="row">
          <div class="meta">
            <span class="title">{entry.manifest.title}</span>
            <span class="sub">
              {deletedAgo(entry.manifest.deletedAt)} · {purgeIn(entry)} ·
              {formatDuration(entry.manifest.duration)} · {formatBytes(entry.bytes)}
            </span>
          </div>
          <div class="actions">
            <button onclick={() => restore(entry.manifest.id)}>Restore</button>
            <button class="danger" onclick={() => (confirming = { kind: 'one', entry })}>
              Delete forever
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<dialog bind:this={dialog} onclose={() => (confirming = null)} onclick={onDialogClick}>
  {#if confirming?.kind === 'empty'}
    <h2>Empty the trash?</h2>
    <p>
      This permanently removes {entries.length}
      recording{entries.length === 1 ? '' : 's'} from your disk. This cannot be
      undone.
    </p>
  {:else if confirming?.kind === 'one'}
    <h2>Delete “{confirming.entry.manifest.title}” forever?</h2>
    <p>This permanently removes the video from your disk. This cannot be undone.</p>
  {/if}
  <div class="dialog-actions">
    <button onclick={() => dialog?.close()}>Keep it</button>
    <button class="danger-solid" onclick={confirmDestroy}>
      {confirming?.kind === 'empty' ? 'Empty trash' : 'Delete forever'}
    </button>
  </div>
</dialog>

<style>
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: 20px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  h1 {
    flex: 1;
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .hint {
    margin: 6px 0 18px;
    color: var(--fg-muted);
    font-size: 12px;
  }

  button {
    padding: 7px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  button:hover {
    background: var(--fill-hover);
  }

  .back {
    border-color: transparent;
    background: none;
    color: var(--fg-muted);
  }

  .danger {
    color: var(--danger);
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 14px;
  }

  .row + .row {
    border-top: 1px solid var(--hairline);
  }

  .meta {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }

  .title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    color: var(--fg-muted);
    font-size: 12px;
  }

  .actions {
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  }

  .empty {
    margin: 56px auto;
    max-width: 460px;
    color: var(--fg-muted);
    text-align: center;
    line-height: 1.55;
  }

  dialog {
    max-width: 400px;
    padding: 22px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--bg-overlay);
    color: var(--fg);
    box-shadow: var(--shadow-pop);
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }

  h2 {
    margin: 0 0 8px;
    font-size: 15px;
  }

  dialog p {
    margin: 0;
    color: var(--fg-muted);
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }

  .danger-solid {
    border-color: transparent;
    background: var(--danger);
    color: #fff;
    font-weight: 600;
  }
</style>
