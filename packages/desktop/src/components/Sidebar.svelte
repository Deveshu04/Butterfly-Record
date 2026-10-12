<script lang="ts">
  import { Butterfly, Icon, type IconName } from '@butterfly-record/ui'
  import { library } from '../lib/library.svelte.ts'
  import { recorder } from '../lib/recorder.svelte.ts'
  import { storageAccess } from '../lib/storage-access.svelte.ts'
  import { formatBytes, formatClock, baseName } from './format.ts'
  import { quitNotice } from './quit-notice.svelte.ts'
  import { href, router } from './router.svelte.ts'
  import { sarvamKey } from './sarvam-key.svelte.ts'
  import { toasts } from './toasts.svelte.ts'

  const route = $derived(router.route)
  const live = $derived(recorder.phase !== 'idle')
  const importedCount = $derived(library.items.filter((item) => item.imported).length)
  const folderName = $derived(library.info ? baseName(library.info.root) : '')

  quitNotice()

  const nav = $derived<{ id: string; label: string; icon: IconName; href: string; count: number | null; current: boolean }[]>([
    {
      id: 'library',
      label: 'Library',
      icon: 'library',
      href: href.library(),
      count: library.items.length,
      current: route.name === 'library' && route.filter === 'all',
    },
    {
      id: 'imported',
      label: 'Imported',
      icon: 'import',
      href: href.library('imported'),
      count: importedCount,
      current: route.name === 'library' && route.filter === 'imported',
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      href: href.settings(),
      count: null,
      current: route.name === 'settings',
    },
  ])

  async function openFolder() {
    try {
      await library.openFolder()
    } catch (error) {
      toasts.error(error)
    }
  }
</script>

<aside class="sidebar">
  <div class="brand">
    <Butterfly size={20} state={recorder.phase === 'recording' ? 'active' : 'idle'} />
    <span class="brand-name">Butterfly Record</span>
  </div>

  <a
    class="new"
    class:live
    class:current={route.name === 'record'}
    href={href.record()}
    title={live ? 'Go to the recording' : 'New recording'}
    aria-current={route.name === 'record' ? 'page' : undefined}
  >
    <span class="rec" class:paused={recorder.phase === 'paused'} aria-hidden="true"></span>
    <span class="label">
      {#if recorder.phase === 'recording' || recorder.phase === 'paused'}
        {recorder.phase === 'paused' ? 'Paused' : 'Recording'}
        <span class="timer">{formatClock(recorder.elapsed)}</span>
      {:else if recorder.phase === 'finalizing'}
        Saving…
      {:else if live}
        Starting…
      {:else}
        New recording
      {/if}
    </span>
  </a>

  <nav aria-label="Main">
    {#each nav as entry (entry.id)}
      <a
        class="nav-item"
        href={entry.href}
        title={entry.label}
        aria-current={entry.current ? 'page' : undefined}
      >
        <Icon name={entry.icon} size={16} />
        <span class="label">{entry.label}</span>
        {#if entry.count}<span class="count">{entry.count}</span>{/if}
      </a>
    {/each}
  </nav>

  <div class="footer">
    {#if sarvamKey.present !== null}
      <a
        class="foot-item"
        href={href.settings('sarvam')}
        title={sarvamKey.present ? 'Sarvam key saved — open settings' : 'Add a Sarvam API key to transcribe, translate and dub'}
      >
        <span class="status" class:ok={sarvamKey.present} aria-hidden="true"><Icon name="key" size={16} /></span>
        <span class="label">{sarvamKey.present ? 'Sarvam connected' : 'Add Sarvam key'}</span>
      </a>
    {/if}
    {#if library.info}
      {@const blocked = storageAccess.blocked}
      <button
        type="button"
        class="foot-item"
        title={blocked
          ? `Butterfly Record can’t save to ${library.info.root}. Show how to fix it`
          : `Open ${library.info.root} in File Explorer`}
        onclick={blocked ? () => storageAccess.open() : openFolder}
      >
        {#if blocked}
          <span class="status caution" aria-hidden="true"><Icon name="alert" size={16} /></span>
        {:else}
          <Icon name="folder" size={16} />
        {/if}
        <span class="label folder">
          <span class="folder-name">{folderName}</span>
          <span class="free">{blocked ? 'Can’t save here' : `${formatBytes(library.info.freeBytes)} free`}</span>
        </span>
      </button>
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 232px;
    height: 100%;
    padding: var(--space-3) var(--space-2);
    border-right: 1px solid var(--hairline);
    background: var(--bg-sunken);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 var(--space-2);
    margin-bottom: var(--space-2);
  }

  .brand-name {
    font-size: var(--text-md);
    font-weight: 600;
    white-space: nowrap;
  }

  .new {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    margin-bottom: var(--space-3);
    padding: 0 var(--space-3);
    border-radius: var(--radius-control);
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
    transition: background-color var(--motion-fast);
  }

  .new:hover {
    background: var(--accent-hover);
  }

  .new:active {
    opacity: 0.88;
  }

  .new.live {
    border: 1px solid var(--hairline-strong);
    background: var(--bg-elevated);
    color: var(--fg);
  }

  .new.live:hover {
    background: var(--fill-hover);
  }

  .rec {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--record);
  }

  .new.live .rec:not(.paused) {
    animation: pulse 1.6s ease-in-out infinite;
  }

  .rec.paused {
    background: var(--fg-muted);
  }

  .timer {
    margin-left: var(--space-1);
    font-variant-numeric: tabular-nums;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item,
  .foot-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 32px;
    padding: 0 var(--space-2) 0 var(--space-3);
    border: none;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--fg);
    font-size: var(--text-md);
    text-align: left;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }

  .nav-item:hover,
  .foot-item:hover {
    background: var(--fill-hover);
  }

  .nav-item:active,
  .foot-item:active {
    background: var(--fill-active);
  }

  .nav-item[aria-current='page'] {
    background: var(--fill-active);
    font-weight: 600;
  }

  .nav-item[aria-current='page']::before {
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 0;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
    content: '';
  }

  .nav-item :global(svg),
  .foot-item :global(svg) {
    color: var(--fg-muted);
  }

  .nav-item[aria-current='page'] :global(svg),
  .nav-item[aria-current='page'] .count {
    color: var(--fg);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .count {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .footer {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: auto;
    padding-top: var(--space-2);
    border-top: 1px solid var(--hairline);
  }

  .status.ok :global(svg) {
    color: var(--ok);
  }

  .status.caution :global(svg) {
    color: var(--caution);
  }

  .foot-item:has(.folder) {
    height: 44px;
  }

  .folder {
    display: flex;
    flex-direction: column;
  }

  .folder-name {
    overflow: hidden;
    line-height: 18px;
    text-overflow: ellipsis;
  }

  .free {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .new:focus-visible,
  .nav-item:focus-visible,
  .foot-item:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  /* Narrow windows fold the sidebar into an icon rail so content keeps its room. */
  @media (max-width: 1099px) {
    .sidebar {
      width: 56px;
      align-items: center;
    }

    .brand {
      justify-content: center;
      width: 40px;
      padding: 0;
    }

    .brand-name,
    .label,
    .count {
      display: none;
    }

    .new {
      justify-content: center;
      width: 40px;
      padding: 0;
    }

    .nav-item,
    .foot-item {
      justify-content: center;
      width: 40px;
      padding: 0;
    }

    nav,
    .footer {
      align-items: center;
    }

    .footer {
      width: 40px;
    }

    .foot-item:has(.folder) {
      height: 32px;
    }
  }
</style>
