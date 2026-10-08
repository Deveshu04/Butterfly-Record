<script lang="ts">
  import { onMount } from 'svelte'
  import {
    autoTitle,
    readTranscript,
    readSource,
    renameRecording,
    safeFilename,
    searchTranscript,
    toPlainText,
    toSrt,
    toVtt,
    writeTranscript,
    type LibraryEntry,
    type Transcript,
  } from '@butterfly-record/core'

  const {
    entry,
    onseek,
    onretitle,
  }: {
    entry: LibraryEntry
    onseek: (time: number) => void
    onretitle: (title: string) => void
  } = $props()

  let transcript = $state<Transcript | null>(null)
  let loading = $state(true)
  let running = $state(false)
  let stage = $state('')
  let progress = $state<number | null>(0)
  let error = $state<string | null>(null)
  let query = $state('')
  let suggestion = $state<string | null>(null)

  const matches = $derived(transcript && query.trim() ? searchTranscript(transcript, query) : [])
  const matchTimes = $derived(new Set(matches.map((match) => match.time)))

  async function run() {
    running = true
    error = null
    progress = 0
    try {
      const { transcribeFile } = await import('@butterfly-record/core/transcribe')
      const file = await readSource(entry.manifest.id)
      const result = await transcribeFile(file, {
        /*
          `wasmPaths` is left unset: Vite bundles onnxruntime's WASM and rewrites its URL.
          If `ort-wasm-*.wasm` fails with a 404 or CSP error, copy the ORT binaries
          into `public/` and pass `wasmPaths: chrome.runtime.getURL('/')`.
        */
        onProgress: (update) => {
          stage = update.message
          progress = update.progress
        },
      })
      await writeTranscript(entry.manifest.id, result)
      transcript = result

      // Only suggested for default-named recordings; never applied without asking.
      const proposed = autoTitle(result)
      if (proposed && entry.manifest.title.startsWith('Recording ')) suggestion = proposed
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      running = false
      stage = ''
    }
  }

  async function acceptTitle() {
    if (!suggestion) return
    await renameRecording(entry.manifest.id, suggestion)
    onretitle(suggestion)
    suggestion = null
  }

  function download(kind: 'srt' | 'vtt' | 'txt') {
    if (!transcript) return
    const body =
      kind === 'srt' ? toSrt(transcript) : kind === 'vtt' ? toVtt(transcript) : toPlainText(transcript)
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeFilename(entry.manifest.title)}.${kind}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function copyAll() {
    if (!transcript) return
    await navigator.clipboard.writeText(toPlainText(transcript))
  }

  function clock(seconds: number): string {
    const total = Math.floor(seconds)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  onMount(() => {
    void readTranscript(entry.manifest.id)
      .then((found) => (transcript = found))
      .finally(() => (loading = false))
  })
</script>

<section class="panel">
  <div class="head">
    <h2>Transcript</h2>
    {#if transcript}
      <div class="downloads">
        <button onclick={copyAll}>Copy</button>
        <button onclick={() => download('srt')}>SRT</button>
        <button onclick={() => download('vtt')}>VTT</button>
        <button onclick={() => download('txt')}>TXT</button>
      </div>
    {/if}
  </div>

  {#if loading}
    <p class="muted">…</p>
  {:else if running}
    <p class="muted">{stage}</p>
    <div class="bar"><span style="width: {(progress ?? 0) * 100}%"></span></div>
    <p class="muted small">Runs entirely on this machine. Nothing is uploaded.</p>
  {:else if !transcript}
    <p class="muted">
      Transcribe this recording to search what was said, and to download
      subtitles. The speech model downloads once, then works offline.
    </p>
    <button class="primary" onclick={run}>Transcribe</button>
  {:else}
    {#if suggestion}
      <div class="suggestion">
        <span>Rename to “{suggestion}”?</span>
        <button onclick={acceptTitle}>Rename</button>
        <button onclick={() => (suggestion = null)}>No thanks</button>
      </div>
    {/if}

    <input
      type="search"
      placeholder="Find in transcript…"
      bind:value={query}
      aria-label="Find in transcript"
    />
    {#if query.trim()}
      <p class="muted small">{matches.length} match{matches.length === 1 ? '' : 'es'}</p>
    {/if}

    <ol class="cues">
      {#each transcript.segments as segment (segment.start)}
        <li class:hit={matchTimes.has(segment.start)}>
          <button onclick={() => onseek(segment.start)}>
            <span class="time">{clock(segment.start)}</span>
            <span class="text">{segment.text}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .panel {
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid var(--hairline);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .downloads {
    display: flex;
    gap: 6px;
  }

  button {
    padding: 6px 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  button:hover {
    background: var(--fill-hover);
  }

  .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 13px;
    font-weight: 600;
  }

  .muted {
    margin: 0 0 8px;
    color: var(--fg-muted);
    line-height: 1.55;
  }

  .small {
    font-size: 12px;
  }

  .bar {
    height: 4px;
    margin-bottom: 8px;
    border-radius: 999px;
    background: var(--bg-sunken);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--motion);
  }

  .suggestion {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    padding: 9px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    font-size: 13px;
  }

  .suggestion span {
    flex: 1;
  }

  input[type='search'] {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
  }

  .cues {
    max-height: 340px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
  }

  .cues li {
    border-radius: var(--radius-sm);
  }

  .cues li.hit {
    background: var(--fill-active);
  }

  .cues button {
    display: flex;
    gap: 12px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    background: none;
    text-align: left;
    font-size: 13px;
    line-height: 1.5;
  }

  .time {
    flex: none;
    color: var(--fg-faint);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .error {
    margin: 10px 0 0;
    color: var(--danger);
  }
</style>
