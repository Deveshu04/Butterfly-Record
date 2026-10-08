<script lang="ts">
  import { untrack } from 'svelte'
  import { openPath } from '../../lib/ipc.ts'
  import { library, type VideoItem } from '../../lib/library.svelte.ts'
  import Button from '../../components/Button.svelte'
  import { confirmDialog } from '../../components/confirm.svelte.ts'
  import { formatBytes, formatClock, formatDateTime, formatResolution } from '../../components/format.ts'
  import { href, navigate } from '../../components/router.svelte.ts'
  import { sarvamKey } from '../../components/sarvam-key.svelte.ts'
  import { toasts } from '../../components/toasts.svelte.ts'
  import { latestJob, summarizeVideo } from './job-helpers.ts'

  let { item }: { item: VideoItem } = $props()

  const uid = $props.id()
  const NAMES: Record<string, string> = {
    webm: 'WebM',
    mp4: 'MP4',
    mov: 'QuickTime',
    mkv: 'Matroska',
    vp9: 'VP9',
    vp8: 'VP8',
    av1: 'AV1',
    h264: 'H.264',
    avc: 'H.264',
    hevc: 'H.265',
    opus: 'Opus',
    aac: 'AAC',
    mp3: 'MP3',
    flac: 'FLAC',
    vorbis: 'Vorbis',
    pcm: 'PCM',
  }

  const pretty = (value: string | null | undefined) => (value ? (NAMES[value.toLowerCase()] ?? value.toUpperCase()) : null)

  let draft = $state(untrack(() => item.description))
  let savedText = $state(untrack(() => item.description))
  let saving = $state(false)
  let saved = $state(false)

  // Pick up descriptions written elsewhere (Summarize) unless the user is mid-edit.
  $effect(() => {
    const incoming = item.description
    if (incoming !== savedText && draft === savedText) draft = incoming
    savedText = incoming
  })

  const summarizing = $derived(latestJob(item.id, 'summarize')?.state === 'running')
  const manifest = $derived(item.manifest)
  const recorded = $derived(manifest !== null && manifest.producer.app !== 'import')
  const video = $derived(manifest?.video)
  const audio = $derived(manifest?.audio)

  const fileRows = $derived(
    [
      ['Container', pretty(video?.container)],
      ['Video', [pretty(video?.codec), formatResolution(item.width, item.height), video?.frameRate ? `${Math.round(video.frameRate)} fps` : null].filter(Boolean).join(', ') || null],
      ['Audio', audio?.codec ? [pretty(audio.codec), audio.channels === 1 ? 'mono' : 'stereo'].join(', ') : null],
      ['Duration', item.duration !== null ? formatClock(item.duration) : null],
      ['Size', item.bytes !== null ? formatBytes(item.bytes) : null],
    ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0),
  )

  const sourceLabel = $derived(
    video ? (video.surface === 'window' ? `Window: ${video.sourceLabel}` : video.sourceLabel || 'Entire screen') : null,
  )
  const audioSources = $derived(
    audio && audio.tracks.length > 0
      ? audio.tracks.map((track) => (track.kind === 'mic' ? track.label : 'System audio')).join(', ')
      : 'None',
  )

  async function saveDescription() {
    if (draft === savedText || saving) return
    saving = true
    try {
      await library.setDescription(item.id, draft)
      savedText = draft
      saved = true
      setTimeout(() => (saved = false), 2000)
    } catch (error) {
      toasts.error(error)
    } finally {
      saving = false
    }
  }

  async function summarize() {
    if (draft !== savedText) await saveDescription()
    await summarizeVideo(item)
  }

  async function open() {
    if (!item.mediaPath) return
    try {
      await openPath(item.mediaPath)
    } catch (error) {
      toasts.error(error)
    }
  }

  async function reveal() {
    try {
      await library.reveal(item.id)
    } catch (error) {
      toasts.error(error)
    }
  }

  async function remove() {
    const confirmed = await confirmDialog.ask(
      item.external
        ? {
            title: 'Remove from library?',
            message: `“${item.title}” is removed from Butterfly Record, with its transcripts. The file stays where it is on disk.`,
            confirmLabel: 'Remove',
          }
        : {
            title: 'Delete this video?',
            message: `“${item.title}” and its transcripts move to the Recycle Bin. Dubbed copies and exported captions stay in the library folder.`,
            confirmLabel: 'Delete',
            danger: true,
          },
    )
    if (!confirmed) return
    try {
      await library.remove(item.id)
      navigate(href.library())
    } catch (error) {
      toasts.error(error)
    }
  }
