<script lang="ts">
  import { library, type VideoItem } from '../lib/library.svelte.ts'
  import { jobs } from '../lib/jobs.svelte.ts'
  import Button from '../components/Button.svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import Select from '../components/Select.svelte'
  import TextField from '../components/TextField.svelte'
  import VideoCard from '../components/VideoCard.svelte'
  import RenameDialog from './RenameDialog.svelte'
  import { confirmDialog } from '../components/confirm.svelte.ts'
  import { formatBytes, plural } from '../components/format.ts'
  import { menu, type MenuEntry } from '../components/menu.svelte.ts'
  import { href, navigate } from '../components/router.svelte.ts'
  import { toasts } from '../components/toasts.svelte.ts'

  type Sort = 'newest' | 'oldest' | 'name' | 'longest' | 'largest'

  let { filter }: { filter: 'all' | 'imported' } = $props()

  let query = $state('')
  let sort = $state<Sort>(readSort())
  let importing = $state(false)
  let renaming = $state<VideoItem | null>(null)

  function readSort(): Sort {
    try {
      const saved = localStorage.getItem('library.sort')
      if (saved === 'oldest' || saved === 'name' || saved === 'longest' || saved === 'largest') return saved
    } catch {
      // Storage can be unavailable; the default order is fine.
    }
    return 'newest'
  }

  function saveSort(value: Sort) {
    try {
      localStorage.setItem('library.sort', value)
    } catch {
      // Not worth surfacing: the order simply resets next launch.
    }
  }

  const SORTS: { value: Sort; label: string }[] = [
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' },
    { value: 'name', label: 'Name' },
    { value: 'longest', label: 'Longest' },
    { value: 'largest', label: 'Largest' },
  ]

  const scoped = $derived(filter === 'imported' ? library.items.filter((item) => item.imported) : library.items)

  const shown = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matches = needle
      ? scoped.filter(
          (item) =>
            item.title.toLocaleLowerCase().includes(needle) || item.description.toLocaleLowerCase().includes(needle),
        )
      : [...scoped]
    const by: Record<Sort, (a: VideoItem, b: VideoItem) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
      name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
      longest: (a, b) => (b.duration ?? 0) - (a.duration ?? 0),
      largest: (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0),
    }
    return matches.sort(by[sort])
  })

  const totalBytes = $derived(scoped.reduce((sum, item) => sum + (item.bytes ?? 0), 0))

  const runningJobs = $derived.by(() => {
    const map = new Map<string, (typeof jobs.list)[number]>()
    for (const job of jobs.list) if (job.state === 'running' && !map.has(job.videoId)) map.set(job.videoId, job)
    return map
  })

  async function importVideos() {
    importing = true
    try {
      const ids = await library.importFiles()
      if (ids.length === 1) navigate(href.video(ids[0]!))
      else if (ids.length > 1) toasts.push(`Imported ${plural(ids.length, 'video')}.`, { tone: 'ok' })
    } catch (error) {
      toasts.error(error)
    } finally {
      importing = false
    }
  }

  async function remove(item: VideoItem) {
    const confirmed = await confirmDialog.ask(
      item.external
        ? {
            title: 'Remove from library?',
            message: `“${item.title}” is removed from Butterfly Record. The file stays where it is on disk.`,
            confirmLabel: 'Remove',
          }
        : {
            title: 'Delete this video?',
            message: `“${item.title}” and its transcripts move to the Recycle Bin.`,
            confirmLabel: 'Delete',
            danger: true,
          },
    )
    if (!confirmed) return
    try {
      await library.remove(item.id)
    } catch (error) {
      toasts.error(error)
    }
  }

  async function reveal(item: VideoItem) {
    try {
      await library.reveal(item.id)
    } catch (error) {
      toasts.error(error)
    }
  }

  function entries(item: VideoItem): MenuEntry[] {
    return [
      { label: 'Open', icon: 'play', onSelect: () => navigate(href.video(item.id)) },
      { label: 'Rename', icon: 'pen', onSelect: () => (renaming = item) },
      {
        label: 'Show in folder',
        icon: 'folder-open',
        disabled: !item.mediaPath,
        onSelect: () => void reveal(item),
      },
      { kind: 'separator' },
      item.external
        ? { label: 'Remove from library', icon: 'close', onSelect: () => void remove(item) }
        : { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(item) },
    ]
  }

  function openMenu(item: VideoItem, event: MouseEvent | null, anchor: HTMLElement | null) {
    if (event) menu.openAt(event, entries(item), `Options for ${item.title}`)
    else if (anchor) menu.openFrom(anchor, entries(item), `Options for ${item.title}`)
  }
