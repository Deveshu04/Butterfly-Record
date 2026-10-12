<script lang="ts">
  import type { Transcript } from '@butterfly-record/core'
  import { errorMessage } from '../../lib/ipc.ts'
  import { estimateCost, jobs } from '../../lib/jobs.svelte.ts'
  import { canonicalLanguage, languageName } from '../../lib/languages.ts'
  import type { VideoItem } from '../../lib/library.svelte.ts'
  import { settings } from '../../lib/settings.svelte.ts'
  import { readTranscript } from '../../lib/transcripts.ts'
  import Button from '../../components/Button.svelte'
  import EmptyState from '../../components/EmptyState.svelte'
  import JobProgress from '../../components/JobProgress.svelte'
  import LanguageSelect from '../../components/LanguageSelect.svelte'
  import Select from '../../components/Select.svelte'
  import Switch from '../../components/Switch.svelte'
  import TextField from '../../components/TextField.svelte'
  import TranscriptList from '../../components/TranscriptList.svelte'
  import { plural } from '../../components/format.ts'
  import { menu } from '../../components/menu.svelte.ts'
  import { sarvamKey } from '../../components/sarvam-key.svelte.ts'
  import KeyRequired from './KeyRequired.svelte'
  import NeedsMedia from './NeedsMedia.svelte'
  import { captionExportEntries } from './caption-export.ts'
  import { latestJob, runAction, summarizeVideo } from './job-helpers.ts'

  let {
    item,
    currentTime,
    onseek,
    onshowdetails,
  }: {
    item: VideoItem
    currentTime: number
    onseek: (time: number) => void
    onshowdetails: () => void
  } = $props()

  const uid = $props.id()

  const job = $derived(latestJob(item.id, 'transcribe'))
  const summarizing = $derived(latestJob(item.id, 'summarize')?.state === 'running')
  const running = $derived(job?.state === 'running')

  // Re-read after any transcript-producing job for this video finishes.
  const revision = $derived(
    jobs.forVideo(item.id).filter((j) => j.state === 'done' && (j.kind === 'transcribe' || j.kind === 'translate'))
      .length,
  )

  let view = $state<string | null>(null)
  let transcript = $state<Transcript | null>(null)
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let query = $state('')

  $effect(() => {
    if (view !== null && !item.transcriptLanguages.includes(view)) view = null
  })

  $effect(() => {
    const id = item.id
    const language = view
    const has = item.hasTranscript
    void revision
    if (!has) {
      transcript = null
      return
    }
    let stale = false
    loading = true
    loadError = null
    readTranscript(id, language)
      .then((result) => {
        if (!stale) transcript = result
      })
      .catch((error: unknown) => {
        if (!stale) loadError = errorMessage(error)
      })
      .finally(() => {
        if (!stale) loading = false
      })
    return () => {
      stale = true
    }
  })

  let language = $state(settings.value.sarvam.sttLanguage)
  let english = $state(false)
  let diarize = $state(settings.value.sarvam.diarize)
  let speakers = $state<number | null>(null)

  /** A transcript can be redone: an auto-detected language is sometimes the wrong one. */
  let again = $state(false)
  const showForm = $derived(!item.hasTranscript || again)

  // A finished run, or a different video, replaces the form with the transcript again.
  $effect(() => {
    void item.id
    void revision
    again = false
  })

  function transcribeAgain() {
    language = canonicalLanguage(transcript?.language) ?? settings.value.sarvam.sttLanguage
    again = true
  }

  const SPEAKER_OPTIONS = [
    { value: null, label: 'Detect automatically' },
    ...Array.from({ length: 9 }, (_, index) => ({ value: index + 2, label: `${index + 2} speakers` })),
  ]

  const cost = $derived(item.duration ? estimateCost('transcribe', item.duration, 1, { diarize }) : null)

  async function transcribe() {
    await runAction(item.id, 'transcribe', () =>
      jobs.transcribe(item, {
        language,
        mode: english ? 'translate' : 'transcribe',
        diarize,
        numSpeakers: diarize ? speakers : null,
      }),
    )
  }


  const viewOptions = $derived([
    { value: null, label: `Original${transcript && view === null ? ` (${languageName(transcript.language)})` : ''}` },
    ...item.transcriptLanguages.map((code) => ({ value: code, label: languageName(code) })),
  ])

  function openExport(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    menu.openFrom(event.currentTarget, captionExportEntries(item, view), 'Export transcript')
  }
</script>

