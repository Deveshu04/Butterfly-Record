<script lang="ts" module>
  export interface ListSegment {
    start: number
    end: number
    text: string
    speaker?: string | null | undefined
  }

  /** Index of the last segment that has started by `time`, or -1. */
  function segmentAt(segments: ListSegment[], time: number): number {
    let low = 0
    let high = segments.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (segments[mid]!.start <= time) {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }
</script>

<script lang="ts">
  import { Icon } from '@butterfly-record/ui'
  import { formatClock } from './format.ts'

  let {
    segments,
    currentTime,
    query = '',
    onseek,
    label = 'Transcript',
  }: {
    segments: ListSegment[]
    currentTime: number
    query?: string
    onseek: (time: number) => void
    label?: string
  } = $props()

  const uid = $props.id()
  let scroller: HTMLDivElement | undefined = $state()
  let follow = $state(true)
  let cursor = $state(-1)

  const needle = $derived(query.trim().toLocaleLowerCase())

  /** Indices into `segments` that are shown. */
  const visible = $derived.by(() => {
    if (!needle) return null
    const indices: number[] = []
    segments.forEach((segment, index) => {
      if (segment.text.toLocaleLowerCase().includes(needle)) indices.push(index)
    })
    return indices
  })

  const rows = $derived(visible ?? segments.map((_, index) => index))
  const active = $derived(segmentAt(segments, currentTime))

  function parts(text: string): { text: string; match: boolean }[] {
    if (!needle) return [{ text, match: false }]
    const out: { text: string; match: boolean }[] = []
    const lower = text.toLocaleLowerCase()
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at === -1) break
      if (at > from) out.push({ text: text.slice(from, at), match: false })
      out.push({ text: text.slice(at, at + needle.length), match: true })
      from = at + needle.length
    }
    if (from < text.length) out.push({ text: text.slice(from), match: false })
    return out
  }

  function rowElement(index: number): HTMLElement | null {
    return scroller?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null
  }

  // Keep the spoken line in the upper part of the list; only scroll when it leaves that band.
  $effect(() => {
    const index = active
    if (!follow || index < 0 || !scroller) return
    const row = rowElement(index)
    if (!row) return
    const view = scroller.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    if (box.top >= view.top + 8 && box.bottom <= view.top + view.height * 0.7) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.scrollTo({
      top: scroller.scrollTop + (box.top - view.top) - view.height * 0.25,
      behavior: reduce ? 'auto' : 'smooth',
    })
  })

  function userScrolled() {
    follow = false
  }

  function resume() {
    follow = true
  }

  function seek(index: number) {
    const segment = segments[index]
    if (!segment) return
    // Letting go after selecting text is not a request to seek.
    if (getSelection()?.toString()) return
    cursor = index
    follow = true
    onseek(segment.start)
  }

  function keydown(event: KeyboardEvent) {
    if (rows.length === 0) return
    const position = Math.max(0, rows.indexOf(cursor >= 0 ? cursor : Math.max(active, rows[0]!)))
    let next = position
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, position + 1)
        break
      case 'ArrowUp':
        next = Math.max(0, position - 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
      case 'Enter':
        if (cursor >= 0) seek(cursor)
        event.preventDefault()
        return
      default:
        return
    }
    event.preventDefault()
    follow = false
    cursor = rows[next]!
    rowElement(cursor)?.scrollIntoView({ block: 'nearest' })
  }
</script>

<div class="wrap">
  <div
    bind:this={scroller}
    class="list"
    role="listbox"
    tabindex="0"
    aria-label={label}
    aria-activedescendant={cursor >= 0 ? `${uid}-${cursor}` : undefined}
    onwheel={userScrolled}
    ontouchmove={userScrolled}
    onpointerdown={(event) => {
      // A press on the list itself rather than a line is the scrollbar.
      if (event.target === scroller) userScrolled()
    }}
    onkeydown={keydown}
  >
    {#each rows as index (index)}
      {@const segment = segments[index]!}
      {@const speaker = segment.speaker}
      {@const previous = index > 0 ? segments[index - 1] : undefined}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        id="{uid}-{index}"
        class="row"
        class:active={index === active}
        class:cursor={index === cursor}
        role="option"
        tabindex="-1"
        aria-selected={index === active}
        data-index={index}
        onclick={() => seek(index)}
      >
        <span class="time">{formatClock(segment.start)}</span>
        <span class="body">
          {#if speaker && (visible || previous?.speaker !== segment.speaker)}
            <span class="speaker">{speaker}</span>
          {/if}
          <span class="text">
            {#each parts(segment.text) as part, partIndex (partIndex)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
          </span>
        </span>
      </div>
    {:else}
      <p class="none">No lines match “{query.trim()}”.</p>
    {/each}
  </div>
  {#if !follow && active >= 0 && !needle}
    <button type="button" class="follow" onclick={resume}>
      <Icon name="chevron-down" size={14} />
      Follow playback
    </button>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .list {
    flex: 1;
    min-height: 0;
    padding: var(--space-1) var(--space-2) var(--space-6);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .list:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .row {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: var(--space-2);
    padding: 6px var(--space-2);
    border-radius: var(--radius-control);
    cursor: pointer;
    /* Lets the engine skip layout and paint for off-screen lines in long transcripts. */
    content-visibility: auto;
    contain-intrinsic-size: auto 44px;
  }

  .row:hover {
    background: var(--fill-hover);
  }

  .row.active,
  .row:active {
    background: var(--fill-active);
  }

  .row.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .time {
    padding-top: 1px;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    line-height: 20px;
  }

  .row.active .time {
    color: var(--fg);
    font-weight: 600;
  }

  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .speaker {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 20px;
  }

  .text {
    line-height: 20px;
    overflow-wrap: anywhere;
    user-select: text;
  }

  mark {
    border-radius: 2px;
    background: color-mix(in srgb, var(--caution) 28%, transparent);
    color: inherit;
  }

  .none {
    margin: var(--space-6) 0;
    color: var(--fg-muted);
    text-align: center;
  }

  .follow {
    position: absolute;
    bottom: var(--space-3);
    left: 50%;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 var(--space-3);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-pill);
    background: var(--bg-overlay);
    color: var(--fg);
    font-size: var(--text-sm);
    font-weight: 500;
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    transform: translateX(-50%);
  }

  .follow:hover {
    background: color-mix(in srgb, var(--bg-overlay), var(--fg) 5%);
  }

  .follow:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }
</style>
