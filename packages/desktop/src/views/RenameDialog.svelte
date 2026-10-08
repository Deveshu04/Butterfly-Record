<script lang="ts">
  import { untrack } from 'svelte'
  import { errorMessage } from '../lib/ipc.ts'
  import { library, type VideoItem } from '../lib/library.svelte.ts'
  import Button from '../components/Button.svelte'
  import Dialog from '../components/Dialog.svelte'
  import TextField from '../components/TextField.svelte'

  let { item, onclose }: { item: VideoItem; onclose: () => void } = $props()

  const uid = $props.id()
  let open = $state(true)
  let title = $state(untrack(() => item.title))
  let saving = $state(false)
  let error = $state('')
  let input: HTMLInputElement | undefined = $state()

  const trimmed = $derived(title.trim())

  $effect(() => {
    input?.select()
  })

  $effect(() => {
    void title
    error = ''
  })

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (!trimmed || saving) return
    if (trimmed === item.title) {
      open = false
      return
    }
    saving = true
    error = ''
    try {
      await library.rename(item.id, trimmed)
      open = false
    } catch (failure) {
      error = errorMessage(failure)
    } finally {
      saving = false
    }
  }
</script>

<Dialog bind:open title="Rename video" {onclose}>
  <form id="{uid}-form" onsubmit={save}>
    <label class="label" for="{uid}-title">Name</label>
    <TextField
      id="{uid}-title"
      bind:value={title}
      bind:element={input}
      wide
      maxlength={200}
      invalid={Boolean(error)}
      aria-describedby={error ? `${uid}-error` : undefined}
    />
    {#if error}
      <p id="{uid}-error" class="error" role="alert">{error}</p>
    {/if}
    {#if !item.external}
      <p class="hint">The video file in your library folder is renamed to match.</p>
    {/if}
  </form>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="{uid}-form" busy={saving} disabled={!trimmed}>Rename</Button>
  {/snippet}
</Dialog>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .label {
    font-weight: 500;
  }

  .error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    line-height: 16px;
    user-select: text;
  }

  .hint {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }
</style>
