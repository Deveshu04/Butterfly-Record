<script lang="ts">
  // Uploads only on explicit request: the extension must make no unrequested network calls.
  import {
    ShareError,
    createShare,
    finalizeShare,
    readSource,
    testDestination,
    uploadShare,
    type LibraryEntry,
    type ShareDestination,
    type ShareHandle,
  } from '@butterfly-record/core'
  import { loadSettings, saveSettings, type Settings } from '../../lib/settings.ts'
  import { onMount } from 'svelte'

  const { entry }: { entry: LibraryEntry } = $props()

  let settings = $state<Settings | null>(null)
  let handle = $state<ShareHandle | null>(null)
  let uploading = $state(false)
  let progress = $state(0)
  let error = $state<string | null>(null)
  let copied = $state(false)
  let editing = $state(false)

  let password = $state('')
  let allowDownload = $state(true)
  let expiryDays = $state(0)

  const configured = $derived(
    settings?.shareDestination === 'server' &&
      settings.shareServerUrl.length > 0 &&
      settings.shareToken.length > 0,
  )

  function destination(): ShareDestination {
    return {
      serverUrl: settings!.shareServerUrl.replace(/\/+$/, ''),
      token: settings!.shareToken,
    }
  }

  async function upload() {
    if (!settings) return
    uploading = true
    error = null
    progress = 0

    try {
      const target = destination()
      if (!(await testDestination(target))) {
        throw new ShareError('Could not reach that server. Check the URL and that it is running.')
      }

      const created = await createShare(target, {
        id: entry.manifest.id,
        title: entry.manifest.title,
        ...(entry.manifest.duration !== null ? { duration: entry.manifest.duration } : {}),
        width: entry.manifest.video.width,
        height: entry.manifest.video.height,
        ...(password ? { password } : {}),
        ...(expiryDays > 0
          ? { expiresAt: new Date(Date.now() + expiryDays * 86_400_000).toISOString() }
          : {}),
        allowDownload,
      })
      // Shown immediately: the link is live before a byte has been uploaded.
      handle = created

      await uploadShare(target, created, await readSource(entry.manifest.id), {
        onProgress: (value) => (progress = value),
      })
      await finalizeShare(target, created, {
        title: entry.manifest.title,
        ...(entry.manifest.duration !== null ? { duration: entry.manifest.duration } : {}),
      })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      uploading = false
    }
  }

  async function copy() {
    if (!handle) return
    await navigator.clipboard.writeText(handle.shareUrl)
    copied = true
    setTimeout(() => (copied = false), 1600)
  }

  async function update(patch: Partial<Settings>) {
    settings = await saveSettings(patch)
  }

  onMount(() => {
    void loadSettings().then((loaded) => (settings = loaded))
  })
</script>

<section class="share">
  <h2>Share</h2>

  {#if !settings}
    <p class="muted">…</p>
  {:else if !configured || editing}
    <p class="muted">
      Butterfly Record keeps everything on this machine. To hand someone a link,
      run a <strong>butterfly-share</strong> server of your own and point the
      extension at it — see <code>packages/share-server</code>.
    </p>
    <div class="fields">
      <label>
        <span>Server URL</span>
        <input
          type="url"
          placeholder="https://share.example.com"
          value={settings.shareServerUrl}
          onchange={(event) =>
            update({ shareServerUrl: event.currentTarget.value, shareDestination: 'server' })}
        />
      </label>
      <label>
        <span>Upload token</span>
        <input
          type="password"
          placeholder="printed when the server starts"
          value={settings.shareToken}
          onchange={(event) =>
            update({ shareToken: event.currentTarget.value, shareDestination: 'server' })}
        />
      </label>
    </div>
    {#if configured}
      <button onclick={() => (editing = false)}>Done</button>
    {/if}
  {:else if handle}
    <div class="link">
      <input readonly value={handle.shareUrl} onfocus={(event) => event.currentTarget.select()} />
      <button onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
    {#if uploading}
      <p class="muted">
        Uploading {Math.round(progress * 100)}% — the link already works and will
        start playing as soon as this finishes.
      </p>
    {:else if !error}
      <p class="muted">Uploaded. Anyone with this link can watch it.</p>
    {/if}
  {:else}
    <div class="options">
      <label class="inline">
        <input type="checkbox" bind:checked={allowDownload} />
        <span>Allow downloads</span>
      </label>
      <label class="inline">
        <span>Expires</span>
        <select bind:value={expiryDays}>
          <option value={0}>Never</option>
          <option value={1}>1 day</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
        </select>
      </label>
      <label class="inline grow">
        <span>Password</span>
        <input type="password" placeholder="optional" bind:value={password} />
      </label>
    </div>
    <div class="actions">
      <button class="primary" onclick={upload} disabled={uploading}>
        {uploading ? 'Uploading…' : 'Upload and get a link'}
      </button>
      <button onclick={() => (editing = true)} disabled={uploading}>Change server</button>
    </div>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .share {
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid var(--hairline);
  }

  h2 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
  }

  .muted {
    margin: 0 0 10px;
    color: var(--fg-muted);
    line-height: 1.55;
  }

  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .fields,
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 12px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--fg-muted);
  }

  label.inline {
    flex-direction: row;
    align-items: center;
    gap: 7px;
  }

  label.grow {
    flex: 1;
    min-width: 160px;
  }

  input,
  select {
    padding: 7px 9px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }

  .fields input {
    min-width: 260px;
  }

  .link,
  .actions {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }

  .link input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  button {
    padding: 8px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: var(--fill-hover);
  }

  .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
  }

  .error {
    margin: 10px 0 0;
    color: var(--danger);
  }
</style>
