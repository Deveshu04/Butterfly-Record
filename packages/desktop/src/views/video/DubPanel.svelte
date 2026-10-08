<script lang="ts">
  import type { Transcript } from '@butterfly-record/core'
  import type { DesktopOutput } from '../../lib/ipc.ts'
  import { estimateCost, jobs } from '../../lib/jobs.svelte.ts'
  import { LANGUAGES, TTS_SPEAKERS, languageName } from '../../lib/languages.ts'
  import { library, type VideoItem } from '../../lib/library.svelte.ts'
  import { settings } from '../../lib/settings.svelte.ts'
  import { readTranscript } from '../../lib/transcripts.ts'
  import Button from '../../components/Button.svelte'
  import Checkbox from '../../components/Checkbox.svelte'
  import IconButton from '../../components/IconButton.svelte'
  import JobProgress from '../../components/JobProgress.svelte'
  import RadioCards from '../../components/RadioCards.svelte'
  import Select from '../../components/Select.svelte'
  import Switch from '../../components/Switch.svelte'
  import { baseName, joinPath } from '../../components/format.ts'
  import { sarvamKey } from '../../components/sarvam-key.svelte.ts'
  import { toasts } from '../../components/toasts.svelte.ts'
  import KeyRequired from './KeyRequired.svelte'
  import NeedsMedia from './NeedsMedia.svelte'
  import { runAction } from './job-helpers.ts'

  type Method = 'sarvam-dubbing' | 'tts'

  let {
    item,
    playing,
    onplay,
  }: {
    item: VideoItem
    /** Path of the dub the player is showing, if any. */
    playing: string | null
    onplay: (output: DesktopOutput | null) => void
  } = $props()

  const uid = $props.id()

  let source = $state<Transcript | null>(null)
  let targets = $state<string[]>([])
  let method = $state<Method>('sarvam-dubbing')
  let numSpeakers = $state(-1)
  let upload = $state<'audio' | 'video'>('audio')
  let speaker = $state(settings.value.sarvam.ttsSpeaker)
  let keepOriginalAudio = $state(true)
  let consent = $state(false)

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

  $effect(() => {
    if (!item.hasTranscript && method === 'tts') method = 'sarvam-dubbing'
  })

  const sourceLanguage = $derived(source?.language ?? null)
  const choices = $derived(
    LANGUAGES.filter((language) => (method === 'tts' ? language.tts : language.dub) && language.code !== sourceLanguage),
  )

  // Drop picks the other method cannot produce.
  $effect(() => {
    const allowed = new Set(choices.map((language) => language.code))
    if (targets.some((code) => !allowed.has(code))) targets = targets.filter((code) => allowed.has(code))
  })

  const chars = $derived(source ? source.segments.reduce((sum, segment) => sum + segment.text.length, 0) : undefined)
  const cost = $derived(
    targets.length > 0 && item.duration
      ? estimateCost(method === 'tts' ? 'dub-tts' : 'dub-sarvam', item.duration, targets.length, chars === undefined ? {} : { chars })
      : null,
  )

  const dubJobs = $derived(jobs.forVideo(item.id).filter((job) => job.kind === 'dub' && job.state !== 'done'))
  const results = $derived(item.outputs.filter((output) => output.kind === 'dub'))
  const ready = $derived(
    targets.length > 0 && (method === 'tts' || consent),
  )

  const SPEAKER_OPTIONS = [
    { value: -1, label: 'Detect automatically' },
    ...Array.from({ length: 10 }, (_, index) => ({
      value: index + 1,
      label: index === 0 ? '1 speaker' : `${index + 1} speakers`,
    })),
  ]

  const VOICE_OPTIONS = TTS_SPEAKERS.map((voice) => ({
    value: voice.id,
    label: `${voice.name} (${voice.gender === 'female' ? 'female' : 'male'})`,
  }))

  function toggle(code: string, on: boolean) {
    targets = on ? [...targets, code] : targets.filter((existing) => existing !== code)
  }

  async function dub() {
    if (!ready) return
    const picked = [...targets]
    const ok = await runAction(item.id, 'dub', () =>
      jobs.dub(item, { targets: picked, method, numSpeakers, upload, speaker, keepOriginalAudio }),
    )
    if (ok) {
      targets = []
      consent = false
    }
  }

  function absolute(output: DesktopOutput): string | null {
    return library.info ? joinPath(library.info.root, output.path) : null
  }

  async function reveal(output: DesktopOutput) {
    const path = absolute(output)
    if (!path) return
    try {
      await library.revealPath(path)
    } catch (error) {
      toasts.error(error)
    }
  }
</script>

