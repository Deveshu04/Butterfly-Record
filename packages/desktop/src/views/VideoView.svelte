<script lang="ts">
  import { tick } from 'svelte'
  import { convertFileSrc } from '@tauri-apps/api/core'
  import { Icon } from '@butterfly-record/ui'
  import type { DesktopOutput } from '../lib/ipc.ts'
  import { languageName } from '../lib/languages.ts'
  import { library } from '../lib/library.svelte.ts'
  import { captionText, readTranscript } from '../lib/transcripts.ts'
  import Button from '../components/Button.svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import ProgressBar from '../components/ProgressBar.svelte'
  import Select from '../components/Select.svelte'
  import Tabs from '../components/Tabs.svelte'
  import TextField from '../components/TextField.svelte'
  import { formatBytes, formatClock, formatDateTime, formatResolution, joinPath } from '../components/format.ts'
  import { href, navigate, type VideoTab } from '../components/router.svelte.ts'
  import { toasts } from '../components/toasts.svelte.ts'
  import DetailsPanel from './video/DetailsPanel.svelte'
  import DubPanel from './video/DubPanel.svelte'
  import Player from './video/Player.svelte'
  import TranscriptPanel from './video/TranscriptPanel.svelte'
  import TranslatePanel from './video/TranslatePanel.svelte'
  import { latestJob } from './video/job-helpers.ts'

  let { id, tab }: { id: string; tab: VideoTab } = $props()

  const item = $derived(library.get(id))

  let video: HTMLVideoElement | undefined = $state()
  let currentTime = $state(0)
  let renaming = $state(false)
  let draftTitle = $state('')
  let titleInput: HTMLInputElement | undefined = $state()
  let titleButton: HTMLButtonElement | undefined = $state()

  /** null = off, '' = the original transcript, otherwise a translation's language. */
  let captions = $state<string | null>(null)
  let captionsUrl = $state<string | null>(null)
  let captionsLanguage = $state('')
  /** The dubbed copy playing instead of the original. */
  let playingDub = $state<DesktopOutput | null>(null)
  /** What C turns captions back on to. */
  let lastCaptions: string | null = null

  const captionOptions = $derived([
    { value: null, label: 'Captions off' },
    ...(item?.hasTranscript ? [{ value: '', label: 'Original transcript' }] : []),
    ...(item?.transcriptLanguages ?? []).map((code) => ({ value: code, label: languageName(code) })),
  ])

  const sourceOptions = $derived([
    { value: '', label: 'Original audio' },
    ...(item?.outputs ?? [])
      .filter((output) => output.kind === 'dub')
      .map((output) => ({ value: output.path, label: `${languageName(output.language)} dub` })),
  ])

  $effect(() => {
    if (captions !== null && !captionOptions.some((option) => option.value === captions)) captions = null
  })

  // Captions are built from the transcript on demand rather than saved as .vtt files.
  $effect(() => {
    const selected = captions
    const videoId = id
    void item?.transcriptLanguages
    if (selected === null) {
      captionsUrl = null
      return
    }
    let url: string | null = null
    let stale = false
    readTranscript(videoId, selected || null)
      .then((transcript) => {
        if (stale || !transcript) return
        url = URL.createObjectURL(new Blob([captionText(transcript, 'vtt')], { type: 'text/vtt' }))
        captionsUrl = url
        captionsLanguage = (selected || transcript.language).split('-')[0] ?? ''
      })
      .catch((error: unknown) => {
        if (!stale) toasts.error(error)
      })
    return () => {
      stale = true
      if (url) URL.revokeObjectURL(url)
    }
  })

  const src = $derived.by(() => {
    if (!item) return null
    if (playingDub && library.info) return convertFileSrc(joinPath(library.info.root, playingDub.path))
    return item.mediaUrl
  })

  const aspect = $derived(item?.width && item.height ? item.width / item.height : 16 / 9)

  const meta = $derived(
    item
      ? [
          formatDateTime(item.createdAt),
          item.duration !== null ? formatClock(item.duration) : null,
          formatResolution(item.width, item.height),
          item.bytes !== null ? formatBytes(item.bytes) : null,
        ].filter((part): part is string => Boolean(part))
      : [],
  )

  const recoverJob = $derived(item ? latestJob(item.id, 'recover') : undefined)
  const translationCount = $derived(item?.transcriptLanguages.length ?? 0)
  const dubCount = $derived(item?.outputs.filter((output) => output.kind === 'dub').length ?? 0)

  const tabs = $derived<{ id: VideoTab; label: string; count?: number | undefined }[]>([
    { id: 'transcript', label: 'Transcript' },
    { id: 'translate', label: 'Translate', count: translationCount || undefined },
    { id: 'dub', label: 'Dub', count: dubCount || undefined },
    { id: 'details', label: 'Details' },
  ])

  function selectTab(next: VideoTab) {
    navigate(href.video(id, next), { replace: true })
  }

  function seek(time: number) {
    if (!video) return
    video.currentTime = time
    if (video.paused) void video.play().catch(() => {})
  }

  function startRename() {
    if (!item) return
    draftTitle = item.title
    renaming = true
    queueMicrotask(() => titleInput?.select())
  }

  async function commitRename() {
    if (!renaming || !item) return
    renaming = false
    const title = draftTitle.trim()
    if (!title || title === item.title) return
    try {
      await library.rename(item.id, title)
    } catch (error) {
      toasts.error(error)
    }
  }

  // Keyboard exits put focus back on the title; a blur means focus already moved elsewhere.
  async function renameKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      const done = commitRename()
      await tick()
      titleButton?.focus()
      await done
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      renaming = false
      await tick()
      titleButton?.focus()
    }
  }

  async function reveal() {
    if (!item) return
    try {
      await library.reveal(item.id)
    } catch (error) {
      toasts.error(error)
    }
  }

  async function recover() {
    if (!item) return
    try {
      await library.recover(item.id)
      toasts.push('Recording recovered.', { tone: 'ok' })
    } catch (error) {
      toasts.error(error)
    }
  }

  async function forget() {
    if (!item) return
    try {
      await library.remove(item.id)
      navigate(href.library())
    } catch (error) {
      toasts.error(error)
    }
  }

  function toggleCaptions() {
    if (captions !== null) {
      lastCaptions = captions
      captions = null
      return
    }
    const options = captionOptions.map((option) => option.value)
    if (lastCaptions !== null && options.includes(lastCaptions)) captions = lastCaptions
    else captions = options.find((value) => value !== null) ?? null
  }

  function playDub(output: DesktopOutput | null) {
    playingDub = output
  }
