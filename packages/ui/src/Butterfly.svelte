<script lang="ts">
  /* Geometry must match assets/butterfly.svg and assets/icon.svg. */

  type State = 'idle' | 'active' | 'busy'

  let {
    size = 24,
    state = 'idle' as State,
    class: className = '',
  }: {
    /** Edge length in px; perspective scales with it. */
    size?: number
    /** idle = rest pose, active = 0.9s flap, busy = 0.45s flap, dimmed. */
    state?: State
    class?: string
  } = $props()
</script>

<svg
  class="butterfly {state} {className}"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  style="--size: {size}px"
  aria-hidden="true"
>
  <g class="wing left">
    <circle cx="7.2" cy="9" r="4.8" />
    <circle cx="8.2" cy="16" r="3.6" />
  </g>
  <g class="wing right">
    <circle cx="16.8" cy="9" r="4.8" />
    <circle cx="15.8" cy="16" r="3.6" />
  </g>
  <rect class="body" x="11.15" y="7.4" width="1.7" height="10" rx="0.85" />
  <path class="antenna" d="M11.7 7.6 C11.1 5.8 10 4.6 8.8 3.9" />
  <path class="antenna" d="M12.3 7.6 C12.9 5.8 14 4.6 15.2 3.9" />
</svg>

<style>
  .butterfly {
    /* ~4x the width keeps the fold from reading flat or fish-eyed. */
    perspective: calc(var(--size) * 4);
    /* Antenna tips can poke past the viewBox at large sizes. */
    overflow: visible;
    flex: none;
    color: inherit;
  }

  .wing {
    fill: currentColor;
    /* Without view-box the origin is the SVG's top-left and the wings orbit instead of flapping. */
    transform-box: view-box;
    transform-origin: center;
    animation: 0.9s ease-in-out infinite;
  }

  .wing.left {
    transform: rotateY(12deg);
    animation-name: flap-left;
  }

  .wing.right {
    transform: rotateY(-12deg);
    animation-name: flap-right;
  }

  /* Back to the rest pose: frozen mid-flap, the wings are too narrow to read. */
  .butterfly.idle .wing {
    animation: none;
  }

  .butterfly.busy {
    opacity: 0.7;
  }

  .butterfly.busy .wing {
    animation-duration: 0.45s;
  }

  .body {
    fill: currentColor;
  }

  .antenna {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: round;
  }

  /* 12deg..68deg: never edge-on, so the mark stays legible every frame. */
  @keyframes flap-left {
    0%,
    100% {
      transform: rotateY(12deg);
    }
    50% {
      transform: rotateY(68deg);
    }
  }

  @keyframes flap-right {
    0%,
    100% {
      transform: rotateY(-12deg);
    }
    50% {
      transform: rotateY(-68deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .wing {
      animation: none;
    }
  }
</style>