</script>

<div class="page">
  <header class="toolbar">
    <div class="heading">
      <h1>{filter === 'imported' ? 'Imported' : 'Library'}</h1>
      {#if scoped.length > 0}
        <p class="summary">{plural(scoped.length, 'video')} · {formatBytes(totalBytes)}</p>
      {/if}
    </div>
    <div class="tools">
      {#if scoped.length > 0}
        <TextField
          type="search"
          icon="search"
          placeholder="Search videos"
          label="Search videos"
          clearable
          bind:value={query}
          class="search"
        />
        <Select label="Sort videos" bind:value={sort} options={SORTS} onchange={saveSort} />
      {/if}
      <Button icon="import" busy={importing} onclick={importVideos}>Import video</Button>
    </div>
  </header>

  <div class="scroll">
    {#if library.loading && library.items.length === 0}
      <div class="grid" aria-busy="true" aria-label="Loading videos">
        {#each { length: 4 }, index (index)}
          <div class="skeleton"><span class="poster"></span><span class="line"></span><span class="line short"></span></div>
        {/each}
      </div>
    {:else if scoped.length === 0}
      {#if filter === 'imported'}
        <EmptyState
          icon="import"
          title="No imported videos"
          message="Bring in any video or audio file from this PC to transcribe, translate or dub it. The file stays where it is."
        >
          {#snippet actions()}
            <Button variant="primary" icon="import" busy={importing} onclick={importVideos}>Import video</Button>
          {/snippet}
        </EmptyState>
      {:else}
        <EmptyState
          icon="library"
          title="No videos yet"
          message="Your recordings and imported videos appear here, saved as files on this PC."
        >
          {#snippet actions()}
            <Button variant="primary" onclick={() => navigate(href.record())}>New recording</Button>
            <Button icon="import" busy={importing} onclick={importVideos}>Import video</Button>
          {/snippet}
        </EmptyState>
      {/if}
    {:else if shown.length === 0}
      <EmptyState icon="search" message="No videos match “{query.trim()}”.">
        {#snippet actions()}
          <Button onclick={() => (query = '')}>Clear search</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="grid">
        {#each shown as item (item.id)}
          <VideoCard {item} job={runningJobs.get(item.id)} onmenu={(event, anchor) => openMenu(item, event, anchor)} />
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if renaming}
  <RenameDialog item={renaming} onclose={() => (renaming = null)} />
{/if}

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3) var(--space-4);
    padding: var(--space-6) var(--space-6) var(--space-4);
  }

  .heading {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    min-width: 0;
  }

  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: 32px;
  }

  .summary {
    margin: 0;
    color: var(--fg-muted);
    white-space: nowrap;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .tools :global(.search) {
    width: 240px;
  }

  .scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    padding: var(--space-2) var(--space-6) var(--space-8);
    overflow-y: auto;
  }

  /* Empty and no-match states sit a little above the middle of the free space. */
  .scroll > :global(.empty) {
    margin: auto;
    padding-bottom: 12vh;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
    gap: var(--space-6) var(--space-5);
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .skeleton span {
    border-radius: var(--radius-sm);
    background: var(--fill-hover);
  }

  .skeleton .poster {
    border-radius: var(--radius-card);
    aspect-ratio: 16 / 9;
  }

  .skeleton .line {
    width: 70%;
    height: 12px;
  }

  .skeleton .short {
    width: 40%;
  }
</style>
