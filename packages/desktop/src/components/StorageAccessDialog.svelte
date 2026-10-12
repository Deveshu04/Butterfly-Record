<script lang="ts">
  import { errorMessage, openWindowsSecurity } from '../lib/ipc.ts'
  import { library } from '../lib/library.svelte.ts'
  import { storageAccess, type StoragePrompt } from '../lib/storage-access.svelte.ts'
  import Button from './Button.svelte'
  import Dialog from './Dialog.svelte'
  import { toasts } from './toasts.svelte.ts'

  const prompt = $derived(storageAccess.prompt)
  // The dialog stays mounted while it closes, so the browser can hand focus back to the opener.
  let shown = $state<StoragePrompt | null>(null)
  let open = $state(false)
  let busy = $state<'home' | 'choose' | 'retry' | null>(null)
  let error = $state<string | null>(null)
  let copied = $state(false)

  $effect(() => {
    if (prompt) {
      shown = prompt
      error = null
    }
    open = prompt !== null
  })

  const access = $derived(storageAccess.status)
  const ok = $derived(access?.ok ?? false)
  const samePath = (a: string, b: string) =>
    a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
  const homeRoot = $derived(
    access?.homeRoot && !samePath(access.homeRoot, access.root) ? access.homeRoot : null,
  )
  const RETRY_LABELS = { record: 'Start recording', import: 'Import video', notice: 'Done' } as const
  const retryLabel = $derived(shown?.retry ? RETRY_LABELS[shown.intent] : 'Done')

  async function switchFolder(kind: 'home' | 'choose') {
    const before = library.info?.root ?? null
    const hadVideos = library.items.length > 0
    busy = kind
    error = null
    try {
      if (kind === 'home') await library.useHomeRoot()
      else await library.changeRoot()
      const after = library.info?.root ?? null
      if (hadVideos && before && after && !samePath(before, after)) {
        toasts.push(`Earlier videos are still in ${before}. Switch back in Settings to see them.`, { timeout: 10000 })
      }
    } catch (failure) {
      error = errorMessage(failure)
    } finally {
      busy = null
    }
  }

  async function openSecurity() {
    error = null
    try {
      await openWindowsSecurity()
    } catch (failure) {
      error = errorMessage(failure)
    }
  }

  async function copyExe() {
    if (!access?.exePath) return
    try {
      await navigator.clipboard.writeText(access.exePath)
      copied = true
      setTimeout(() => (copied = false), 2000)
    } catch (failure) {
      error = errorMessage(failure)
    }
  }

  async function tryAgain() {
    busy = 'retry'
    error = null
    try {
      const result = await storageAccess.check()
      if (result && !result.ok) error = 'Windows is still blocking the folder. Check that the allowed app is the file shown above.'
    } finally {
      busy = null
    }
  }

  function finish() {
    const retry = shown?.retry ?? null
    storageAccess.close()
    retry?.()
  }
</script>

{#if shown}
  <Dialog
    bind:open
    width={560}
    title={ok ? 'Ready to save' : 'Butterfly Record can’t save here'}
    description={ok
      ? `New recordings and imports are saved to ${access?.root ?? 'the library folder'}.`
      : (access?.detail ?? 'Checking the library folder…')}
    onclose={() => storageAccess.close()}
  >
    {#if access && !ok}
      <p class="path">Library folder: <span class="selectable">{access.root}</span></p>

      <section>
        <h3>Save somewhere else</h3>
        <div class="actions">
          {#if homeRoot}
            <Button variant="primary" busy={busy === 'home'} disabled={busy !== null} title={homeRoot} onclick={() => switchFolder('home')}>
              Use {homeRoot}
            </Button>
          {/if}
          <Button busy={busy === 'choose'} disabled={busy !== null} onclick={() => switchFolder('choose')}>
            Choose another folder…
          </Button>
        </div>
      </section>

      {#if access.reason === 'blocked'}
        <section>
          <h3>Or allow Butterfly Record in Windows Security</h3>
          <ol>
            <li>
              <Button size="sm" icon="external" onclick={openSecurity}>Open Windows Security</Button>
              <span class="hint">If it opens elsewhere, go to Virus &amp; threat protection → Manage ransomware protection.</span>
            </li>
            <li>
              Choose <strong>Allow an app through Controlled folder access</strong> → <strong>Add an allowed app</strong> →
              <strong>Browse all apps</strong>. Windows may ask for administrator approval.
            </li>
            {#if access.exePath}
              <li>
                Select this file:
                <span class="file">
                  <code class="selectable">{access.exePath}</code>
                  <Button size="sm" onclick={copyExe}>{copied ? 'Copied' : 'Copy'}</Button>
                </span>
              </li>
            {/if}
            <li>Come back here and choose <strong>Try again</strong>.</li>
          </ol>
        </section>
      {/if}
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#snippet footer()}
      {#if ok}
        {#if shown?.retry}<Button onclick={() => storageAccess.close()}>Close</Button>{/if}
        <Button variant="primary" onclick={finish}>{retryLabel}</Button>
      {:else}
        <Button onclick={() => storageAccess.close()}>Close</Button>
        <Button icon="refresh" busy={busy === 'retry'} disabled={busy !== null} onclick={tryAgain}>
          Try again
        </Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .path {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    background: var(--bg-sunken);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .selectable {
    color: var(--fg);
    overflow-wrap: anywhere;
    user-select: text;
    cursor: text;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--hairline);
  }

  h3 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    line-height: 20px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .actions :global(.btn) {
    max-width: 100%;
  }

  ol {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding-left: var(--space-5);
    line-height: 20px;
  }

  li::marker {
    color: var(--fg-muted);
  }

  .hint {
    display: block;
    margin-top: var(--space-1);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  strong {
    font-weight: 600;
  }

  .file {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  code {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 18px;
  }

  .error {
    margin: 0;
    color: var(--danger);
    user-select: text;
  }
</style>