<div class="panel">
  {#if running && job}
    <div class="pad">
      <JobProgress {job} />
      <p class="note">You can keep working. The transcript appears here when it is ready.</p>
    </div>
  {:else if !item.hasTranscript && item.status !== 'ready'}
    <NeedsMedia status={item.status} action="Transcription" />
  {:else if showForm}
    {#if sarvamKey.present === false}
      <KeyRequired action="Transcription" />
    {:else}
      <form
        class="pad form"
        onsubmit={(event) => {
          event.preventDefault()
          void transcribe()
        }}
      >
        {#if job && job.state !== 'done'}<JobProgress {job} />{/if}
        {#if again}
          <p class="lead">Transcribe this video again. The current transcript is replaced; translations and dubs made from it are kept.</p>
        {:else}
          <p class="lead">Turn the speech in this video into a searchable transcript with timestamps.</p>
        {/if}

        <div class="field">
          <label for="{uid}-language">Spoken language</label>
          <LanguageSelect id="{uid}-language" bind:value={language} capability="stt" allowAuto wide />
        </div>

        <div class="toggle">
          <div class="toggle-text">
            <span id="{uid}-english">Translate to English</span>
            <span class="hint">Writes the transcript in English whatever language is spoken.</span>
          </div>
          <Switch bind:checked={english} labelledby="{uid}-english" />
        </div>

        <div class="toggle">
          <div class="toggle-text">
            <span id="{uid}-diarize">Speaker labels</span>
            <span class="hint">Marks who is speaking on each line.</span>
          </div>
          <Switch bind:checked={diarize} labelledby="{uid}-diarize" />
        </div>

        {#if diarize}
          <div class="field">
            <label for="{uid}-speakers">Number of speakers</label>
            <Select id="{uid}-speakers" bind:value={speakers} options={SPEAKER_OPTIONS} wide />
          </div>
        {/if}

        <div class="submit">
          <Button variant="primary" type="submit" wide disabled={sarvamKey.present === null}>
            {again ? 'Transcribe again' : 'Transcribe'}
          </Button>
          {#if again}
            <Button wide onclick={() => (again = false)}>Keep the current transcript</Button>
          {/if}
          <p class="cost">
            {#if cost}Estimated cost {cost} with Sarvam.{:else}Cost depends on the length of the video.{/if}
            The audio is uploaded to Sarvam for this job only.
          </p>
        </div>
      </form>
    {/if}
  {:else}
    <div class="toolbar">
      <TextField
        type="search"
        size="sm"
        icon="search"
        placeholder="Search transcript"
        label="Search transcript"
        clearable
        wide
        bind:value={query}
      />
      <Button size="sm" icon="download" aria-haspopup="menu" onclick={openExport}>Export</Button>
    </div>
    <div class="subbar">
      {#if item.transcriptLanguages.length > 0}
        <Select size="sm" label="Transcript language" bind:value={view} options={viewOptions} />
      {:else if transcript}
        <span>{languageName(transcript.language)}</span>
      {/if}
      {#if transcript}<span class="count">{plural(transcript.segments.length, 'line')}</span>{/if}
      {#if sarvamKey.present}
        <Button size="sm" variant="ghost" icon="text" busy={summarizing} onclick={() => summarizeVideo(item, onshowdetails)}>Summarize</Button>
        <Button size="sm" variant="ghost" icon="refresh" onclick={transcribeAgain}>Transcribe again</Button>
      {/if}
    </div>
    {#if loadError}
      <EmptyState icon="alert" tone="danger" compact message={loadError} />
    {:else if transcript && transcript.segments.length === 0}
      <EmptyState icon="text" compact message="No speech was found in this video." />
    {:else if transcript}
      <TranscriptList segments={transcript.segments} {currentTime} {query} {onseek} />
    {:else if !loading}
      <EmptyState icon="alert" compact message="The transcript file could not be read." />
    {/if}
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .pad {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    overflow-y: auto;
  }

  .lead {
    margin: 0;
    line-height: 20px;
  }

  .note {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field label {
    font-weight: 500;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .toggle-text {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

  .toggle-text > span:first-child {
    font-weight: 500;
    line-height: 20px;
  }

  .hint {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .submit {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-1);
  }

  .cost {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-3) var(--space-2);
  }

  .subbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-height: 28px;
    padding: 0 var(--space-3) var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--hairline);
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }

  .subbar > :global(:last-child) {
    margin-left: auto;
  }

  .count {
    font-variant-numeric: tabular-nums;
  }
</style>
