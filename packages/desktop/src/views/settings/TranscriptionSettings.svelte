<script lang="ts">
  import { onMount } from 'svelte'
  import { settings, type AppSettings } from '../../lib/settings.svelte.ts'
  import { gpu, speechModels } from '../../lib/whisper.svelte.ts'
  import {
    WHISPER_MODELS,
    downloadBytes,
    gpuName,
    transcriptionEngine,
    whisperBackend,
    type CachedModel,
  } from '../../lib/whisper-models.ts'
  import Button from '../../components/Button.svelte'
  import LanguageSelect from '../../components/LanguageSelect.svelte'
  import Select from '../../components/Select.svelte'
  import SettingGroup from '../../components/SettingGroup.svelte'
  import SettingRow from '../../components/SettingRow.svelte'
  import { confirmDialog } from '../../components/confirm.svelte.ts'
  import { formatBytes } from '../../components/format.ts'
  import { sarvamKey } from '../../components/sarvam-key.svelte.ts'
  import { toasts } from '../../components/toasts.svelte.ts'

  const uid = $props.id()
  const value = $derived(settings.value)
  const transcription = $derived(value.transcription)
  const backend = $derived(whisperBackend(transcription.processor, gpu.info))

  let removing = $state<string | null>(null)

  onMount(() => {
    void gpu.probe()
    void speechModels.refresh()
  })

  async function change(patch: (draft: AppSettings) => void) {
    try {
      await settings.update(patch)
    } catch (error) {
      toasts.error(error)
    }
  }

  const ENGINES = [
    { value: 'local' as const, label: 'On this device' },
    { value: 'sarvam' as const, label: 'Sarvam' },
  ]
  const PROCESSORS = [
    { value: 'auto' as const, label: 'Automatic (GPU when available)' },
    { value: 'cpu' as const, label: 'CPU only' },
  ]

  // Sizes are for the processor that will run the model, so they change with it.
  const models = $derived(
    WHISPER_MODELS.map((model) => ({
      value: model.id,
      label:
        `${model.name}, about ${formatBytes(downloadBytes(model, backend))}` +
        (model.needsGpu && backend === 'cpu' ? ', slow without a GPU' : ''),
    })),
  )

  const processorStatus = $derived.by(() => {
    if (!gpu.checked) return 'Checking for a GPU…'
    if (!gpu.info) return 'No compatible GPU was found, so transcription runs on the CPU.'
    const found = `GPU found: ${gpuName(gpu.info)}.`
    return transcription.processor === 'cpu' ? `${found} Not used while CPU only is selected.` : found
  })

  function modelName(entry: CachedModel): string {
    return entry.model ? `Whisper ${entry.model.name}` : entry.repo
  }

  async function remove(entry: CachedModel) {
    const confirmed = await confirmDialog.ask({
      title: `Delete ${modelName(entry)}?`,
      message: `This frees ${formatBytes(entry.bytes)}. The model downloads again the next time it is needed.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    removing = entry.repo
    try {
      await speechModels.remove(entry.repo)
    } catch (error) {
      toasts.error(error)
    } finally {
      removing = null
    }
  }
</script>

<SettingGroup
  title="Transcription"
  id="settings-transcription"
  description={sarvamKey.present
    ? 'Transcribe on this device with Whisper, or on Sarvam with your API key. On this device the audio never leaves this PC; the speech model downloads once from Hugging Face, after which no connection is needed.'
    : 'Transcription runs on this device with Whisper, and the audio never leaves this PC. The speech model downloads once from Hugging Face, after which no connection is needed.'}
>
  {#if sarvamKey.present}
    <SettingRow
      label="Default engine"
      description="You can still choose for each video when you start a transcription."
      for="{uid}-engine"
    >
      <Select
        id="{uid}-engine"
        value={transcriptionEngine(transcription.engine, true)}
        options={ENGINES}
        onchange={(engine) => change((draft) => (draft.transcription.engine = engine))}
      />
    </SettingRow>
  {/if}
  <SettingRow label="Spoken language" description="The default for new transcriptions." for="{uid}-language">
    <LanguageSelect
      id="{uid}-language"
      value={value.sarvam.sttLanguage}
      capability="stt"
      allowAuto
      onchange={(code) => change((draft) => (draft.sarvam.sttLanguage = code))}
    />
  </SettingRow>
  <SettingRow
    label="Speech model"
    description="Larger models are more accurate and slower. Large-v3 Turbo cannot translate into English."
    for="{uid}-model"
  >
    <Select
      id="{uid}-model"
      value={transcription.model}
      options={models}
      onchange={(model) => change((draft) => (draft.transcription.model = model))}
    />
  </SettingRow>
  <SettingRow label="Processor" description={processorStatus} for="{uid}-processor">
    <Select
      id="{uid}-processor"
      value={transcription.processor}
      options={PROCESSORS}
      onchange={(processor) => change((draft) => (draft.transcription.processor = processor))}
    />
  </SettingRow>
  <SettingRow label="Downloaded models" description="Kept in the app's own storage on this PC.">
    {#snippet below()}
      {#if speechModels.downloaded.length > 0}
        <ul class="models">
          {#each speechModels.downloaded as entry (entry.repo)}
            <li>
              <span class="name">{modelName(entry)}</span>
              <span class="size">{formatBytes(entry.bytes)}</span>
              <Button
                size="sm"
                icon="trash"
                busy={removing === entry.repo}
                disabled={speechModels.busy}
                title={speechModels.busy ? 'Available when no transcription is running on this device' : undefined}
                onclick={() => remove(entry)}
              >
                Delete
              </Button>
            </li>
          {/each}
        </ul>
      {:else if speechModels.loaded}
        <p class="none">None yet. The selected model downloads the first time you transcribe on this device.</p>
      {/if}
    {/snippet}
  </SettingRow>
</SettingGroup>

<style>
  .models {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-control);
    list-style: none;
  }

  .models li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 44px;
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  }

  .models li + li {
    border-top: 1px solid var(--hairline);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .none {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }
</style>
