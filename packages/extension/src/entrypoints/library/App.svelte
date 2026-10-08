<script lang="ts">
  import { onMount } from 'svelte'
  import { Butterfly } from '@butterfly-record/ui'
  import { isUlid, purgeExpiredTrash } from '@butterfly-record/core'
  import Editor from './Editor.svelte'
  import Library from './Library.svelte'
  import Trash from './Trash.svelte'
  import VideoPage from './VideoPage.svelte'

  type Route =
    | { name: 'library' }
    | { name: 'trash' }
    | { name: 'video'; id: string }
    | { name: 'edit'; id: string }

  let route = $state<Route>(parseHash())

  function parseHash(): Route {
    if (window.location.hash.startsWith('#/trash')) return { name: 'trash' }
    const match = window.location.hash.match(/^#\/v\/([^/?]+)(\/edit)?/)
    const id = match?.[1]
    if (!id || !isUlid(id)) return { name: 'library' }
    return match?.[2] ? { name: 'edit', id } : { name: 'video', id }
  }

  onMount(() => {
    // No background timer exists, so expired trash is purged on page open.
    void purgeExpiredTrash()

    const onHashChange = () => {
      route = parseHash()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  })

  function open(id: string) {
    window.location.hash = `#/v/${id}`
  }

  function back() {
    window.location.hash = '#/'
  }
</script>

<div class="shell">
  <header>
    <a class="brand" href="#/" aria-label="Butterfly Record library">
      <Butterfly size={20} state="idle" />
      <strong>Butterfly Record</strong>
    </a>
  </header>

  {#if route.name === 'edit'}
    <!-- A const, because TypeScript widens `route` again inside the deferred callback. -->
    {@const editId = route.id}
    <Editor id={editId} onback={() => (window.location.hash = `#/v/${editId}`)} />
  {:else if route.name === 'video'}
    <VideoPage id={route.id} onback={back} />
  {:else if route.name === 'trash'}
    <Trash onback={back} />
  {:else}
    <Library onopen={open} />
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-ui);
    font-size: 14px;
  }

  .shell {
    min-height: 100vh;
  }

  header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    height: 52px;
    padding: 0 20px;
    border-bottom: 1px solid var(--hairline);
    background: var(--bg);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    color: inherit;
    text-decoration: none;
  }

  strong {
    font-size: 14px;
    font-weight: 600;
  }
</style>
