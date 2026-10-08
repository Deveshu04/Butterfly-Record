<script lang="ts">
  import { Icon } from '@butterfly-record/ui'
  import type { VideoItem } from '../lib/library.svelte.ts'
  import type { Job } from '../lib/jobs.svelte.ts'
  import { languageName } from '../lib/languages.ts'
  import Badge from './Badge.svelte'
  import IconButton from './IconButton.svelte'
  import { formatBytes, formatClock, formatShortDate } from './format.ts'
  import { jobLabel } from './job-labels.ts'
  import { menu } from './menu.svelte.ts'
  import { href } from './router.svelte.ts'

  let {
    item,
    job,
    onmenu,
  }: {
    item: VideoItem
    /** The running job to surface on the card, if any. */
    job?: Job | undefined
    /** A mouse event for a context menu at the pointer, or an anchor for the kebab button. */
    onmenu: (event: MouseEvent | null, anchor: HTMLElement | null) => void
  } = $props()

  let posterFailed = $state(false)
  let more: HTMLButtonElement | undefined = $state()

  $effect(() => {
    void item.posterUrl
    posterFailed = false
  })

  const dubbed = $derived([
    ...new Set(item.outputs.filter((output) => output.kind === 'dub').map((output) => languageName(output.language))),
  ])

  const hasBadges = $derived(
    Boolean(job) ||
      item.status === 'needs-recovery' ||
      item.status === 'missing' ||
      item.imported ||
      item.hasTranscript ||
      item.transcriptLanguages.length > 0 ||
      dubbed.length > 0,
  )

  const meta = $derived(
    [formatShortDate(item.createdAt), item.bytes !== null ? formatBytes(item.bytes) : null].filter(Boolean).join(' · '),
  )

  function keydown(event: KeyboardEvent) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      onmenu(null, more ?? null)
    }
  }
</script>

<article class="card" oncontextmenu={(event) => onmenu(event, null)}>
  <div class="poster">
    {#if item.posterUrl && !posterFailed}
      <img src={item.posterUrl} alt="" loading="lazy" decoding="async" onerror={() => (posterFailed = true)} />
    {:else}
      <span
        class="placeholder"
        class:caution={item.status === 'needs-recovery'}
        class:danger={item.status === 'missing'}
      >
        <Icon name={item.status === 'needs-recovery' || item.status === 'missing' ? 'alert' : 'film'} size={24} />
      </span>
    {/if}
    {#if item.status === 'recording'}
      <span class="chip"><span class="dot"></span>Recording</span>
    {:else if item.duration !== null}
      <span class="chip">{formatClock(item.duration)}</span>
    {/if}
    {#if job}
      <span
        class="progress"
        class:unknown={job.fraction === null}
        style:width={job.fraction === null ? undefined : `${Math.round(job.fraction * 100)}%`}
      ></span>
    {/if}
  </div>

  <div class="heading">
    <h3 class="title">
      <a class="link" href={href.video(item.id)} title={item.title} onkeydown={keydown}>{item.title}</a>
    </h3>
    <span class="more" class:open={more !== undefined && menu.current?.anchor === more}>
      <IconButton
        bind:element={more}
        icon="more"
        label="More options for {item.title}"
        size="sm"
        tone="muted"
        aria-haspopup="menu"
        onclick={(event) => onmenu(null, event.currentTarget)}
      />
    </span>
  </div>
  {#if meta}<p class="meta">{meta}</p>{/if}

  {#if hasBadges}
    <div class="badges">
      {#if job}
        <Badge>{jobLabel(job)}{job.fraction !== null ? ` ${Math.round(job.fraction * 100)}%` : ''}</Badge>
      {/if}
      {#if item.status === 'needs-recovery'}<Badge tone="caution">Needs recovery</Badge>{/if}
      {#if item.status === 'missing'}<Badge tone="danger">File missing</Badge>{/if}
      {#if item.imported}<Badge>Imported</Badge>{/if}
      {#if item.hasTranscript}<Badge>Transcript</Badge>{/if}
      {#each item.transcriptLanguages as language (language)}
        <Badge>{languageName(language)} subtitles</Badge>
      {/each}
      {#if dubbed.length > 0}
        <Badge title="Dubbed: {dubbed.join(', ')}">
          Dubbed: {dubbed.length > 2 ? `${dubbed.length} languages` : dubbed.join(', ')}
        </Badge>
      {/if}
    </div>
  {/if}
</article>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin: calc(-1 * var(--space-2));
    padding: var(--space-2);
    border-radius: var(--radius-lg);
    transition: background-color var(--motion-fast);
  }

  .card:hover {
    background: var(--fill-hover);
  }

  .card:has(.link:active) {
    background: var(--fill-active);
  }

  .card:has(.link:focus-visible) {
    box-shadow: var(--focus);
  }

  /* The title link covers the whole card, so every part of it opens the video. */
  .link {
    color: inherit;
    text-decoration: none;
  }

  .link::after {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    content: '';
  }

  .link:focus-visible {
    outline: none;
  }

  .poster {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg-sunken);
    aspect-ratio: 16 / 9;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    color: var(--fg-faint);
  }

  .placeholder.caution {
    color: var(--caution);
  }

  .placeholder.danger {
    color: var(--danger);
  }

  .chip {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    background: var(--chrome-bg-solid);
    color: var(--chrome-fg);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    line-height: 20px;
  }

  .chip .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--record);
  }

  .progress {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 3px;
    background: var(--accent);
    transition: width var(--motion-slow);
  }

  .progress.unknown {
    width: 100%;
    opacity: 0.4;
  }

  .heading {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: var(--text-md);
    font-weight: 600;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more {
    position: relative;
    z-index: 1;
    margin: -4px -4px -4px 0;
    opacity: 0;
    transition: opacity var(--motion-fast);
  }

  .card:hover .more,
  .card:focus-within .more,
  .more.open {
    opacity: 1;
  }

  .meta {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }
</style>