</script>

<div class="panel">
  <section aria-labelledby="{uid}-description">
    <div class="section-head">
      <h3 id="{uid}-description"><label for="{uid}-text">Description</label></h3>
      {#if saved}<span class="status" role="status">Saved</span>{/if}
    </div>
    <textarea
      id="{uid}-text"
      bind:value={draft}
      rows="5"
      placeholder="Add a description"
      onblur={saveDescription}
      onkeydown={(event) => {
        if (event.key === 's' && event.ctrlKey) {
          event.preventDefault()
          void saveDescription()
        }
      }}
    ></textarea>
    {#if item.hasTranscript && sarvamKey.present}
      <div class="actions">
        <Button size="sm" icon="text" busy={summarizing} onclick={summarize}>Summarize from transcript</Button>
      </div>
    {/if}
  </section>

  <section aria-labelledby="{uid}-file">
    <h3 id="{uid}-file">File</h3>
    {#if item.mediaPath}
      <p class="path" title={item.mediaPath}>{item.mediaPath}</p>
      <div class="actions">
        <Button size="sm" icon="external" onclick={open}>Open</Button>
        <Button size="sm" icon="folder-open" onclick={reveal}>Show in folder</Button>
      </div>
    {:else}
      <p class="muted">No video file{item.status === 'needs-recovery' ? ' yet. Recover the recording to create one.' : '.'}</p>
    {/if}
    {#if fileRows.length > 0}
      <dl>
        {#each fileRows as [label, value] (label)}
          <dt>{label}</dt>
          <dd>{value}</dd>
        {/each}
      </dl>
    {/if}
  </section>

  {#if recorded && manifest}
    <section aria-labelledby="{uid}-recording">
      <h3 id="{uid}-recording">Recording</h3>
      <dl>
        <dt>Recorded</dt>
        <dd>{formatDateTime(item.createdAt)}</dd>
        {#if sourceLabel}
          <dt>Source</dt>
          <dd>{sourceLabel}</dd>
        {/if}
        <dt>Audio</dt>
        <dd>{audioSources}</dd>
        <dt>App</dt>
        <dd>Butterfly Record {manifest.producer.version}</dd>
      </dl>
    </section>
  {:else if manifest}
    <section aria-labelledby="{uid}-import">
      <h3 id="{uid}-import">Import</h3>
      <dl>
        <dt>Imported</dt>
        <dd>{formatDateTime(item.createdAt)}</dd>
      </dl>
    </section>
  {/if}

  <section class="danger-zone">
    {#if item.external}
      <Button variant="danger" size="sm" icon="close" onclick={remove}>Remove from library</Button>
      <p class="muted">The file on disk is not touched.</p>
    {:else}
      <Button variant="danger" size="sm" icon="trash" onclick={remove}>Delete file</Button>
      <p class="muted">Moves the video and its transcripts to the Recycle Bin.</p>
    {/if}
  </section>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-4);
    overflow-y: auto;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h3 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    line-height: 20px;
  }

  .status {
    color: var(--ok);
    font-size: var(--text-sm);
  }

  textarea {
    width: 100%;
    min-height: 96px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    line-height: 20px;
    resize: vertical;
    user-select: text;
  }

  textarea::placeholder {
    color: var(--fg-faint);
  }

  textarea:hover:not(:focus) {
    border-color: var(--fg-faint);
  }

  textarea:focus,
  textarea:focus-visible {
    border-bottom-color: var(--accent);
    outline: none;
    box-shadow: inset 0 -1px 0 var(--accent);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .path {
    margin: 0;
    color: var(--fg);
    font-size: var(--text-sm);
    line-height: 16px;
    overflow-wrap: anywhere;
    user-select: text;
    cursor: text;
  }

  dl {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 6px var(--space-3);
    margin: var(--space-1) 0 0;
  }

  dt {
    color: var(--fg-muted);
  }

  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .muted {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .danger-zone {
    align-items: flex-start;
    padding-top: var(--space-4);
    border-top: 1px solid var(--hairline);
  }
</style>