</script>

{#if !item}
  <div class="missing">
    {#if library.loading}
      <ProgressBar value={null} label="Loading" />
    {:else}
      <EmptyState icon="film" title="Video not found" message="It may have been deleted or moved out of the library.">
        {#snippet actions()}
          <Button onclick={() => navigate(href.library())}>Back to library</Button>
        {/snippet}
      </EmptyState>
    {/if}
  </div>
{:else}
  <div class="page">
    <header class="header">
      <a class="back" href={href.library()}>
        <Icon name="chevron-left" size={14} />
        Library
      </a>
      <div class="title-row">
        {#if renaming}
          <TextField
            bind:value={draftTitle}
            bind:element={titleInput}
            label="Video title"
            class="title-input"
            maxlength={200}
            onkeydown={renameKey}
            onblur={commitRename}
          />
        {:else}
          <h1>
            <button bind:this={titleButton} type="button" class="title" title="Rename" onclick={startRename}>
              <span class="title-text">{item.title}</span>
              <span class="pen" aria-hidden="true"><Icon name="pen" size={14} /></span>
            </button>
          </h1>
        {/if}
      </div>
      <p class="meta">
        {#each meta as part, index (index)}
          {#if index > 0}<span class="sep" aria-hidden="true">·</span>{/if}<span>{part}</span>
        {/each}
        {#if item.mediaPath}
          <span class="sep" aria-hidden="true">·</span>
          <button type="button" class="link" title={item.mediaPath} onclick={reveal}>Show in folder</button>
        {/if}
      </p>
    </header>

    <div class="body">
      <div class="stage">
        <div class="screen-wrap">
          <Player
            {src}
            poster={playingDub ? null : item.posterUrl}
            {captionsUrl}
            {captionsLanguage}
            {captionOptions}
            {captions}
            oncaptions={(value) => (captions = value)}
            {aspect}
            ontogglecaptions={toggleCaptions}
            bind:currentTime
            bind:video
            overlay={item.status === 'ready' ? undefined : unavailable}
          />
        </div>
        {#if item.status === 'ready' && sourceOptions.length > 1}
          <div class="player-bar">
            <Select
              size="sm"
              label="Audio"
              value={playingDub?.path ?? ''}
              options={sourceOptions}
              onchange={(path) => playDub(item.outputs.find((output) => output.path === path) ?? null)}
            />
          </div>
        {/if}
        {#if item.description}
          <p class="description">{item.description}</p>
        {/if}
      </div>

      <aside class="side" aria-label="Video tools">
        <Tabs {tabs} value={tab} onchange={selectTab} label="Video tools" idPrefix="video" />
        <div class="tab-panel" role="tabpanel" id="video-panel-{tab}" aria-labelledby="video-tab-{tab}">
          {#key tab}
            {#if tab === 'transcript'}
              <TranscriptPanel {item} {currentTime} onseek={seek} onshowdetails={() => selectTab('details')} />
            {:else if tab === 'translate'}
              <TranslatePanel
                {item}
                {captions}
                onshowcaptions={(language) => (captions = language)}
                onopentranscript={() => selectTab('transcript')}
              />
            {:else if tab === 'dub'}
              <DubPanel {item} playing={playingDub?.path ?? null} onplay={playDub} />
            {:else}
              <DetailsPanel {item} />
            {/if}
          {/key}
        </div>
      </aside>
    </div>
  </div>
{/if}

{#snippet unavailable()}
  {#if item?.status === 'needs-recovery'}
    <div class="state">
      <span class="state-icon caution"><Icon name="alert" size={20} /></span>
      <p class="state-title">This recording was interrupted</p>
      <p class="state-text">The captured video is still on disk. Recover it to rebuild a playable file.</p>
      {#if recoverJob?.state === 'running'}
        <div class="state-progress"><ProgressBar value={recoverJob.fraction} label="Recovering" /></div>
      {:else}
        <Button variant="primary" onclick={recover}>Recover recording</Button>
      {/if}
    </div>
  {:else if item?.status === 'recording'}
    <div class="state">
      <span class="state-icon record"><span class="dot"></span></span>
      <p class="state-title">Recording in progress</p>
      <p class="state-text">The video appears here when you stop recording.</p>
    </div>
  {:else}
    <div class="state">
      <span class="state-icon danger"><Icon name="alert" size={20} /></span>
      <p class="state-title">The video file is missing</p>
      <p class="state-text">It may have been moved, renamed or deleted outside Butterfly Record.</p>
      <Button onclick={forget}>Remove from library</Button>
    </div>
  {/if}
{/snippet}

<style>
  .missing {
    display: grid;
    height: 100%;
    padding: var(--space-8);
    place-items: center;
  }

  .missing :global([role='progressbar']) {
    width: 200px;
  }

  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4) var(--space-6) var(--space-4);
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    align-self: flex-start;
    height: 24px;
    margin-left: -6px;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .back:hover {
    background: var(--fill-hover);
    color: var(--fg);
  }

  .back:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  .title-row {
    display: flex;
    align-items: center;
    min-height: 36px;
  }

  h1 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    line-height: 28px;
  }

  .title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 100%;
    margin-left: -6px;
    padding: 2px 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: text;
  }

  .title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pen {
    flex: none;
    color: var(--fg-muted);
    opacity: 0;
  }

  .title:hover {
    border-color: var(--hairline);
  }

  .title:hover .pen,
  .title:focus-visible .pen {
    opacity: 1;
  }

  .title:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  .title-row :global(.title-input) {
    width: min(560px, 100%);
    margin-left: -6px;
  }

  .title-row :global(.title-input input) {
    height: 36px;
    padding: 0 6px;
    font-size: var(--text-xl);
    font-weight: 600;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 var(--space-2);
    margin: 0;
    color: var(--fg-muted);
    line-height: 20px;
  }

  .sep {
    color: var(--fg-faint);
  }

  .link {
    padding: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    text-decoration: underline;
    text-decoration-color: var(--hairline-strong);
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .link:hover {
    text-decoration-color: currentColor;
  }

  .link:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  .body {
    display: flex;
    flex: 1;
    gap: var(--space-4);
    min-height: 0;
    padding: 0 var(--space-6) var(--space-6);
  }

  .stage {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    min-height: 0;
  }

  .screen-wrap {
    display: flex;
    flex: 0 1 auto;
    min-height: 0;
  }

  .player-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .description {
    display: -webkit-box;
    flex: none;
    max-width: 72ch;
    margin: var(--space-2) 0 0;
    overflow: hidden;
    line-height: 20px;
    white-space: pre-line;
    user-select: text;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
  }

  .side {
    display: flex;
    flex: none;
    flex-direction: column;
    width: clamp(320px, 40%, 400px);
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
  }

  .tab-panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    max-width: 380px;
    padding: var(--space-6);
    text-align: center;
  }

  .state-icon {
    display: grid;
    width: 40px;
    height: 40px;
    margin-bottom: var(--space-1);
    place-items: center;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
  }

  .state-icon.caution {
    color: var(--caution);
  }

  .state-icon.danger {
    color: var(--danger);
  }

  .state-icon .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--record);
  }

  .state-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .state-text {
    margin: 0 0 var(--space-2);
    color: var(--fg-muted);
  }

  .state-progress {
    width: 200px;
  }
</style>
