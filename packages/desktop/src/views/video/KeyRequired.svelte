<script lang="ts">
  import Button from '../../components/Button.svelte'
  import EmptyState from '../../components/EmptyState.svelte'
  import { href, navigate } from '../../components/router.svelte.ts'

  let { action }: { action: string } = $props()
</script>

<EmptyState
  icon="key"
  compact
  title="Add your Sarvam API key"
  message="{action} uses Sarvam with your own API key. Audio is sent only when you start a job."
>
  {#snippet actions()}
    <Button variant="primary" onclick={() => navigate(href.settings('sarvam'))}>Open Sarvam settings</Button>
  {/snippet}
</EmptyState>
