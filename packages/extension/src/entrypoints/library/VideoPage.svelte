<script lang="ts">
  import { onMount } from 'svelte'
  import SharePanel from './SharePanel.svelte'
  import TranscriptPanel from './TranscriptPanel.svelte'
  import {
    folderPath,
    folderTree,
    formatBytes,
    formatDuration,
    generatePoster,
    invalidateDerived,
    listFolders,
    moveToFolder,
    readEntry,
    readSource,
    recoverRecording,
    renameRecording,
    safeFilenameWithExtension,
    setPosterTime,
    trashRecording,
    writePoster,
    type Folder,
    type LibraryEntry,
  } from '@butterfly-record/core'
  import {
    chooseFolder,
    copyToFolder,
    loadFolder,
    readSaved,
    requestFolderPermission,
    writeSaved,
    type SavedRecord,
  } from '../../lib/recordings-folder.ts'
  import { isActive, onSessionChanged, readSession } from '../../lib/session.ts'

  const { id, onback }: { id: string; onback: () => void } = $props()

  let entry = $state<LibraryEntry | null>(null)
  let folders = $state<Folder[]>([])
  let sourceUrl = $state<string | null>(null)
  let missing = $state(false)
  let renaming = $state(false)
  let draftTitle = $state('')
  let confirmingDelete = $state(false)
  let recovering = $state(false)
  let recoverProgress = $state(0)
  let recoverError = $state<string | null>(null)
  let video: HTMLVideoElement | null = $state(null)
  let deleteDialog: HTMLDialogElement | null = $state(null)
  /** Still being recorded or finalized; recovering it now would corrupt it. */
  let live = $state(false)
  let saved = $state<SavedRecord | null>(null)
  let savingToFolder = $state(false)
  let actionMessage = $state<{ text: string; error: boolean } | null>(null)
  /** Loaded up front, so a click reaches the permission prompt while it is still a user gesture. */
  let saveFolder: FileSystemDirectoryHandle | null = null

  $effect(() => {
    if (confirmingDelete && deleteDialog && !deleteDialog.open) deleteDialog.showModal()
  })

  /** A click that lands on the dialog itself came from the backdrop. */
  function onDialogClick(event: MouseEvent) {
    if (deleteDialog && event.target === deleteDialog) deleteDialog.close()
  }

  async function load() {
    const session = await readSession()
    live = isActive(session) && session.sessionId === id
    if (live) return

    const found = await readEntry(id)
    if (!found) {
      missing = true
      return
    }
    entry = found
    draftTitle = found.manifest.title
    folders = await listFolders()

    if (!found.needsRecovery) {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl)
      sourceUrl = URL.createObjectURL(await readSource(id))
    }

    saved = await readSaved(id).catch(() => null)
    saveFolder = await loadFolder().catch(() => null)
  }

  async function commitRename() {
    if (!entry) return
    const title = draftTitle.trim()
    renaming = false
    if (!title || title === entry.manifest.title) {
      draftTitle = entry.manifest.title
      return
    }
    await renameRecording(id, title)
    entry = { ...entry, manifest: { ...entry.manifest, title } }
  }

  /**
   * Uses its own URL: the player's is revoked when this page closes, mid-download.
   * `onComplete` gets the name Chrome settled on.
   */
  async function download(
    saveAs: boolean,
    onComplete: (name: string) => void = () => {},
  ): Promise<string> {
    const name = safeFilenameWithExtension(entry!.manifest.title, 'webm')
    const url = URL.createObjectURL(await readSource(id))
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename: `Butterfly Record/${name}`,
        saveAs,
        conflictAction: 'uniquify',
      })
      chrome.downloads.onChanged.addListener(function settled(delta) {
        if (delta.id !== downloadId) return
        const state = delta.state?.current
        if (state !== 'complete' && state !== 'interrupted') return
        chrome.downloads.onChanged.removeListener(settled)
        URL.revokeObjectURL(url)
        if (state !== 'complete') return
        void chrome.downloads.search({ id: downloadId }).then(([item]) => {
          onComplete(item?.filename.split(/[\\/]/).pop() ?? name)
        })
      })
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
    return name
  }

  async function exportFile() {
    if (!entry) return
    actionMessage = null
    try {
      await download(true)
    } catch (error) {
      // Dismissing the Save As dialog is not an error.
      if (!/cancel/i.test(errorText(error))) {
        actionMessage = { text: `Couldn’t export: ${errorText(error)}`, error: true }
      }
    }
  }

  async function saveToFolder() {
    if (!entry || savingToFolder) return
    actionMessage = null
    savingToFolder = true
    try {
      // The picker and the permission prompt both need this click's user gesture.
      let folder = saveFolder
      if (folder) {
        if (!(await requestFolderPermission(folder))) {
          actionMessage = { text: 'Chrome didn’t allow access to the folder.', error: true }
          return
        }
      } else {
        folder = await chooseFolder()
        if (!folder) return
        saveFolder = folder
      }
      saved = await copyToFolder(folder, id, entry.manifest.title)
      actionMessage = { text: `Saved to ${folder.name} as ${saved.name}`, error: false }
    } catch (error) {
      actionMessage = { text: `Couldn’t save to the folder: ${errorText(error)}`, error: true }
    } finally {
      savingToFolder = false
    }
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function remove() {
    await trashRecording(id)
    onback()
  }

  async function moveEntry(event: Event) {
    if (!entry) return
    const value = (event.currentTarget as HTMLSelectElement).value || null
    await moveToFolder(id, value)
    entry.manifest.folderId = value
  }

  let savingPoster = $state(false)
  let posterSaved = $state(false)

  /** The time is saved before regenerating, so the choice survives a failed regeneration. */
  async function useFrameAsThumbnail() {
    if (!video || !entry) return
    savingPoster = true
    posterSaved = false
    try {
      const at = video.currentTime
      await setPosterTime(id, at)
      const blob = await generatePoster(await readSource(id), { at })
      if (blob) await writePoster(id, blob)
      // Drop the stale poster so the library regenerates it at the pinned time.
      else await invalidateDerived(id)
      posterSaved = true
      setTimeout(() => (posterSaved = false), 2500)
    } finally {
      savingPoster = false
    }
  }

  async function recover() {
    recovering = true
    recoverError = null
    recoverProgress = 0
    actionMessage = null
    // Asked first, while the click still counts as a user gesture; the rebuild can take minutes.
    const folder = saveFolder
    const granted = folder ? await requestFolderPermission(folder).catch(() => false) : false
    try {
      await recoverRecording(id, (progress) => (recoverProgress = progress))
      // Re-read: recovery changes duration and size and creates the source file.
      entry = null
      await load()
    } catch (cause) {
      recoverError =
        cause instanceof Error
          ? `Could not rebuild this recording: ${cause.message}`
          : String(cause)
      return
    } finally {
      recovering = false
    }
    await saveRecovered(granted ? folder : null)
  }

  /** A recovered take is only in the browser until it is saved like a finished one. */
  async function saveRecovered(folder: FileSystemDirectoryHandle | null) {
    if (!entry) return
    try {
      if (folder) {
        saved = await copyToFolder(folder, id, entry.manifest.title)
        actionMessage = { text: `Recovered and saved to ${folder.name} as ${saved.name}`, error: false }
        return
      }
      const name = await download(false, (settled) => {
        void writeSaved(id, 'downloads', settled).then((record) => (saved = record))
      })
      actionMessage = {
        text: `Recovered and saved to Downloads/Butterfly Record as ${name}`,
        error: false,
      }
    } catch (error) {
      actionMessage = {
        text: `Recovered, but no copy was saved (${errorText(error)}). Use Save to folder or Export.`,
        error: true,
      }
    }
  }

  function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    // Space must press the focused dialog button, not toggle playback behind it.
    if (deleteDialog?.open) return
    if (!video) return

    const nudge = (seconds: number) => {
      video!.currentTime = Math.max(0, Math.min(video!.duration || 0, video!.currentTime + seconds))
      event.preventDefault()
    }

    switch (event.key.toLowerCase()) {
      case ' ':
      case 'k':
        video.paused ? void video.play() : video.pause()
        event.preventDefault()
        break
      case 'arrowright':
      case 'l':
        nudge(6)
        break
      case 'arrowleft':
      case 'j':
        nudge(-6)
        break
      case '.':
        nudge(1)
        break
      case ',':
        nudge(-1)
        break
      case 'm':
        video.muted = !video.muted
        break
      case 'f':
        void (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen())
        break
    }
  }

  onMount(() => {
    void load()
    window.addEventListener('keydown', onKey)

    const stopWatching = onSessionChanged((next) => {
      if (live && !(isActive(next) && next.sessionId === id)) void load()
    })

    return () => {
      stopWatching()
      window.removeEventListener('keydown', onKey)
      if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    }
  })

  function recordedOn(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
</script>

<div class="page">
  <div class="bar">
    <button class="back" onclick={onback}>‹ Library</button>

    {#if entry}
      {#if renaming}
        <input
          class="rename"
          bind:value={draftTitle}
          onblur={commitRename}
          onkeydown={(event) => {
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') {
              draftTitle = entry!.manifest.title
              renaming = false
            }
          }}
        />
      {:else}
        <button class="title" onclick={() => (renaming = true)} title="Rename">
          {entry.manifest.title}
        </button>
      {/if}

      <div class="actions">
        <button
          onclick={() => (window.location.hash = `#/v/${id}/edit`)}
          disabled={!sourceUrl}
        >
          Edit
        </button>
        <button onclick={saveToFolder} disabled={!sourceUrl || savingToFolder}>
          {savingToFolder ? 'Saving…' : 'Save to folder'}
        </button>
        <button onclick={exportFile} disabled={!sourceUrl}>Export</button>
        <button class="danger" onclick={() => (confirmingDelete = true)}>Delete</button>
      </div>
    {/if}
  </div>

  {#if actionMessage}
    <p class="action-message" class:error={actionMessage.error} role="status">
      {actionMessage.text}
    </p>
  {/if}

  {#if missing}
    <p class="notice">That recording no longer exists.</p>
  {:else if live}
    <div class="notice">
      <p><strong>This recording is still in progress.</strong></p>
      <p>It opens here once it has been saved.</p>
    </div>
  {:else if entry?.needsRecovery}
    <div class="notice">
      <p><strong>This recording was interrupted.</strong></p>
      <p>
        {formatBytes(entry.bytes)} of video is on disk but was never given its
        duration or seek index, so nothing will play it yet. Rebuilding the
        index recovers everything that was captured before the interruption.
      </p>
      {#if recoverError}
        <p class="recover-error">{recoverError}</p>
      {/if}
      <p>
        <button class="primary" onclick={recover} disabled={recovering}>
          {recovering ? `Rebuilding… ${Math.round(recoverProgress * 100)}%` : 'Recover this recording'}
        </button>
      </p>
    </div>
  {:else if entry && sourceUrl}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={video} src={sourceUrl} controls autoplay playsinline></video>

    <div class="player-tools">
      <button class="subtle" onclick={useFrameAsThumbnail} disabled={savingPoster}>
        {savingPoster
          ? 'Saving thumbnail…'
          : posterSaved
            ? 'Thumbnail updated'
            : 'Use this frame as thumbnail'}
      </button>
    </div>

    <dl class="details">
      <div><dt>Recorded</dt><dd>{recordedOn(entry.manifest.createdAt)}</dd></div>
      <div><dt>Length</dt><dd>{formatDuration(entry.manifest.duration)}</dd></div>
      <div>
        <dt>Resolution</dt>
        <dd>
          {entry.manifest.video.width}x{entry.manifest.video.height} ·
          {entry.manifest.video.frameRate} fps
        </dd>
      </div>
      <div><dt>Size</dt><dd>{formatBytes(entry.bytes)}</dd></div>
      <div>
        <dt>Format</dt>
        <dd>{entry.manifest.video.codec.toUpperCase()} / {entry.manifest.audio.codec}</dd>
      </div>
      <div><dt>Source</dt><dd>{entry.manifest.video.sourceLabel}</dd></div>
      {#if saved}
        <div>
          <dt>Saved to</dt>
          <dd class="saved-name">
            {saved.kind === 'folder' ? 'Recordings folder' : 'Downloads'} · {saved.name}
          </dd>
        </div>
      {/if}
      <div>
        <dt><label for="folder-pick">Folder</label></dt>
        <dd>
          <select id="folder-pick" value={entry.manifest.folderId ?? ''} onchange={moveEntry}>
            <option value="">No folder</option>
            {#each folderTree(folders) as node (node.folder.id)}
              <option value={node.folder.id}>
                {folderPath(folders, node.folder.id) || node.folder.name}
              </option>
            {/each}
          </select>
        </dd>
      </div>
      {#if entry.manifest.audio.tracks.length > 0}
        <div>
          <dt>Audio</dt>
          <dd>{entry.manifest.audio.tracks.map((track) => track.kind).join(' + ')}</dd>
        </div>
      {/if}
    </dl>

    <TranscriptPanel
      {entry}
      onseek={(time) => {
        if (video) {
          video.currentTime = time
          void video.play()
        }
      }}
      onretitle={(title) => {
        if (entry) entry = { ...entry, manifest: { ...entry.manifest, title } }
        draftTitle = title
      }}
    />

    <SharePanel {entry} />
  {:else}
    <p class="notice">Loading…</p>
  {/if}
</div>

<dialog bind:this={deleteDialog} onclose={() => (confirmingDelete = false)} onclick={onDialogClick}>
  {#if entry}
    <h2>Move “{entry.manifest.title}” to the Trash?</h2>
    <p>
      Moved to Trash, it stays there for 30 days and can be restored any time
      before then. Nothing is removed from your disk today.
    </p>
    <div class="dialog-actions">
      <button onclick={() => deleteDialog?.close()}>Keep it</button>
      <button class="danger-solid" onclick={remove}>Move to Trash</button>
    </div>
  {/if}
</dialog>

<style>
  .page {
    max-width: 1000px;
    margin: 0 auto;
    padding: 20px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
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

  button:hover:not(:disabled) {
    background: var(--fill-hover);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .back {
    border-color: transparent;
    background: none;
    color: var(--fg-muted);
  }

  .title {
    flex: 1;
    min-width: 0;
    border-color: transparent;
    background: none;
    font-size: 15px;
    font-weight: 600;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    font-size: 15px;
    font-weight: 600;
  }

  .danger {
    color: var(--danger);
  }

  .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
  }

  .recover-error {
    color: var(--danger);
  }

  .action-message {
    margin: -6px 0 14px;
    color: var(--fg-muted);
    font-size: 12px;
    text-align: right;
    overflow-wrap: anywhere;
  }

  .action-message.error {
    color: var(--danger);
  }

  .saved-name {
    overflow-wrap: anywhere;
  }

  .danger-solid {
    border-color: transparent;
    background: var(--danger);
    color: #fff;
    font-weight: 600;
  }

  video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: #000;
  }

  .player-tools {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .subtle {
    border-color: transparent;
    background: none;
    color: var(--fg-muted);
    font-size: 12px;
  }

  select {
    padding: 4px 6px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
  }

  .details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 14px 24px;
    margin: 20px 0 0;
  }

  .details div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  dt {
    color: var(--fg-faint);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 520px;
    margin: 56px auto;
    color: var(--fg-muted);
    text-align: center;
    line-height: 1.55;
  }

  .notice p {
    margin: 0;
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
</style>
