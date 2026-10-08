<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    EditHistory,
    autoEdits,
    cutCount,
    formatDuration,
    hasAutoEdits,
    outputDuration,
    outputToSource,
    readEdl,
    readEntry,
    readSource,
    readTranscript,
    removeRange,
    removeRanges,
    removedRanges,
    restoreRanges,
    revertEdits,
    safeFilenameWithExtension,
    splitAt,
    trimSegment,
    withAutoEdits,
    writeEdl,
    type Edl,
    type FillerLevel,
    type LibraryEntry,
    type Transcript,
  } from '@butterfly-record/core'
  import type { Peaks } from '@butterfly-record/core/peaks'

  const { id, onback }: { id: string; onback: () => void } = $props()

  const MAX_ZOOM = 50

  let entry = $state<LibraryEntry | null>(null)
  let sourceUrl = $state<string | null>(null)
  let video: HTMLVideoElement | null = $state(null)
  let timeline: HTMLDivElement | null = $state(null)
  let scroller: HTMLDivElement | null = $state(null)
  let shell: HTMLDivElement | null = $state(null)
  let waveCanvas: HTMLCanvasElement | null = $state(null)

  let edl = $state<Edl | null>(null)
  let history: EditHistory | null = null
  let canUndo = $state(false)
  let canRedo = $state(false)

  let playhead = $state(0)
  let selection = $state<{ from: number; to: number } | null>(null)
  let keyframes = $state<number[]>([])
  let snap = $state(true)

  let transcript = $state<Transcript | null>(null)
  let transcriptChecked = $state(false)
  let fillerLevel = $state<FillerLevel>('light')
  let applyingAuto = $state(false)

  let peaks = $state<Peaks | null>(null)
  let peaksPending = $state(true)
  let peaksModule: typeof import('@butterfly-record/core/peaks') | null = null

  let zoom = $state(1)
  let viewFrom = $state(0)

  let exporting = $state(false)
  let exportProgress = $state(0)
  let status = $state<string | null>(null)
  let saving = $state(false)

  const duration = $derived(edl?.sourceDuration ?? 0)
  const output = $derived(edl ? outputDuration(edl) : 0)
  const cuts = $derived(edl ? cutCount(edl) : 0)
  const gaps = $derived(edl ? removedRanges(edl) : [])

  const auto = $derived(edl ? autoEdits(edl) : { filler: null, silence: null, ranges: [] })
  const autoRemoved = $derived(
    auto.ranges.reduce((sum, range) => sum + (range.end - range.start), 0),
  )

  const viewSpan = $derived(zoom > 0 ? duration / zoom : 0)
  const viewTo = $derived(viewFrom + viewSpan)
  const zoomSlider = $derived(Math.log(zoom) / Math.log(MAX_ZOOM))
  const zoomLabel = $derived(zoom < 9.95 ? (Math.round(zoom * 10) / 10).toString() : Math.round(zoom).toString())
  // Keyframes can number in the thousands; cull off-screen tick marks.
  const visibleKeyframes = $derived(
    keyframes.filter((time) => time >= viewFrom - viewSpan * 0.02 && time <= viewTo + viewSpan * 0.02),
  )

  const pct = (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0)

  async function load() {
    const found = await readEntry(id)
    if (!found || found.needsRecovery || found.manifest.duration === null) {
      status = 'This recording cannot be edited yet.'
      return
    }
    entry = found
    const file = await readSource(id)
    sourceUrl = URL.createObjectURL(file)

    const loaded = await readEdl(id, found.manifest.duration)
    history = new EditHistory(loaded)
    edl = loaded
    refreshHistoryFlags()

    void readTranscript(id)
      .then((stored) => (transcript = stored))
      .finally(() => (transcriptChecked = true))

    // Scans the whole file, so it runs after the editor is interactive.
    const { keyframeTimes } = await import('@butterfly-record/core/edit-export')
    keyframes = await keyframeTimes(id).catch(() => [])

    try {
      peaksModule = await import('@butterfly-record/core/peaks')
      peaks = await peaksModule.ensurePeaks(id, file)
    } catch {
      peaks = null
    } finally {
      peaksPending = false
    }
  }

  function refreshHistoryFlags() {
    canUndo = history?.canUndo ?? false
    canRedo = history?.canRedo ?? false
  }

  async function commit(next: Edl) {
    if (!history) return
    edl = history.commit(next)
    refreshHistoryFlags()
    await persist()
  }

  async function persist() {
    if (!edl) return
    saving = true
    try {
      await writeEdl(id, edl)
    } finally {
      saving = false
    }
  }

  function snapped(time: number): number {
    if (!snap || keyframes.length === 0) return time
    let best = keyframes[0]!
    for (const candidate of keyframes) {
      if (candidate <= time && candidate > best) best = candidate
    }
    // A distant keyframe would make the handle jump visibly.
    return Math.abs(time - best) < 1.5 ? best : time
  }

  const split = () => edl && commit(splitAt(edl, playhead))

  function deleteSelection() {
    if (!edl || !selection) return
    const { from, to } = selection
    selection = null
    void commit(removeRange(edl, snapped(Math.min(from, to)), Math.max(from, to)))
  }

  function undo() {
    if (!history) return
    edl = history.undo()
    refreshHistoryFlags()
    void persist()
  }

  function redo() {
    if (!history) return
    edl = history.redo()
    refreshHistoryFlags()
    void persist()
  }

  async function revert() {
    if (!entry?.manifest.duration) return
    await revertEdits(id)
    const fresh = await readEdl(id, entry.manifest.duration)
    edl = history?.reset(fresh) ?? fresh
    refreshHistoryFlags()
  }

  /**
   * Restores the previously recorded ranges rather than recomputing them, so the
   * toggles stay exactly reversible after the transcript is regenerated.
   */
  async function applyAuto(filler: FillerLevel | null, silenceOn: boolean) {
    if (!edl || !transcript || applyingAuto) return
    applyingAuto = true
    try {
      const { DEFAULT_SILENCE, autoCutRanges } = await import('@butterfly-record/core/auto-edits')
      let base = edl
      if (hasAutoEdits(base)) base = restoreRanges(base, autoEdits(base).ranges)
      const silence = silenceOn ? DEFAULT_SILENCE : null
      const ranges = autoCutRanges(transcript, { filler, silence })
      await commit(withAutoEdits(removeRanges(base, ranges), { filler, silence, ranges }))
    } finally {
      applyingAuto = false
    }
  }

  function onFillerToggle(event: Event) {
    const on = (event.currentTarget as HTMLInputElement).checked
    void applyAuto(on ? fillerLevel : null, auto.silence !== null)
  }

  function onFillerLevel(event: Event) {
    const level: FillerLevel =
      (event.currentTarget as HTMLSelectElement).value === 'aggressive' ? 'aggressive' : 'light'
    fillerLevel = level
    if (auto.filler !== null) void applyAuto(level, auto.silence !== null)
  }

  function onSilenceToggle(event: Event) {
    const on = (event.currentTarget as HTMLInputElement).checked
    void applyAuto(auto.filler, on)
  }

  // Undo, redo and load change the EDL; keep the level select in sync.
  $effect(() => {
    if (auto.filler !== null) fillerLevel = auto.filler
  })

  async function exportEdited() {
    if (!edl || !entry) return
    exporting = true
    exportProgress = 0
    status = null
    try {
      const module = await import('@butterfly-record/core/edit-export')
      const file = await module.exportEdited(id, edl, {
        onProgress: (progress) => (exportProgress = progress.progress),
      })

      const url = URL.createObjectURL(file)
      const downloadId = await chrome.downloads.download({
        url,
        filename: `Butterfly Record/${safeFilenameWithExtension(`${entry.manifest.title} (edited)`, 'webm')}`,
        saveAs: true,
      })

      // Revoking or deleting the scratch file early truncates the download.
      chrome.downloads.onChanged.addListener(function done(delta) {
        if (delta.id !== downloadId) return
        const state = delta.state?.current
        if (state !== 'complete' && state !== 'interrupted') return
        chrome.downloads.onChanged.removeListener(done)
        URL.revokeObjectURL(url)
        void module.discardExport(id)
      })

      status = 'Exported.'
    } catch (cause) {
      status = cause instanceof Error ? cause.message : String(cause)
    } finally {
      exporting = false
    }
  }

  function measureView() {
    if (!scroller || duration <= 0) return
    const width = scroller.scrollWidth
    viewFrom = width > 0 ? (scroller.scrollLeft / width) * duration : 0
  }

  async function setZoom(next: number, anchorTime?: number, anchorX?: number) {
    const clamped = Math.min(MAX_ZOOM, Math.max(1, next))
    if (!scroller || duration <= 0) {
      zoom = clamped
      return
    }
    const width = scroller.clientWidth
    const x = anchorX ?? width / 2
    const time = anchorTime ?? viewFrom + (x / width) * viewSpan
    zoom = clamped
    await tick()
    // Keep the anchor's moment under the same x while the track resizes.
    scroller.scrollLeft = Math.max(0, (time / duration) * scroller.scrollWidth - x)
    measureView()
  }

  function onZoomInput(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    void setZoom(Math.pow(MAX_ZOOM, value))
  }

  function onWheel(event: WheelEvent) {
    if (!scroller || duration <= 0) return
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel; zoom about the cursor.
      event.preventDefault()
      const box = scroller.getBoundingClientRect()
      const x = event.clientX - box.left
      void setZoom(zoom * Math.exp(-event.deltaY * 0.002), viewFrom + (x / box.width) * viewSpan, x)
    } else if (zoom > 1 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      // A mouse wheel has no horizontal axis; vertical scroll pans when zoomed.
      event.preventDefault()
      scroller.scrollLeft += event.deltaY
    }
  }

  function followPlayhead() {
    if (!scroller || !video || video.paused || zoom <= 1 || duration <= 0) return
    if (playhead >= viewFrom && playhead <= viewFrom + viewSpan * 0.98) return
    const left = (playhead / duration) * scroller.scrollWidth - scroller.clientWidth * 0.1
    scroller.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }

  let waveFrame = 0
  function scheduleWave() {
    if (waveFrame !== 0) return
    waveFrame = requestAnimationFrame(() => {
      waveFrame = 0
      drawWave()
    })
  }

  function drawWave() {
    const canvas = waveCanvas
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const dpr = window.devicePixelRatio || 1
    const cssWidth = canvas.clientWidth
    const cssHeight = canvas.clientHeight
    if (cssWidth <= 0 || cssHeight <= 0) return
    const deviceWidth = Math.round(cssWidth * dpr)
    const deviceHeight = Math.round(cssHeight * dpr)
    if (canvas.width !== deviceWidth) canvas.width = deviceWidth
    if (canvas.height !== deviceHeight) canvas.height = deviceHeight

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, cssWidth, cssHeight)
    // No decodable audio: draw nothing rather than a flat line that reads as silence.
    if (!peaks || !peaksModule || peaks.data.length === 0 || duration <= 0) return

    const envelope = peaksModule.envelopeFor(
      peaks,
      cssWidth,
      viewFrom,
      Math.min(duration, viewTo),
    )
    context.fillStyle = getComputedStyle(canvas).color
    const mid = cssHeight / 2
    for (let column = 0; column < envelope.length; column++) {
      const half = Math.max(0.5, (envelope[column] ?? 0) * mid * 0.92)
      context.fillRect(column, mid - half, 1, half * 2)
    }
  }

  $effect(() => {
    // Reads register dependencies; scheduleWave coalesces repaints to one per frame.
    void peaks
    void viewFrom
    void viewSpan
    void waveCanvas
    scheduleWave()
  })

  $effect(() => {
    const target = shell
    if (!target) return
    const observer = new ResizeObserver(() => {
      measureView()
      scheduleWave()
    })
    observer.observe(target)
    return () => observer.disconnect()
  })

  function timeAt(event: PointerEvent): number {
    if (!timeline) return 0
    const box = timeline.getBoundingClientRect()
    const ratio = (event.clientX - box.left) / box.width
    return Math.max(0, Math.min(duration, ratio * duration))
  }

  function onTimelinePointerDown(event: PointerEvent) {
    if (!timeline) return
    const anchor = timeAt(event)
    const anchorX = event.clientX
    timeline.setPointerCapture(event.pointerId)
    selection = null
    seek(anchor)

    let dragged = false
    const onMove = (move: PointerEvent) => {
      // Pixel threshold, so drag sensitivity does not depend on zoom.
      if (!dragged && Math.abs(move.clientX - anchorX) < 4) return
      dragged = true
      selection = { from: anchor, to: timeAt(move) }
    }
    const onUp = () => {
      timeline!.releasePointerCapture(event.pointerId)
      timeline!.removeEventListener('pointermove', onMove)
      timeline!.removeEventListener('pointerup', onUp)
    }
    timeline.addEventListener('pointermove', onMove)
    timeline.addEventListener('pointerup', onUp)
  }

  function dragHandle(event: PointerEvent, index: number, edge: 'start' | 'end') {
    event.stopPropagation()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)

    const onMove = (move: PointerEvent) => {
      if (!edl) return
      edl = trimSegment(edl, index, edge, timeAt(move))
    }
    const onUp = () => {
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      // Commit on release: one undo step and one write per drag.
      if (edl) {
        const settled =
          edge === 'start'
            ? trimSegment(edl, index, 'start', snapped(edl.segments[index]!.start))
            : edl
        void commit(settled)
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  function seek(sourceTime: number) {
    playhead = sourceTime
    if (video) video.currentTime = sourceTime
  }

  /** Skips the removed ranges so the preview matches the export. */
  function onTimeUpdate() {
    if (!video || !edl) return
    const now = video.currentTime
    playhead = now
    followPlayhead()

    for (const gap of gaps) {
      if (now >= gap.start - 0.02 && now < gap.end) {
        if (gap.end >= duration - 0.05) {
          video.pause()
          return
        }
        video.currentTime = gap.end
        return
      }
    }
  }

  function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    const meta = event.ctrlKey || event.metaKey
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
      return
    }
    if (meta && event.key === '0') {
      event.preventDefault()
      void setZoom(1)
      return
    }

    switch (event.key.toLowerCase()) {
      case 's':
        event.preventDefault()
        void split()
        break
      case 'delete':
      case 'backspace':
        event.preventDefault()
        deleteSelection()
        break
      case ' ':
        event.preventDefault()
        if (video) video.paused ? void video.play() : video.pause()
        break
      case 'escape':
        selection = null
        break
    }
  }

  onMount(() => {
    void load()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (waveFrame !== 0) cancelAnimationFrame(waveFrame)
      if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    }
  })
