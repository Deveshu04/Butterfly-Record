<script lang="ts">
  import Button from './Button.svelte'
  import Dialog from './Dialog.svelte'
  import { confirmDialog, type ConfirmRequest } from './confirm.svelte.ts'

  const request = $derived(confirmDialog.current)
  // The dialog stays mounted while it closes, so the browser can hand focus back to the opener.
  let shown = $state<ConfirmRequest | null>(null)
  let open = $state(false)

  $effect(() => {
    if (request) shown = request
    open = request !== null
  })
</script>

{#if shown}
  <Dialog bind:open title={shown.title} description={shown.message} onclose={() => confirmDialog.settle(false)}>
    {#snippet footer()}
      <Button onclick={() => confirmDialog.settle(false)}>Cancel</Button>
      <Button variant={shown?.danger ? 'danger' : 'primary'} onclick={() => confirmDialog.settle(true)}>
        {shown?.confirmLabel}
      </Button>
    {/snippet}
  </Dialog>
{/if}
