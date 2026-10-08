<script lang="ts">
  import type { VideoStatus } from '../../lib/library.svelte.ts'
  import EmptyState from '../../components/EmptyState.svelte'

  let { status, action }: { status: VideoStatus; action: string } = $props()

  const message = $derived(
    status === 'needs-recovery'
      ? `Recover the recording first. ${action} works on the finished video file.`
      : status === 'recording'
        ? `${action} is available once the recording is saved.`
        : `${action} needs the video file, which can no longer be found.`,
  )
</script>

<EmptyState icon={status === 'recording' ? 'film' : 'alert'} compact {message} />
