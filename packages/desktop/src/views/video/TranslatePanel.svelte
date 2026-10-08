<script lang="ts">
  import type { Transcript } from '@butterfly-record/core'
  import { estimateCost, jobs } from '../../lib/jobs.svelte.ts'
  import { LANGUAGES, languageName } from '../../lib/languages.ts'
  import type { VideoItem } from '../../lib/library.svelte.ts'
  import { settings } from '../../lib/settings.svelte.ts'
  import { readTranscript } from '../../lib/transcripts.ts'
  import Button from '../../components/Button.svelte'
  import EmptyState from '../../components/EmptyState.svelte'
  import IconButton from '../../components/IconButton.svelte'
  import JobProgress from '../../components/JobProgress.svelte'
  import LanguageSelect from '../../components/LanguageSelect.svelte'
  import { menu } from '../../components/menu.svelte.ts'
  import { sarvamKey } from '../../components/sarvam-key.svelte.ts'
  import KeyRequired from './KeyRequired.svelte'
  import { captionExportEntries } from './caption-export.ts'
  import { runAction } from './job-helpers.ts'

  let {
    item,
    captions,
    onshowcaptions,
    onopentranscript,
  }: {
    item: VideoItem
    /** Language currently shown as captions: null = off, '' = original. */
    captions: string | null
    onshowcaptions: (language: string | null) => void
    onopentranscript: () => void
  } = $props()

  const uid = $props.id()
  const model = $derived(settings.value.sarvam.translateModel)
  const capability = $derived(model === 'mayura:v1' ? 'mayura' : 'translate')

  let source = $state<Transcript | null>(null)
  let target = $state<string | null>(null)

  $effect(() => {
    const id = item.id
    if (!item.hasTranscript) {
      source = null
      return
    }
    let stale = false
    readTranscript(id)
      .then((result) => {
        if (!stale) source = result
      })
      .catch(() => {
        if (!stale) source = null
      })
    return () => {
      stale = true
    }
  })

  const sourceLanguage = $derived(source?.language ?? null)
  const chars = $derived(source ? source.segments.reduce((sum, segment) => sum + segment.text.length, 0) : 0)
  const cost = $derived(source ? estimateCost('translate', item.duration ?? 0, 1, { chars }) : null)

  const translateJobs = $derived(
    jobs.forVideo(item.id).filter((job) => job.kind === 'translate' && job.state !== 'done'),
  )
  const busyLanguages = $derived(
    new Set(translateJobs.filter((job) => job.state === 'running').map((job) => job.language)),
  )

  const exclude = $derived([...(sourceLanguage ? [sourceLanguage] : []), ...busyLanguages].filter(
    (code): code is string => typeof code === 'string',
  ))

  function nativeName(code: string): string {
    return LANGUAGES.find((language) => language.code === code)?.native ?? ''
  }

  async function translate() {
    const language = target
    if (!language) return
    const ok = await runAction(item.id, 'translate', () => jobs.translate(item, language))
    if (ok && target === language) target = null
  }

  function openExport(event: MouseEvent & { currentTarget: HTMLButtonElement }, language: string) {
    menu.openFrom(event.currentTarget, captionExportEntries(item, language), `Export ${languageName(language)} subtitles`)
  }
</script>

<div class="panel">
  {#if !item.hasTranscript}
    <EmptyState
      icon="translate"
      compact
      title="Transcribe first"
      message="Subtitles in other languages are translated from the transcript."
    >
      {#snippet actions()}
        <Button onclick={onopentranscript}>Go to Transcript</Button>
      {/snippet}
    </EmptyState>
  {:else if sarvamKey.present === false}
    <KeyRequired action="Translation" />
  {:else}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault()
        void translate()
      }}
    >
      <p class="lead">
        Create subtitles in another language{sourceLanguage ? ` from the ${languageName(sourceLanguage)} transcript` : ''}.
        Timing and speakers stay the same.
      </p>
      <div class="field">
        <label for="{uid}-target">Translate into</label>
        <div class="row">
          <LanguageSelect id="{uid}-target" bind:value={target} {capability} {exclude} wide />
          <Button variant="primary" type="submit" disabled={!target}>Translate</Button>
        </div>
      </div>
      {#if cost}<p class="cost">Estimated cost {cost} with Sarvam.</p>{/if}
    </form>
  {/if}

  {#if translateJobs.length > 0}
    <div class="jobs">
      {#each translateJobs as job (job.task)}
        <JobProgress {job} />
      {/each}
    </div>
  {/if}

  {#if item.transcriptLanguages.length > 0}
    <section class="list" aria-labelledby="{uid}-existing">
      <h3 id="{uid}-existing">Subtitles</h3>
      <ul>
        {#each item.transcriptLanguages as language (language)}
          {@const showing = captions === language}
          <li>
            <div class="name">
              <span>{languageName(language)}</span>
              {#if nativeName(language) && nativeName(language) !== languageName(language)}
                <span class="native">{nativeName(language)}</span>
              {/if}
            </div>
            <Button
              size="sm"
              variant={showing ? 'secondary' : 'ghost'}
              icon="captions"
              aria-pressed={showing}
              onclick={() => onshowcaptions(showing ? null : language)}
            >
              {showing ? 'Showing' : 'Show on video'}
            </Button>
            <IconButton
              icon="download"
              size="sm"
              label="Export {languageName(language)} subtitles"
              aria-haspopup="menu"
              onclick={(event) => openExport(event, language)}
            />
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    overflow-y: auto;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .lead {
    margin: 0;
    line-height: 20px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field label {
    font-weight: 500;
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  .row > :global(:first-child) {
    flex: 1;
    min-width: 0;
  }

  .cost {
    margin: -8px 0 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .jobs {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
    font-weight: 600;
  }

  ul {
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 48px;
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  }

  li + li {
    border-top: 1px solid var(--hairline);
  }

  .name {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }

  .native {
    overflow: hidden;
    color: var(--fg-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
