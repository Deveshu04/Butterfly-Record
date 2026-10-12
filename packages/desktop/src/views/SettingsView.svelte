<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { getVersion } from '@tauri-apps/api/app'
  import { Icon } from '@butterfly-record/ui'
  import { jobs } from '../lib/jobs.svelte.ts'
  import { TTS_SPEAKERS } from '../lib/languages.ts'
  import { library } from '../lib/library.svelte.ts'
  import { listMicrophones, recorder } from '../lib/recorder.svelte.ts'
  import { settings, type AppSettings } from '../lib/settings.svelte.ts'
  import Button from '../components/Button.svelte'
  import Dialog from '../components/Dialog.svelte'
  import Select from '../components/Select.svelte'
  import SettingGroup from '../components/SettingGroup.svelte'
  import SettingRow from '../components/SettingRow.svelte'
  import StorageNotice from '../components/StorageNotice.svelte'
  import Switch from '../components/Switch.svelte'
  import TextField from '../components/TextField.svelte'
  import { confirmDialog } from '../components/confirm.svelte.ts'
  import { baseName, formatBytes } from '../components/format.ts'
  import { sarvamKey } from '../components/sarvam-key.svelte.ts'
  import { toasts } from '../components/toasts.svelte.ts'
  import TranscriptionSettings from './settings/TranscriptionSettings.svelte'

  let { section }: { section: string | null } = $props()

  const uid = $props.id()
  const value = $derived(settings.value)

  let version = $state('')
  let microphones = $state<{ id: string; label: string }[]>([])
  let microphonesLoaded = $state(false)
  let keyDraft = $state('')
  let savingKey = $state(false)
  let testingKey = $state(false)
  let changingRoot = $state(false)
  let noticesOpen = $state(false)
  let notices = $state<string | null>(null)

  async function loadMicrophones() {
    try {
      microphones = await listMicrophones()
      microphonesLoaded = true
    } catch {
      microphones = []
    }
  }

  onMount(() => {
    getVersion()
      .then((v) => (version = v))
      .catch(() => (version = ''))
    if (value.recording.microphoneEnabled) void loadMicrophones()
    const refresh = () => {
      if (settings.value.recording.microphoneEnabled) void loadMicrophones()
    }
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  })

  /** Moving the library mid-recording or mid-recovery would split the files across two folders. */
  const rootBusy = $derived(
    recorder.phase !== 'idle' ||
      jobs.list.some((job) => job.state === 'running' && (job.kind === 'recover' || job.kind === 'import')),
  )

  $effect(() => {
    const target = section
    if (!target) return
    void tick().then(() => document.getElementById(`settings-${target}`)?.scrollIntoView({ block: 'start' }))
  })

  async function change(patch: (draft: AppSettings) => void) {
    try {
      await settings.update(patch)
    } catch (error) {
      toasts.error(error)
    }
  }

  async function saveKey(event: SubmitEvent) {
    event.preventDefault()
    const key = keyDraft.trim()
    if (!key) return
    savingKey = true
    try {
      await sarvamKey.save(key)
      keyDraft = ''
      testingKey = true
      await sarvamKey.test()
    } catch (error) {
      toasts.error(error)
    } finally {
      savingKey = false
      testingKey = false
    }
  }

  async function testKey() {
    testingKey = true
    try {
      await sarvamKey.test()
    } catch (error) {
      toasts.error(error)
    } finally {
      testingKey = false
    }
  }

  async function removeKey() {
    const confirmed = await confirmDialog.ask({
      title: 'Remove the Sarvam key?',
      message: 'Translation, dubbing, summaries and transcription on Sarvam stop working until you add a key again. Transcription on this device keeps working.',
      confirmLabel: 'Remove key',
      danger: true,
    })
    if (!confirmed) return
    try {
      await sarvamKey.clear()
    } catch (error) {
      toasts.error(error)
    }
  }

  async function changeRoot() {
    const before = library.info?.root ?? null
    if (before && library.items.length > 0) {
      const confirmed = await confirmDialog.ask({
        title: 'Change the library folder?',
        message: `Videos already in ${before} stay there and are not listed while another folder is selected. Switch back at any time to see them again.`,
        confirmLabel: 'Choose folder',
      })
      if (!confirmed) return
    }
    changingRoot = true
    try {
      await library.changeRoot()
      const after = library.info?.root ?? null
      if (before && after && after.toLowerCase() !== before.toLowerCase()) {
        toasts.push(`New videos are saved in ${baseName(after)}. Earlier videos are still in ${before}.`, {
          tone: 'ok',
          timeout: 10000,
        })
      }
    } catch (error) {
      toasts.error(error)
    } finally {
      changingRoot = false
    }
  }

  async function openRoot() {
    try {
      await library.openFolder()
    } catch (error) {
      toasts.error(error)
    }
  }

  const THEMES = [
    { value: 'system' as const, label: 'Use Windows setting' },
    { value: 'light' as const, label: 'Light' },
    { value: 'dark' as const, label: 'Dark' },
  ]
  const SCOPES = [
    { value: 'screen' as const, label: 'Screen' },
    { value: 'window' as const, label: 'Window' },
  ]
  const QUALITY = [
    { value: '720p' as const, label: '720p' },
    { value: '1080p' as const, label: '1080p' },
    { value: '1440p' as const, label: '1440p' },
    { value: '2160p' as const, label: '2160p (4K)' },
  ]
  const FRAME_RATES = [
    { value: 30 as const, label: '30 fps' },
    { value: 60 as const, label: '60 fps' },
  ]
  const STT_MODELS = [
    { value: 'saaras:v4' as const, label: 'Saaras v4 (recommended)' },
    { value: 'saaras:v3' as const, label: 'Saaras v3' },
  ]
  const TRANSLATE_MODELS = [
    { value: 'sarvam-translate:v1' as const, label: 'Sarvam Translate (all languages)' },
    { value: 'mayura:v1' as const, label: 'Mayura (11 languages)' },
  ]
  const VOICES = TTS_SPEAKERS.map((voice) => ({
    value: voice.id,
    label: `${voice.name} (${voice.gender})`,
  }))

  /** The saved device is gone; recordings use the system default instead. */
  const missingMic = $derived(
    microphonesLoaded &&
      value.recording.microphoneId !== null &&
      !microphones.some((mic) => mic.id === value.recording.microphoneId),
  )

  const microphoneOptions = $derived([
    { value: null, label: 'System default' },
    ...(missingMic
      ? [{ value: value.recording.microphoneId, label: 'Unavailable device (using system default)' }]
      : []),
    ...microphones.map((mic) => ({ value: mic.id, label: mic.label })),
  ])

  async function openNotices() {
    noticesOpen = true
    if (notices !== null) return
    try {
      // Generated by the production build; the dev server answers with its HTML page instead.
      const response = await fetch('/THIRD_PARTY_NOTICES.txt')
      const text = response.headers.get('content-type')?.startsWith('text/plain')
      notices = response.ok && text ? await response.text() : ''
    } catch {
      notices = ''
    }
  }