</script>

<div class="page">
  <div class="bar">
    <button class="back" onclick={onback}>‹ Back</button>
    <span class="title">Editing: {entry?.manifest.title ?? '…'}</span>
    <div class="actions">
      <button onclick={revert} disabled={!edl || cuts === 0}>Revert</button>
      <button class="primary" onclick={exportEdited} disabled={exporting || !edl || output === 0}>
        {exporting ? `Exporting… ${Math.round(exportProgress * 100)}%` : 'Export'}
      </button>
    </div>
  </div>

  <div class="layout">
    <div class="main">
      {#if sourceUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} src={sourceUrl} controls ontimeupdate={onTimeUpdate}></video>
      {/if}

      {#if edl}
        <div class="tools">
          <button onclick={split}>Split <kbd>S</kbd></button>
          <button onclick={deleteSelection} disabled={!selection}>⌫ Delete <kbd>Del</kbd></button>
          <button onclick={undo} disabled={!canUndo}>↶ Undo</button>
          <button onclick={redo} disabled={!canRedo}>↷ Redo</button>
          <span class="zoomctl">
            <button onclick={() => void setZoom(1)} title="Fit (Ctrl+0)">Fit</button>
            <input
              class="zoomslider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={zoomSlider}
              oninput={onZoomInput}
              aria-label="Timeline zoom"
            />
            <span class="zoomlabel">{zoomLabel}×</span>
          </span>
          <label class="snap">
            <input type="checkbox" bind:checked={snap} />
            Snap to keyframes (no re-encode)
          </label>
        </div>

        <div class="timeline-shell" bind:this={shell}>
          <canvas class="wave" bind:this={waveCanvas}></canvas>
          {#if peaksPending}
            <div class="analysing">analysing audio</div>
          {/if}
          <div class="timeline" bind:this={scroller} onscroll={measureView} onwheel={onWheel}>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="track"
              bind:this={timeline}
              style="width: {zoom * 100}%"
              onpointerdown={onTimelinePointerDown}
            >
              {#each edl.segments as segment, index (index)}
                <div
                  class="segment"
                  style="left: {pct(segment.start)}%; width: {pct(segment.end - segment.start)}%"
                >
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span
                    class="handle left"
                    onpointerdown={(event) => dragHandle(event, index, 'start')}
                  ></span>
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span
                    class="handle right"
                    onpointerdown={(event) => dragHandle(event, index, 'end')}
                  ></span>
                </div>
              {/each}

              {#each gaps as gap (gap.start)}
                <div
                  class="gap"
                  style="left: {pct(gap.start)}%; width: {pct(gap.end - gap.start)}%"
                ></div>
              {/each}

              {#if snap}
                {#each visibleKeyframes as time (time)}
                  <span class="keyframe" style="left: {pct(time)}%"></span>
                {/each}
              {/if}

              {#if selection}
                <div
                  class="selection"
                  style="left: {pct(Math.min(selection.from, selection.to))}%; width: {pct(
                    Math.abs(selection.to - selection.from),
                  )}%"
                ></div>
              {/if}

              <span class="playhead" style="left: {pct(playhead)}%"></span>
            </div>
          </div>
        </div>

        <p class="readout">
          Output {formatDuration(output)} · {cuts} cut{cuts === 1 ? '' : 's'} ·
          {#if saving}saving…{:else if cuts === 0}no changes{:else}source untouched{/if}
        </p>

        {#if cuts > 0 && keyframes.length > 0}
          <p class="caveat">
            Cuts are frame-exact: export re-encodes only the opening instants
            of a cut segment, and falls back to the previous keyframe when this
            browser cannot re-encode the codec. Tick marks are keyframes —
            snapped cuts skip the re-encode entirely.
          </p>
        {/if}
      {/if}

      {#if status}<p class="status">{status}</p>{/if}
    </div>

    {#if edl}
      <aside class="rail">
        <h2>Auto edits</h2>

        <label class="toggle">
          <input
            type="checkbox"
            checked={auto.filler !== null}
            disabled={!transcript || applyingAuto}
            onchange={onFillerToggle}
          />
          Remove filler words
        </label>
        <select
          class="level"
          value={auto.filler ?? fillerLevel}
          disabled={!transcript || applyingAuto || auto.filler === null}
          onchange={onFillerLevel}
          aria-label="Filler removal level"
        >
          <option value="light">Light — um, uh, er</option>
          <option value="aggressive">Aggressive — hedges and repeats too</option>
        </select>

        <label class="toggle">
          <input
            type="checkbox"
            checked={auto.silence !== null}
            disabled={!transcript || applyingAuto}
            onchange={onSilenceToggle}
          />
          Remove silence
        </label>

        {#if transcriptChecked && !transcript}
          <p class="hint">Transcribe this recording first.</p>
        {:else if auto.filler !== null || auto.silence !== null}
          <p class="hint">
            Removes {auto.ranges.length} cut{auto.ranges.length === 1 ? '' : 's'} ·
            {autoRemoved.toFixed(1)}s
          </p>
        {/if}
      </aside>
    {/if}
  </div>
</div>

<style>
  .page {
    max-width: 1240px;
    margin: 0 auto;
    padding: 20px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 250px;
    gap: 20px;
    align-items: start;
  }

  button {
    padding: 7px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: var(--fill-hover);
  }

  button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .back {
    border-color: transparent;
    background: none;
    color: var(--fg-muted);
  }

  .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
  }

  video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: #000;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 14px 0 10px;
  }

  kbd {
    margin-left: 4px;
    padding: 1px 4px;
    border: 1px solid var(--hairline);
    border-radius: 3px;
    color: var(--fg-faint);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .zoomctl {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .zoomslider {
    width: 110px;
    accent-color: var(--accent);
  }

  .zoomlabel {
    min-width: 30px;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    text-align: right;
  }

  .snap {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-muted);
    font-size: 12px;
    cursor: pointer;
  }

  .snap input {
    accent-color: var(--accent);
  }

  /* Lanes: segments 0-56px, waveform 58-98px, scrollbar below the track. */
  .timeline-shell {
    position: relative;
    height: 112px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-sunken);
    overflow: hidden;
  }

  .wave {
    position: absolute;
    top: 58px;
    left: 0;
    right: 0;
    width: 100%;
    height: 40px;
    color: var(--fg-muted);
    opacity: 0.7;
    pointer-events: none;
  }

  .analysing {
    position: absolute;
    top: 58px;
    left: 0;
    right: 0;
    height: 40px;
    display: grid;
    place-items: center;
    color: var(--fg-faint);
    font-size: 11px;
    letter-spacing: 0.05em;
    background: linear-gradient(100deg, transparent 30%, var(--fill-hover) 50%, transparent 70%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }

  @keyframes shimmer {
    from {
      background-position: 130% 0;
    }
    to {
      background-position: -30% 0;
    }
  }

  .timeline {
    position: absolute;
    inset: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }

  .track {
    position: relative;
    height: 100px;
    min-width: 100%;
    cursor: text;
    touch-action: none;
  }

  .segment {
    position: absolute;
    top: 0;
    height: 56px;
    background: var(--bg-elevated);
    border-left: 1px solid var(--hairline-strong);
    border-right: 1px solid var(--hairline-strong);
  }

  .gap {
    position: absolute;
    top: 0;
    height: 56px;
    background: repeating-linear-gradient(
      -45deg,
      var(--bg-sunken),
      var(--bg-sunken) 5px,
      var(--fill-hover) 5px,
      var(--fill-hover) 10px
    );
  }

  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8px;
    background: var(--accent);
    opacity: 0;
    cursor: ew-resize;
    transition: opacity var(--motion-fast);
  }

  .segment:hover .handle {
    opacity: 0.65;
  }

  .handle:hover {
    opacity: 1 !important;
  }

  .handle.left {
    left: 0;
  }

  .handle.right {
    right: 0;
  }

  .keyframe {
    position: absolute;
    top: 0;
    width: 1px;
    height: 6px;
    background: var(--fg-faint);
  }

  .selection {
    position: absolute;
    top: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--record) 22%, transparent);
    border-left: 1px solid var(--record);
    border-right: 1px solid var(--record);
    pointer-events: none;
  }

  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--record);
    pointer-events: none;
  }

  .rail {
    padding: 14px 16px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
  }

  .rail h2 {
    margin: 0 0 12px;
    font-size: 13px;
    font-weight: 600;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 4px;
    font-size: 13px;
    cursor: pointer;
  }

  .toggle input {
    accent-color: var(--accent);
  }

  .toggle:has(input:disabled) {
    opacity: 0.55;
    cursor: default;
  }

  .level {
    width: 100%;
    margin: 2px 0 6px;
    padding: 6px 8px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
  }

  .level:disabled {
    opacity: 0.55;
  }

  .readout {
    margin: 10px 0 0;
    color: var(--fg-muted);
    font-size: 12px;
  }

  .caveat,
  .status {
    margin: 6px 0 0;
    color: var(--fg-faint);
    font-size: 12px;
    line-height: 1.5;
  }

  .hint {
    margin: 10px 0 0;
    color: var(--fg-muted);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
