<script lang="ts">
  import { onMount } from 'svelte'
  import { library } from './lib/library.svelte.ts'
  import { recorder } from './lib/recorder.svelte.ts'
  import { settings } from './lib/settings.svelte.ts'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import Menu from './components/Menu.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import Toasts from './components/Toasts.svelte'
  import { baseName } from './components/format.ts'
  import { router } from './components/router.svelte.ts'
  import { sarvamKey } from './components/sarvam-key.svelte.ts'
  import { toasts } from './components/toasts.svelte.ts'
  import { applyTheme } from './components/theme.ts'
  import LibraryView from './views/LibraryView.svelte'
  import RecordView from './views/RecordView.svelte'
  import SettingsView from './views/SettingsView.svelte'
  import VideoView from './views/VideoView.svelte'

  const route = $derived(router.route)

  $effect(() => {
    applyTheme(settings.value.theme)
  })

  // Announce each finished recording once; the recorder itself opens its video page.
  let announced: string | null = recorder.lastSavedId
  $effect(() => {
    const id = recorder.lastSavedId
    if (!id || id === announced) return
    announced = id
    const folder = library.info ? baseName(library.info.root) : 'your library folder'
    toasts.push(`Saved to ${folder}`, {
      tone: 'ok',
      action: { label: 'Show in folder', run: () => library.reveal(id) },
    })
  })

  // Errors from recordings stopped elsewhere (HUD, shortcut) would otherwise go unseen.
  $effect(() => {
    const error = recorder.error
    if (!error || route.name === 'record') return
    toasts.push(error, { tone: 'error' })
    recorder.clearError()
  })

  onMount(() => {
    void sarvamKey.refresh()
  })
</script>

<div class="shell">
  <Sidebar />
  <main class="content">
    {#if route.name === 'video'}
      {#key route.id}
        <VideoView id={route.id} tab={route.tab} />
      {/key}
    {:else if route.name === 'record'}
      <RecordView />
    {:else if route.name === 'settings'}
      <SettingsView section={route.section} />
    {:else}
      <LibraryView filter={route.filter} />
    {/if}
  </main>
</div>

<Toasts />
<Menu />
<ConfirmDialog />

<style>
  .shell {
    display: flex;
    height: 100%;
  }

  .content {
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
</style>
