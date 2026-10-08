<script lang="ts">
  import { Icon } from '@butterfly-record/ui'
  import { jobs, type Job } from '../lib/jobs.svelte.ts'
  import Button from './Button.svelte'
  import IconButton from './IconButton.svelte'
  import ProgressBar from './ProgressBar.svelte'
  import { jobOutcome, jobTitle } from './job-labels.ts'
  import { toasts } from './toasts.svelte.ts'

  let { job }: { job: Job } = $props()

  let cancelling = $state(false)

  async function cancel() {
    cancelling = true
    try {
      await jobs.cancel(job.task)
    } catch (error) {
      toasts.error(error)
    } finally {
      cancelling = false
    }
  }
</script>

{#if job.state === 'running'}
  <div class="job" aria-live="polite">
    <div class="head">
      <span class="title">{jobTitle(job)}</span>
      {#if job.fraction !== null}<span class="percent">{Math.round(job.fraction * 100)}%</span>{/if}
    </div>
    <ProgressBar value={job.fraction} label={jobTitle(job)} />
    <div class="foot">
      <span class="stage">{job.message || job.stage}</span>
      <Button size="sm" variant="ghost" busy={cancelling} onclick={cancel}>Cancel</Button>
    </div>
  </div>
{:else if job.state === 'failed'}
  <div class="job failed" role="alert">
    <span class="icon"><Icon name="alert" size={16} /></span>
    <div class="text">
      <span class="title">{jobOutcome(job, 'failed')}</span>
      <span class="error">{job.error ?? 'Something went wrong.'}</span>
    </div>
    <IconButton icon="close" label="Dismiss" size="sm" tone="muted" onclick={() => jobs.dismiss(job.task)} />
  </div>
{:else if job.state === 'cancelled'}
  <div class="job cancelled">
    <span class="icon"><Icon name="info" size={16} /></span>
    <div class="text"><span class="title">{jobOutcome(job, 'cancelled')}</span></div>
    <IconButton icon="close" label="Dismiss" size="sm" tone="muted" onclick={() => jobs.dismiss(job.task)} />
  </div>
{/if}

<style>
  .job {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    background: var(--bg);
  }

  .failed,
  .cancelled {
    flex-direction: row;
    align-items: flex-start;
  }

  .head,
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .foot {
    margin: -4px -4px -4px 0;
  }

  .title {
    font-weight: 600;
    line-height: 20px;
  }

  .percent {
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }

  .stage {
    overflow: hidden;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    height: 20px;
    color: var(--fg-muted);
  }

  .failed .icon {
    color: var(--danger);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .error {
    color: var(--fg-muted);
    line-height: 20px;
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