<div class="panel">
  {#if dubJobs.length > 0}
    <div class="jobs">
      {#each dubJobs as job (job.task)}
        <JobProgress {job} />
      {/each}
    </div>
  {/if}

  {#if results.length > 0}
    <section aria-labelledby="{uid}-results">
      <h3 id="{uid}-results">Dubbed copies</h3>
      <ul>
        {#each results as output (output.path)}
          {@const isPlaying = playing === output.path}
          <li>
            <div class="name">
              <span>{languageName(output.language)}</span>
              <span class="file" title={output.path}>{baseName(output.path)}</span>
            </div>
            <Button
              size="sm"
              variant={isPlaying ? 'secondary' : 'ghost'}
              icon={isPlaying ? 'stop' : 'play'}
              onclick={() => onplay(isPlaying ? null : output)}
            >
              {isPlaying ? 'Playing' : 'Play'}
            </Button>
            <IconButton
              icon="folder-open"
              size="sm"
              label="Show {languageName(output.language)} copy in folder"
              onclick={() => reveal(output)}
            />
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if item.status !== 'ready'}
    <NeedsMedia status={item.status} action="Dubbing" />
  {:else if sarvamKey.present === false}
    <KeyRequired action="Dubbing" />
  {:else}
    <form
      class="form"
      class:separated={results.length > 0 || dubJobs.length > 0}
      onsubmit={(event) => {
        event.preventDefault()
        void dub()
      }}
    >
      <p class="lead">Make a copy of this video with speech in another language. The original is not changed.</p>

      <fieldset>
        <legend>Languages</legend>
        <div class="languages">
          {#each choices as language (language.code)}
            <Checkbox checked={targets.includes(language.code)} onchange={(on) => toggle(language.code, on)}>
              {language.name}
            </Checkbox>
          {/each}
        </div>
      </fieldset>

      <fieldset>
        <legend>Method</legend>
        <RadioCards
          name="{uid}-method"
          label="Dubbing method"
          bind:value={method}
          options={[
            {
              value: 'sarvam-dubbing',
              label: 'Sarvam Dubbing',
              description: 'Keeps each speaker’s voice.',
            },
            {
              value: 'tts',
              label: 'Text-to-speech voice',
              description: item.hasTranscript
                ? 'Lower cost. Reads the translated transcript in one voice.'
                : 'Lower cost. Needs a transcript first.',
              disabled: !item.hasTranscript,
            },
          ]}
        />
      </fieldset>

      {#if method === 'sarvam-dubbing'}
        <div class="field">
          <label for="{uid}-speakers">Speakers</label>
          <Select id="{uid}-speakers" bind:value={numSpeakers} options={SPEAKER_OPTIONS} wide />
        </div>
        <fieldset>
          <legend>Upload</legend>
          <RadioCards
            name="{uid}-upload"
            label="What to upload"
            bind:value={upload}
            options={[
              { value: 'audio', label: 'Audio only', description: 'The video stays on this PC.' },
              { value: 'video', label: 'Full video', description: 'Uploads the whole file, picture included.' },
            ]}
          />
        </fieldset>
      {:else}
        <div class="field">
          <label for="{uid}-voice">Voice</label>
          <Select id="{uid}-voice" bind:value={speaker} options={VOICE_OPTIONS} wide />
        </div>
        <div class="toggle">
          <span id="{uid}-keep">Keep the original audio quietly underneath</span>
          <Switch bind:checked={keepOriginalAudio} labelledby="{uid}-keep" />
        </div>
      {/if}

      <div class="submit">
        {#if method === 'sarvam-dubbing'}
          <Checkbox bind:checked={consent}>I have the right to use the voices in this video.</Checkbox>
        {/if}
        <Button variant="primary" type="submit" wide disabled={!ready}>
          {targets.length > 1 ? `Dub into ${targets.length} languages` : 'Dub'}
        </Button>
        <p class="cost">
          {#if cost}Estimated cost {cost} with Sarvam.{:else}Choose at least one language.{/if}
        </p>
      </div>
    </form>
  {/if}

</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-4);
    overflow-y: auto;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .form.separated {
    padding-top: var(--space-5);
    border-top: 1px solid var(--hairline);
  }

  .lead {
    margin: 0;
    line-height: 20px;
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: none;
  }

  legend,
  .field label {
    padding: 0;
    margin-bottom: 6px;
    font-weight: 500;
  }

  .languages {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: var(--space-2) var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
  }

  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    font-weight: 500;
  }

  .submit {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .cost {
    margin: -4px 0 0;
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
    min-height: 52px;
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  }

  li + li {
    border-top: 1px solid var(--hairline);
  }

  .name {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .file {
    overflow: hidden;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
</style>
