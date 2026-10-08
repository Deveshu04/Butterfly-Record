<script lang="ts" module>
  export type IconName =
    | 'monitor'
    | 'browser'
    | 'window'
    | 'camera'
    | 'camera-off'
    | 'mic'
    | 'mic-off'
    | 'close'
    | 'chevron-left'
    | 'chevron-right'
    | 'check'
    | 'stop'
    | 'pause'
    | 'play'
    | 'restart'
    | 'trash'
    | 'library'
    | 'pen'
    | 'cursor'
    | 'settings'
    | 'folder'
    | 'folder-open'
    | 'search'
    | 'download'
    | 'upload'
    | 'import'
    | 'plus'
    | 'more'
    | 'grid'
    | 'list'
    | 'captions'
    | 'translate'
    | 'dub'
    | 'text'
    | 'external'
    | 'info'
    | 'alert'
    | 'key'
    | 'refresh'
    | 'sort'
    | 'film'
    | 'user'
    | 'check-circle'
    | 'x-circle'
    | 'chevron-down'
    | 'keyboard'
    | 'grip'
    | 'volume'
    | 'volume-low'
    | 'volume-off'
    | 'fullscreen'
    | 'fullscreen-exit'

  const PATHS: Record<IconName, string> = {
    monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    browser: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M2.5 9h19M7 6.5h.01M10 6.5h.01"/>',
    window: '<rect x="3" y="6" width="14" height="12" rx="2"/><path d="M8 6V4.5a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 21 4.5v10a1.5 1.5 0 0 1-1.5 1.5H18"/>',
    camera: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3z"/>',
    'camera-off': '<path d="M15.5 10.5 21 7.5v9l-2-1.1"/><path d="M12.5 6H13a2.5 2.5 0 0 1 2.5 2.5V9M2.5 8.5A2.5 2.5 0 0 1 5 6h1.5M2.5 8.5v7A2.5 2.5 0 0 0 5 18h8a2.5 2.5 0 0 0 2.4-1.8"/><path d="m3 3 18 18"/>',
    mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
    'mic-off': '<path d="M15 4.5A3 3 0 0 0 9 5v5m0 2.5a3 3 0 0 0 5.7 1.3"/><path d="M5.5 11a6.5 6.5 0 0 0 10.2 5.3M18.5 11v.5M12 17.5V21M8.5 21h7"/><path d="m3 3 18 18"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    'chevron-left': '<path d="m15 5-7 7 7 7"/>',
    'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/>',
    pause: '<path d="M9 4.5v15M15 4.5v15"/>',
    play: '<path d="M7 4.5 19 12 7 19.5z"/>',
    restart: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/>',
    trash: '<path d="M4 6.5h16M9.5 6.5V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5v2"/><path d="M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5"/><path d="M10 10.5v7M14 10.5v7"/>',
    library: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M10 9.5 15 12l-5 2.5z"/>',
    pen: '<path d="M15.5 4.5 19.5 8.5"/><path d="M17 3a2.1 2.1 0 0 1 3 3L8.5 17.5 3.5 19l1.5-5z"/>',
    cursor: '<path d="M5 3.5 18.5 11l-6 1.6L9.6 18z"/><path d="M15 15.5 20 20.5"/>',
    settings: '<path d="M9.96 4.89L10.33 2.55A9.6 9.6 0 0 1 13.67 2.55L14.04 4.89A7.4 7.4 0 0 1 15.59 5.53L17.51 4.14A9.6 9.6 0 0 1 19.86 6.49L18.47 8.41A7.4 7.4 0 0 1 19.11 9.96L21.45 10.33A9.6 9.6 0 0 1 21.45 13.67L19.11 14.04A7.4 7.4 0 0 1 18.47 15.59L19.86 17.51A9.6 9.6 0 0 1 17.51 19.86L15.59 18.47A7.4 7.4 0 0 1 14.04 19.11L13.67 21.45A9.6 9.6 0 0 1 10.33 21.45L9.96 19.11A7.4 7.4 0 0 1 8.41 18.47L6.49 19.86A9.6 9.6 0 0 1 4.14 17.51L5.53 15.59A7.4 7.4 0 0 1 4.89 14.04L2.55 13.67A9.6 9.6 0 0 1 2.55 10.33L4.89 9.96A7.4 7.4 0 0 1 5.53 8.41L4.14 6.49A9.6 9.6 0 0 1 6.49 4.14L8.41 5.53A7.4 7.4 0 0 1 9.96 4.89z"/><circle cx="12" cy="12" r="3"/>',
    folder: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6a1.5 1.5 0 0 1 1.2.6L11.2 8H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 17.5V7.5a2 2 0 0 1 2-2h3.6a1.5 1.5 0 0 1 1.2.6L11.2 8H17a2 2 0 0 1 2 2v1"/><path d="M3 17.5 5.6 12a1.5 1.5 0 0 1 1.4-.9h13a1 1 0 0 1 .9 1.4l-2.4 5.9a1.5 1.5 0 0 1-1.4 1.1H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    download: '<path d="M12 3.5v12M7 10.5l5 5 5-5M4.5 20h15"/>',
    upload: '<path d="M12 15.5v-12M7 8.5l5-5 5 5M4.5 20h15"/>',
    import: '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M3.5 12H14M10 8l4 4-4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
    captions: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10.6 10.2a2.4 2.4 0 1 0 0 3.6M17.1 10.2a2.4 2.4 0 1 0 0 3.6"/>',
    translate: '<path d="M2.5 5.5h9M7 3.5v2M4.5 8.5c1.2 3 3.4 5.2 6.3 6.3M9.5 5.5c-.8 4.2-3 7.4-6.5 9.3"/><path d="m12.5 20.5 4.25-10 4.25 10M14 17h5.5"/>',
    dub: '<path d="M3.5 10a1 1 0 0 1 1-1h2.8l4.2-3.7v13.4L7.3 15H4.5a1 1 0 0 1-1-1z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.5a7.6 7.6 0 0 1 0 11"/>',
    text: '<path d="M4 6h16M4 10h16M4 14h16M4 18h10"/>',
    external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
    alert: '<path d="M10.3 4.3 2.7 17.5a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17.2" r="1.1" fill="currentColor" stroke="none"/>',
    key: '<circle cx="8" cy="15.5" r="4.5"/><path d="m11.2 12.3 8.8-8.8M16 7.5l2.5 2.5M13.5 10l2 2"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
    sort: '<path d="M7 4.5v15M3.5 16 7 19.5l3.5-3.5M17 19.5v-15M13.5 8 17 4.5 20.5 8"/>',
    film: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M7.5 3.5v17M16.5 3.5v17M3 8h4.5M3 12h18M3 16h4.5M16.5 8H21M16.5 16H21"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8 5.2-5.6"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    'chevron-down': '<path d="m5 9 7 7 7-7"/>',
    keyboard: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M8 15h8"/><circle cx="6.5" cy="9.5" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="9.5" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="9.5" r="1" fill="currentColor" stroke="none"/><circle cx="17.5" cy="9.5" r="1" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.2" r="1" fill="currentColor" stroke="none"/><circle cx="17.5" cy="12.2" r="1" fill="currentColor" stroke="none"/>',
    grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
    volume: '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.3 6.3a8 8 0 0 1 0 11.4"/>',
    'volume-low': '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/>',
    'volume-off': '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    fullscreen: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    'fullscreen-exit': '<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>',
  }
</script>

<script lang="ts">
  let {
    name,
    size = 18,
    strokeWidth = 1.6,
    class: className = '',
  }: {
    name: IconName
    size?: number
    strokeWidth?: number
    class?: string
  } = $props()
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- a fixed internal table, never user input -->
  {@html PATHS[name]}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
