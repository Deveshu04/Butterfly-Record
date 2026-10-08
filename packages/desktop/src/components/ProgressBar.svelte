<script lang="ts">
  let {
    value,
    label,
    tone = 'accent',
  }: {
    /** 0..1, or null when the amount of work is unknown. */
    value: number | null
    label: string
    tone?: 'accent' | 'record'
  } = $props()

  const percent = $derived(value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100))
</script>

<div
  class="track {tone}"
  class:indeterminate={percent === null}
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={percent ?? undefined}
>
  <span class="fill" style:width={percent === null ? undefined : `${percent}%`}></span>
</div>

<style>
  .track {
    position: relative;
    height: 4px;
    overflow: hidden;
    border-radius: var(--radius-pill);
    background: var(--fill-active);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--accent);
    transition: width var(--motion-slow);
  }

  .record .fill {
    background: var(--record);
  }

  .indeterminate .fill {
    width: 30%;
    animation: slide 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .indeterminate .fill {
      width: 100%;
      opacity: 0.35;
      animation: none;
    }
  }
</style>
