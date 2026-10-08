<script lang="ts">
  import { onMount } from 'svelte'
  import {
    cleanFolderName,
    createFolder,
    deleteFolder,
    folderAndDescendants,
    folderTree,
    formatBytes,
    formatDuration,
    generatePoster,
    generatePreview,
    listFolders,
    listRecordings,
    listTrash,
    moveToFolder,
    readPoster,
    readPreview,
    readSource,
    renameFolder,
    storageBudget,
    writePoster,
    writePreview,
    type Folder,
    type LibraryEntry,
  } from '@butterfly-record/core'
  import {
    chooseFolder,
    copyToFolder,
    folderPermission,
    isOnlyInBrowser,
    loadFolder,
    needsFolderCopy,
    requestFolderPermission,
  } from '../../lib/recordings-folder.ts'
  import { dismissFolderPrompt, isFolderPromptDismissed } from '../../lib/save-destination.ts'
  import { isActive, onSessionChanged, readSession } from '../../lib/session.ts'

  const { onopen }: { onopen: (id: string) => void } = $props()

  type SortOrder = 'newest' | 'oldest' | 'longest' | 'largest' | 'name'

  let listed = $state<LibraryEntry[]>([])
  /** The take being recorded or finalized; it is not a library item yet. */
  let liveSessionId = $state<string | null>(null)
  const entries = $derived(
    liveSessionId === null
      ? listed
      : listed.filter((entry) => entry.manifest.id !== liveSessionId),
  )
  let posters = $state<Record<string, string>>({})
  let previews = $state<Record<string, string>>({})
  let hoveredId = $state<string | null>(null)
  let query = $state('')
  let sort = $state<SortOrder>('newest')
  let loading = $state(true)
  let used = $state(0)
  let available = $state(0)

  let folders = $state<Folder[]>([])
  let selectedFolder = $state<string | null>(null)
  let trashCount = $state(0)
  let creatingFolder = $state(false)
  let newFolderName = $state('')
  let renamingFolderId = $state<string | null>(null)
  let renameDraft = $state('')
  let menuOpenId = $state<string | null>(null)
  let confirmingFolder = $state<Folder | null>(null)
  let folderDialog: HTMLDialogElement | null = $state(null)

  let saveFolder = $state.raw<FileSystemDirectoryHandle | null>(null)
  let saveFolderGranted = $state(false)
  /** Hidden until the stored choice is known, so it never flashes. */
  let folderPromptDismissed = $state(true)
  /** Finished recordings to offer copying into the recordings folder. */
  let unsavedCount = $state(0)
  let copying = $state<{ done: number; total: number } | null>(null)
  let folderError = $state<string | null>(null)

  $effect(() => {
    if (confirmingFolder && folderDialog && !folderDialog.open) folderDialog.showModal()
  })

  const tree = $derived(folderTree(folders))

  const inFolder = $derived.by(() => {
    if (selectedFolder === null) return entries
    const wanted = folderAndDescendants(folders, selectedFolder)
    return entries.filter(
      (entry) => entry.manifest.folderId !== null && wanted.has(entry.manifest.folderId),
    )
  })

  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? inFolder.filter(
          (entry) =>
            entry.manifest.title.toLowerCase().includes(needle) ||
            entry.manifest.video.sourceLabel.toLowerCase().includes(needle),
        )
      : inFolder
    const sorted = [...matched]
    switch (sort) {
      case 'oldest':
        sorted.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt))
        break
      case 'longest':
        sorted.sort((a, b) => (b.manifest.duration ?? 0) - (a.manifest.duration ?? 0))
        break
      case 'largest':
        sorted.sort((a, b) => b.bytes - a.bytes)
        break
      case 'name':
        sorted.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title))
        break
      default:
        sorted.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
    }
    return sorted
  })

  const totalBytes = $derived(entries.reduce((sum, entry) => sum + entry.bytes, 0))

  const heading = $derived(
    selectedFolder === null
      ? 'All recordings'
      : (folders.find((folder) => folder.id === selectedFolder)?.name ?? 'All recordings'),
  )

  async function load() {
    loading = true
    const session = await readSession()
    liveSessionId = isActive(session) ? session.sessionId : null
    folderPromptDismissed = await isFolderPromptDismissed()
    await refresh()
    loading = false
  }

  /** Re-lists without the loading state, so the grid does not flash. */
  async function refresh() {
    ;[listed, folders] = await Promise.all([listRecordings(), listFolders()])
    trashCount = (await listTrash()).length

    const budget = await storageBudget()
    used = budget.usage
    available = budget.available

    await checkSaveFolder()
    queuePosters()
  }

  // Passes run one after another: each poster decodes a video, and parallel
  // decodes freeze the page.
  let posterPass: Promise<void> = Promise.resolve()

  function queuePosters() {
    posterPass = posterPass
      .then(async () => {
        for (const entry of entries) {
          if (entry.needsRecovery) continue
          await ensurePoster(entry)
        }
      })
      .catch(() => {})
  }

  async function checkSaveFolder() {
    try {
      saveFolder = await loadFolder()
      saveFolderGranted = saveFolder !== null && (await folderPermission(saveFolder)) === 'granted'
      unsavedCount = saveFolder ? (await unsavedEntries(saveFolderGranted)).length : 0
    } catch (error) {
      console.warn('[butterfly-record] could not read the recordings folder', error)
    }
  }

  /**
   * While the folder is reachable, only takes that never left the browser, such as a recovered
   * one or a copy that was interrupted; otherwise every take that is not in the folder.
   */
  async function unsavedEntries(granted: boolean): Promise<LibraryEntry[]> {
    const finished = entries.filter((entry) => !entry.needsRecovery)
    const check = granted ? isOnlyInBrowser : needsFolderCopy
    const pending = await Promise.all(
      finished.map((entry) => check(entry.manifest.id).catch(() => false)),
    )
    return finished.filter((_, index) => pending[index])
  }

  async function pickSaveFolder() {
    folderError = null
    try {
      const picked = await chooseFolder()
      if (!picked) return
      saveFolder = picked
      saveFolderGranted = (await folderPermission(picked)) === 'granted'
      unsavedCount = (await unsavedEntries(saveFolderGranted)).length
    } catch (error) {
      folderError = `Couldn’t use that folder: ${errorText(error)}`
    }
  }

  async function keepDownloads() {
    folderPromptDismissed = true
    await dismissFolderPrompt()
  }

  /** Asks again for the folder, then copies every recording that is not in it yet. */
  async function reconnectSaveFolder() {
    const folder = saveFolder
    if (!folder || copying) return
    const wasGranted = saveFolderGranted
    folderError = null
    try {
      // First, while the click still counts as a user gesture.
      if (!(await requestFolderPermission(folder))) {
        folderError = 'Chrome didn’t allow access to the folder.'
        return
      }
      saveFolderGranted = true

      const pending = await unsavedEntries(wasGranted)
      const failures: string[] = []
      let done = 0
      copying = { done, total: pending.length }
      for (const entry of pending) {
        try {
          await copyToFolder(folder, entry.manifest.id, entry.manifest.title)
        } catch (error) {
          failures.push(`${entry.manifest.title}: ${errorText(error)}`)
        }
        done++
        copying = { done, total: pending.length }
      }
      unsavedCount = failures.length
      if (failures.length > 0) {
        folderError = `${failures.length} of ${pending.length} couldn’t be copied. ${failures[0]}`
      }
    } catch (error) {
      folderError = errorText(error)
    } finally {
      copying = null
    }
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function ensurePoster(entry: LibraryEntry) {
    const id = entry.manifest.id
    if (posters[id]) return

    let blob: Blob | null = await readPoster(id)
    if (!blob) {
      try {
        // Edits can discard the cached poster; a pinned posterTime must still apply.
        const at = entry.manifest.posterTime
        blob = await generatePoster(await readSource(id), at === null ? {} : { at })
        if (blob) await writePoster(id, blob)
      } catch {
        return
      }
    }
    if (blob) posters = { ...posters, [id]: URL.createObjectURL(blob) }
  }

  // One preview generation at a time (each decodes and re-encodes a video);
  // a hover that finds the lock taken keeps showing the poster.
  let generatingPreview = false

  async function ensurePreview(entry: LibraryEntry) {
    const id = entry.manifest.id
    if (previews[id] || entry.needsRecovery) return

    let blob: Blob | null = await readPreview(id)
    if (!blob) {
      if (generatingPreview) return
      generatingPreview = true
      try {
        blob = await generatePreview(await readSource(id))
        if (blob) await writePreview(id, blob)
      } catch {
        return
      } finally {
        generatingPreview = false
      }
    }
    if (blob) previews = { ...previews, [id]: URL.createObjectURL(blob) }
  }

  function enterCard(entry: LibraryEntry) {
    hoveredId = entry.manifest.id
    void ensurePreview(entry)
  }

  async function addFolder() {
    const name = newFolderName.trim()
    creatingFolder = false
    newFolderName = ''
    if (!name) return
    await createFolder(cleanFolderName(name))
    folders = await listFolders()
  }

  function startRename(folder: Folder) {
    renamingFolderId = folder.id
    renameDraft = folder.name
  }

  async function commitRename() {
    const id = renamingFolderId
    renamingFolderId = null
    if (!id) return
    const name = renameDraft.trim()
    if (!name) return
    await renameFolder(id, name)
    folders = await listFolders()
  }

  async function confirmFolderDelete() {
    const folder = confirmingFolder
    if (!folder) return
    const parentId = folder.parentId
    const orphaned = new Set(await deleteFolder(folder.id))

    // deleteFolder leaves recordings (trashed included) pointing at removed ids;
    // re-file them to the parent.
    const everything = await listRecordings({ include: 'all' })
    for (const entry of everything) {
      const filed = entry.manifest.folderId
      if (filed !== null && orphaned.has(filed)) {
        await moveToFolder(entry.manifest.id, parentId)
      }
    }

    if (selectedFolder !== null && orphaned.has(selectedFolder)) selectedFolder = parentId
    folderDialog?.close()
    ;[listed, folders] = await Promise.all([listRecordings(), listFolders()])
  }

  function onFolderDialogClick(event: MouseEvent) {
    if (folderDialog && event.target === folderDialog) folderDialog.close()
  }

  async function moveEntry(entry: LibraryEntry, folderId: string | null) {
    menuOpenId = null
    await moveToFolder(entry.manifest.id, folderId)
    entry.manifest.folderId = folderId
  }

  function toggleMenu(event: MouseEvent, id: string) {
    event.stopPropagation()
    menuOpenId = menuOpenId === id ? null : id
  }

  function recordedOn(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  onMount(() => {
    void load()

    // A finished take joins the list once its session clears.
    const stopWatching = onSessionChanged((next, previous) => {
      if (next.phase === previous.phase && next.sessionId === previous.sessionId) return
      liveSessionId = isActive(next) ? next.sessionId : null
      void refresh()
    })

    return () => {
      stopWatching()
      for (const url of Object.values(posters)) URL.revokeObjectURL(url)
      for (const url of Object.values(previews)) URL.revokeObjectURL(url)
    }
  })
</script>

<svelte:window onclick={() => (menuOpenId = null)} />

<div class="page">
  <aside class="sidebar">
    <nav aria-label="Folders">
      <button
        class="nav-item"
        class:active={selectedFolder === null}
        onclick={() => (selectedFolder = null)}
      >
        All recordings
      </button>

      {#each tree as node (node.folder.id)}
        {#if renamingFolderId === node.folder.id}
          <input
            class="folder-input"
            style:margin-left={`${node.depth * 14}px`}
            bind:value={renameDraft}
            onblur={commitRename}
            onkeydown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') renamingFolderId = null
            }}
            aria-label="Folder name"
          />
        {:else}
          <div class="folder-row" style:padding-left={`${node.depth * 14}px`}>
            <button
              class="nav-item"
              class:active={selectedFolder === node.folder.id}
              onclick={() => (selectedFolder = node.folder.id)}
              ondblclick={() => startRename(node.folder)}
              title="Double-click to rename"
            >
              {node.folder.name}
            </button>
            <button
              class="folder-delete"
              onclick={() => (confirmingFolder = node.folder)}
              title="Delete folder"
              aria-label={`Delete folder ${node.folder.name}`}
            >
              ×
            </button>
          </div>
        {/if}
      {/each}

      {#if creatingFolder}
        <input
          class="folder-input"
          bind:value={newFolderName}
          onblur={addFolder}
          onkeydown={(event) => {
            if (event.key === 'Enter') addFolder()
            if (event.key === 'Escape') {
              newFolderName = ''
              creatingFolder = false
            }
          }}
          placeholder="Folder name"
          aria-label="New folder name"
        />
      {:else}
        <button class="nav-item faint-item" onclick={() => (creatingFolder = true)}>
          + New folder
        </button>
      {/if}

      <a class="nav-item trash-link" href="#/trash">
        Trash{trashCount > 0 ? ` (${trashCount})` : ''}
      </a>
    </nav>

    <div class="save-folder">
      <span class="save-folder-label">Recordings folder</span>
      {#if saveFolder}
        <span class="save-folder-name" title={saveFolder.name}>{saveFolder.name}</span>
        <span class="save-folder-actions">
          {#if !saveFolderGranted}
            <button class="link" onclick={reconnectSaveFolder} disabled={copying !== null}>
              Reconnect
            </button>
          {/if}
          <button class="link" onclick={pickSaveFolder} disabled={copying !== null}>Change</button>
        </span>
      {:else if !loading}
        <button class="link" onclick={pickSaveFolder}>Choose folder…</button>
      {/if}
    </div>

    <a class="licences" href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">
      Open-source licences
    </a>
  </aside>

  <main class="content">
    {#if !loading && !saveFolder && !folderPromptDismissed}
      <div class="banner">
        <p>Choose a folder so every recording is saved as a file you can find.</p>
        <div class="banner-actions">
          <button class="button primary" onclick={pickSaveFolder}>Choose folder</button>
          <button class="button" onclick={keepDownloads}>Keep using Downloads</button>
        </div>
      </div>
    {:else if copying || (saveFolder && unsavedCount > 0)}
      <div class="banner quiet">
        <p>Some recordings aren't in your folder yet.</p>
        <div class="banner-actions">
          <button class="button" onclick={reconnectSaveFolder} disabled={copying !== null}>
            {copying
              ? `Copying ${Math.min(copying.done + 1, copying.total)} of ${copying.total}…`
              : saveFolderGranted
                ? 'Copy to folder'
                : 'Reconnect folder'}
          </button>
        </div>
      </div>
    {/if}
    {#if folderError}
      <p class="folder-error" role="alert">{folderError}</p>
    {/if}

    <div class="toolbar">
      <h1>{heading}</h1>
      <select bind:value={sort} aria-label="Sort recordings">
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="longest">Longest</option>
        <option value="largest">Largest</option>
        <option value="name">Name</option>
      </select>
      <input
        type="search"
        placeholder="Search recordings…"
        bind:value={query}
        aria-label="Search recordings"
      />
    </div>

    {#if loading}
      <p class="empty">Reading the library…</p>
    {:else if entries.length === 0}
      <div class="empty">
        <p><strong>Nothing recorded yet.</strong></p>
        <p>
          Click the Butterfly Record button in Chrome's toolbar on any web page and
          press <em>Start Recording</em>. Everything you record stays on this machine.
        </p>
      </div>
    {:else if inFolder.length === 0}
      <p class="empty">Nothing in this folder yet.</p>
    {:else if visible.length === 0}
      <p class="empty">No recording matches “{query}”.</p>
    {:else}
      <ul class="grid">
        {#each visible as entry (entry.manifest.id)}
          <!-- Hover only drives the preview; every action on the card is a button. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            class="card"
            onpointerenter={() => enterCard(entry)}
            onpointerleave={() => (hoveredId = null)}
          >
            <button class="hit" onclick={() => onopen(entry.manifest.id)}>
              <span class="poster">
                {#if hoveredId === entry.manifest.id && previews[entry.manifest.id]}
                  <video src={previews[entry.manifest.id]} muted loop autoplay playsinline></video>
                {:else if posters[entry.manifest.id]}
                  <img src={posters[entry.manifest.id]} alt="" />
                {:else}
                  <span class="placeholder"></span>
                {/if}
                {#if entry.needsRecovery}
                  <span class="badge warn">Needs recovery</span>
                {:else}
                  <span class="badge">{formatDuration(entry.manifest.duration)}</span>
                {/if}
              </span>
              <span class="meta">
                <span class="title">{entry.manifest.title}</span>
                <span class="sub">
                  {recordedOn(entry.manifest.createdAt)} ·
                  {entry.manifest.video.height}p · {formatBytes(entry.bytes)}
                </span>
              </span>
            </button>

            <button
              class="more"
              onclick={(event) => toggleMenu(event, entry.manifest.id)}
              title="Move to folder"
              aria-label={`Move ${entry.manifest.title} to a folder`}
            >
              ⋯
            </button>

            {#if menuOpenId === entry.manifest.id}
              <div class="menu" role="menu">
                <span class="menu-label">Move to folder</span>
                <button
                  role="menuitem"
                  class:current={entry.manifest.folderId === null}
                  onclick={() => moveEntry(entry, null)}
                >
                  No folder
                </button>
                {#each tree as node (node.folder.id)}
                  <button
                    role="menuitem"
                    class:current={entry.manifest.folderId === node.folder.id}
                    style:padding-left={`${10 + node.depth * 12}px`}
                    onclick={() => moveEntry(entry, node.folder.id)}
                  >
                    {node.folder.name}
                  </button>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <footer>
      <span>{entries.length} recording{entries.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}</span>
      {#if available > 0}
        <span class="faint">{formatBytes(available)} free of {formatBytes(used + available)}</span>
      {/if}
    </footer>
  </main>
</div>

<dialog bind:this={folderDialog} onclose={() => (confirmingFolder = null)} onclick={onFolderDialogClick}>
  {#if confirmingFolder}
    <h2>Delete folder “{confirmingFolder.name}”?</h2>
    <p>
      Recordings inside are kept — they move out of the folder, and any
      subfolders move up a level. No video is deleted.
    </p>
    <div class="dialog-actions">
      <button onclick={() => folderDialog?.close()}>Keep it</button>
      <button class="danger-solid" onclick={confirmFolderDelete}>Delete folder</button>
    </div>
  {/if}
</dialog>

<style>
  .page {
    display: flex;
    align-items: flex-start;
    gap: 24px;
    max-width: 1180px;
    margin: 0 auto;
    padding: 20px;
  }

  .sidebar {
    position: sticky;
    top: 72px;
    width: 190px;
    flex-shrink: 0;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: block;
    width: 100%;
    min-width: 0;
    padding: 6px 10px;
    border: none;
    border-radius: var(--radius-card);
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nav-item:hover {
    background: var(--fill-hover);
  }

  .nav-item.active {
    background: var(--fill-hover);
    font-weight: 600;
  }

  .faint-item {
    color: var(--fg-muted);
  }

  .folder-row {
    display: flex;
    align-items: center;
  }

  .folder-row .nav-item {
    flex: 1;
  }

  .folder-delete {
    flex-shrink: 0;
    padding: 2px 7px;
    border: none;
    border-radius: var(--radius-card);
    background: none;
    color: var(--fg-faint);
    font: inherit;
    cursor: pointer;
    visibility: hidden;
  }

  .folder-row:hover .folder-delete {
    visibility: visible;
  }

  .folder-delete:hover {
    background: var(--fill-hover);
    color: var(--danger);
  }

  .folder-input {
    padding: 6px 10px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
  }

  .trash-link {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--hairline);
    border-radius: 0;
    color: var(--fg-muted);
  }

  .save-folder {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 16px;
    padding: 12px 10px 0;
    border-top: 1px solid var(--hairline);
    font-size: 12px;
  }

  .save-folder-label {
    color: var(--fg-faint);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .save-folder-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .save-folder-actions {
    display: flex;
    gap: 12px;
  }

  .licences {
    display: block;
    margin-top: 16px;
    padding: 0 10px;
    color: var(--fg-faint);
    font-size: 11px;
  }

  .licences:hover {
    color: var(--fg-muted);
  }

  .link {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: var(--fg-muted);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .link:hover:not(:disabled) {
    color: var(--fg);
  }

  .link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 16px;
    margin-bottom: 18px;
    padding: 12px 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
  }

  .banner.quiet {
    background: none;
    color: var(--fg-muted);
  }

  .banner p {
    flex: 1;
    min-width: 220px;
    margin: 0;
    line-height: 1.45;
  }

  .banner-actions {
    display: flex;
    gap: 8px;
  }

  .button {
    padding: 6px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  .button:hover:not(:disabled) {
    background: var(--fill-hover);
  }

  .button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .button.primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
  }

  .button.primary:hover {
    background: var(--accent-hover);
  }

  .folder-error {
    margin: 0 0 14px;
    color: var(--danger);
    font-size: 12px;
    line-height: 1.45;
  }

  .content {
    flex: 1;
    min-width: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }

  h1 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  select {
    padding: 7px 8px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
  }

  input[type='search'] {
    width: 220px;
    padding: 7px 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    position: relative;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    overflow: hidden;
    transition: border-color var(--motion);
  }

  .card:hover {
    border-color: var(--hairline-strong);
  }

  .hit {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .poster {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--bg-sunken);
  }

  .poster img,
  .poster video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .placeholder {
    display: block;
    width: 100%;
    height: 100%;
  }

  .badge {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--chrome-bg);
    color: var(--chrome-fg);
    font-family: var(--font-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .badge.warn {
    background: var(--caution);
    color: #141414;
    font-family: var(--font-ui);
  }

  .more {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 1px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--chrome-bg);
    color: var(--chrome-fg);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
    visibility: hidden;
  }

  .card:hover .more,
  .card:focus-within .more {
    visibility: visible;
  }

  .menu {
    position: absolute;
    top: 30px;
    right: 6px;
    z-index: 3;
    display: flex;
    flex-direction: column;
    min-width: 150px;
    max-height: 240px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-overlay);
    box-shadow: var(--shadow-pop);
  }

  .menu-label {
    padding: 4px 10px 5px;
    color: var(--fg-faint);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .menu button {
    padding: 5px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu button:hover {
    background: var(--fill-hover);
  }

  .menu button.current {
    font-weight: 600;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 11px 12px;
    border-top: 1px solid var(--hairline);
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

  .empty {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 460px;
    margin: 64px auto;
    color: var(--fg-muted);
    text-align: center;
    line-height: 1.55;
  }

  .empty p {
    margin: 0;
  }

  footer {
    display: flex;
    justify-content: space-between;
    margin-top: 28px;
    padding-top: 14px;
    border-top: 1px solid var(--hairline);
    color: var(--fg-muted);
    font-size: 12px;
  }

  .faint {
    color: var(--fg-faint);
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

  .dialog-actions button {
    padding: 7px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  .dialog-actions .danger-solid {
    border-color: transparent;
    background: var(--danger);
    color: #fff;
    font-weight: 600;
  }
</style>