</script>

<div class="page">
  <div class="column">
    <h1>Settings</h1>

    <SettingGroup title="General" id="settings-general">
      <SettingRow label="Theme" for="{uid}-theme">
        <Select
          id="{uid}-theme"
          value={value.theme}
          options={THEMES}
          onchange={(theme) => change((draft) => (draft.theme = theme))}
        />
      </SettingRow>
      <SettingRow
        label="Keep running when the window is closed"
        description="Closing the window leaves Butterfly Record in the notification area, ready to record."
        labelId="{uid}-tray"
      >
        <Switch
          labelledby="{uid}-tray"
          checked={value.closeToTray}
          onchange={(on) => change((draft) => (draft.closeToTray = on))}
        />
      </SettingRow>
      <SettingRow
        label="Library folder"
        description="New recordings, dubbed copies and exported captions are saved here. Changing it does not move existing videos."
      >
        <Button
          size="sm"
          busy={changingRoot}
          disabled={rootBusy}
          title={rootBusy ? 'Available when no recording, recovery or import is in progress' : undefined}
          onclick={changeRoot}
        >
          Change…
        </Button>
        <Button size="sm" icon="folder-open" onclick={openRoot}>Open</Button>
        {#snippet below()}
          <div class="below-stack">
            <StorageNotice />
            {#if library.info}
              <p class="path">
                <span class="selectable">{library.info.root}</span>
                <span class="free">{formatBytes(library.info.freeBytes)} free</span>
              </p>
            {/if}
          </div>
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="Recording" id="settings-recording">
      <SettingRow label="Record" for="{uid}-scope">
        <Select
          id="{uid}-scope"
          value={value.recording.scope}
          options={SCOPES}
          onchange={(scope) => change((draft) => (draft.recording.scope = scope))}
        />
      </SettingRow>
      <SettingRow label="Quality" description="The most it records at. A smaller screen is never upscaled." for="{uid}-quality">
        <Select
          id="{uid}-quality"
          value={value.recording.quality}
          options={QUALITY}
          onchange={(quality) => change((draft) => (draft.recording.quality = quality))}
        />
      </SettingRow>
      <SettingRow label="Frame rate" for="{uid}-fps">
        <Select
          id="{uid}-fps"
          value={value.recording.frameRate}
          options={FRAME_RATES}
          onchange={(rate) => change((draft) => (draft.recording.frameRate = rate))}
        />
      </SettingRow>
      <SettingRow label="Microphone" labelId="{uid}-mic">
        {#if value.recording.microphoneEnabled}
          <Select
            label="Microphone device"
            value={value.recording.microphoneId}
            options={microphoneOptions}
            onchange={(id) => change((draft) => (draft.recording.microphoneId = id))}
          />
        {/if}
        <Switch
          labelledby="{uid}-mic"
          checked={value.recording.microphoneEnabled}
          onchange={(on) => {
            void change((draft) => (draft.recording.microphoneEnabled = on))
            if (on && !microphonesLoaded) void loadMicrophones()
          }}
        />
      </SettingRow>
      <SettingRow label="Countdown" description="Wait 3 seconds before recording starts." labelId="{uid}-countdown">
        <Switch
          labelledby="{uid}-countdown"
          checked={value.recording.countdown}
          onchange={(on) => change((draft) => (draft.recording.countdown = on))}
        />
      </SettingRow>
      <SettingRow label="Hide window while recording" description="The recording bar stays on top." labelId="{uid}-hide">
        <Switch
          labelledby="{uid}-hide"
          checked={value.recording.hideWindow}
          onchange={(on) => change((draft) => (draft.recording.hideWindow = on))}
        />
      </SettingRow>
      <SettingRow label="Keyboard shortcut" description="Opens New recording from anywhere, or stops a recording in progress.">
        <span class="keys"><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd></span>
      </SettingRow>
    </SettingGroup>

    <TranscriptionSettings />

    <SettingGroup
      title="Sarvam"
      id="settings-sarvam"
      description="Translation, dubbing, summaries and transcription on Sarvam run with your own API key. Audio is sent to Sarvam only when you start a job. The key is stored in Windows Credential Manager."
    >
      <SettingRow label="API key" stacked>
        <form class="key-form" onsubmit={saveKey}>
          <TextField
            type="password"
            label="Sarvam API key"
            placeholder={sarvamKey.present ? 'Paste a new key to replace the saved one' : 'Paste your API key'}
            bind:value={keyDraft}
            wide
          />
          <Button variant="primary" type="submit" busy={savingKey} disabled={!keyDraft.trim()}>Save</Button>
          <Button busy={testingKey && !savingKey} disabled={!sarvamKey.present || savingKey} onclick={testKey}>Test</Button>
          <Button variant="danger" disabled={!sarvamKey.present || savingKey} onclick={removeKey}>Remove</Button>
        </form>
        {#snippet below()}
          <p class="key-status" role="status">
            {#if sarvamKey.present === null}
              Checking for a saved key…
            {:else if sarvamKey.check}
              <span class:ok={sarvamKey.check.ok} class:bad={!sarvamKey.check.ok} class="state">
                <Icon name={sarvamKey.check.ok ? 'check-circle' : 'x-circle'} size={14} />
                {sarvamKey.check.message}
              </span>
            {:else if sarvamKey.present}
              <span class="state ok"><Icon name="check-circle" size={14} />A key is saved.</span>
            {:else}
              No key saved. Create one at <span class="selectable url">dashboard.sarvam.ai</span>
            {/if}
          </p>
        {/snippet}
      </SettingRow>
      <SettingRow label="Transcription model" for="{uid}-stt-model">
        <Select
          id="{uid}-stt-model"
          value={value.sarvam.sttModel}
          options={STT_MODELS}
          onchange={(model) => change((draft) => (draft.sarvam.sttModel = model))}
        />
      </SettingRow>
      <SettingRow label="Speaker labels" description="Mark who is speaking in new transcripts." labelId="{uid}-diarize">
        <Switch
          labelledby="{uid}-diarize"
          checked={value.sarvam.diarize}
          onchange={(on) => change((draft) => (draft.sarvam.diarize = on))}
        />
      </SettingRow>
      <SettingRow label="Translation model" for="{uid}-translate-model">
        <Select
          id="{uid}-translate-model"
          value={value.sarvam.translateModel}
          options={TRANSLATE_MODELS}
          onchange={(model) => change((draft) => (draft.sarvam.translateModel = model))}
        />
      </SettingRow>
      <SettingRow label="Text-to-speech voice" description="Used for dubbing with a voice." for="{uid}-voice">
        <Select
          id="{uid}-voice"
          value={value.sarvam.ttsSpeaker}
          options={VOICES}
          onchange={(speaker) => change((draft) => (draft.sarvam.ttsSpeaker = speaker))}
        />
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="About" id="settings-about">
      <SettingRow label="Butterfly Record" description={version ? `Version ${version}` : undefined}>
        <span class="muted">MIT licence</span>
      </SettingRow>
      <SettingRow label="Third-party notices" description="Open-source components this app is built with.">
        <Button size="sm" onclick={openNotices}>View</Button>
      </SettingRow>
    </SettingGroup>
  </div>
</div>

<Dialog
  bind:open={noticesOpen}
  title="Third-party notices"
  description="Open-source components included in Butterfly Record, and their licences."
  width={640}
>
  {#if notices === null}
    <p class="muted">Loading…</p>
  {:else if notices}
    <textarea class="notices" readonly aria-label="Licence texts" value={notices}></textarea>
  {:else}
    <p class="muted">The notices could not be loaded.</p>
  {/if}
  {#snippet footer()}
    <Button variant="primary" onclick={() => (noticesOpen = false)}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-7);
    max-width: 760px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-6) var(--space-8);
  }

  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: 32px;
  }

  .below-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .path {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    background: var(--bg-sunken);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .selectable {
    overflow-wrap: anywhere;
    user-select: text;
    cursor: text;
  }

  .free {
    color: var(--fg-muted);
    white-space: nowrap;
  }

  .keys {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-muted);
  }

  .key-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    width: 100%;
  }

  .key-form > :global(:first-child) {
    flex: 1 1 260px;
  }

  .key-status {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .state.ok {
    color: var(--ok);
  }

  .state.bad {
    color: var(--danger);
  }

  .url {
    color: var(--fg);
  }

  .muted {
    color: var(--fg-muted);
  }

  .notices {
    display: block;
    width: 100%;
    height: min(420px, 55vh);
    margin: 0;
    padding: var(--space-3);
    overflow: auto;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-sunken);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    resize: none;
    user-select: text;
  }

  p.muted {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
