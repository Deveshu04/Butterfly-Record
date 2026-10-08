<script lang="ts">
  import { onMount } from 'svelte'

  const {
    drawing,
    colour,
    clickHighlight,
    cursorSpotlight,
  }: {
    drawing: boolean
    colour: string
    clickHighlight: boolean
    cursorSpotlight: boolean
  } = $props()

  // Durations in ms, sizes in CSS pixels.
  const STROKE_LIFETIME = 4000
  const STROKE_FADE = 1200
  const CLICK_LIFETIME = 600
  const LINE_WIDTH = 4
  const SPOTLIGHT_RADIUS = 46

  interface Stroke {
    points: Array<{ x: number; y: number }>
    colour: string
    /** Timestamp of the last point; the fade clock starts when drawing stops. */
    finishedAt: number | null
  }

  interface Ripple {
    x: number
    y: number
    at: number
  }

  let canvas: HTMLCanvasElement | null = $state(null)
  let strokes: Stroke[] = []
  let ripples: Ripple[] = []
  let cursor: { x: number; y: number } | null = null
  let active: Stroke | null = null

  function resize(context: CanvasRenderingContext2D) {
    const target = canvas
    if (!target) return
    // Backing store in device pixels, CSS box in layout pixels, so lines stay sharp on HiDPI.
    const ratio = window.devicePixelRatio || 1
    target.width = Math.floor(window.innerWidth * ratio)
    target.height = Math.floor(window.innerHeight * ratio)
    target.style.width = `${window.innerWidth}px`
    target.style.height = `${window.innerHeight}px`
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  function draw(context: CanvasRenderingContext2D, now: number) {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight)

    if (cursorSpotlight && cursor) {
      const glow = context.createRadialGradient(
        cursor.x,
        cursor.y,
        0,
        cursor.x,
        cursor.y,
        SPOTLIGHT_RADIUS,
      )
      glow.addColorStop(0, 'rgba(255, 214, 0, 0.28)')
      glow.addColorStop(1, 'rgba(255, 214, 0, 0)')
      context.fillStyle = glow
      context.beginPath()
      context.arc(cursor.x, cursor.y, SPOTLIGHT_RADIUS, 0, Math.PI * 2)
      context.fill()
    }

    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = LINE_WIDTH

    for (const stroke of strokes) {
      const age = stroke.finishedAt === null ? 0 : now - stroke.finishedAt
      const remaining = STROKE_LIFETIME - age
      const alpha = remaining >= STROKE_FADE ? 1 : Math.max(0, remaining / STROKE_FADE)
      if (alpha <= 0) continue

      context.globalAlpha = alpha
      context.strokeStyle = stroke.colour
      context.beginPath()
      stroke.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      context.stroke()
    }

    for (const ripple of ripples) {
      const progress = (now - ripple.at) / CLICK_LIFETIME
      if (progress >= 1) continue
      context.globalAlpha = 1 - progress
      context.strokeStyle = 'rgba(255, 214, 0, 0.95)'
      context.lineWidth = 3
      context.beginPath()
      context.arc(ripple.x, ripple.y, 8 + progress * 26, 0, Math.PI * 2)
      context.stroke()
    }

    context.globalAlpha = 1

    // Prune faded items so the arrays stay bounded over long recordings.
    strokes = strokes.filter(
      (stroke) => stroke.finishedAt === null || now - stroke.finishedAt < STROKE_LIFETIME,
    )
    ripples = ripples.filter((ripple) => now - ripple.at < CLICK_LIFETIME)
  }

  onMount(() => {
    const context = canvas?.getContext('2d')
    if (!context) return

    resize(context)
    const onResize = () => resize(context)
    window.addEventListener('resize', onResize)

    // Passive capture listeners: observe page input without swallowing or delaying it.
    const onPointerMove = (event: PointerEvent) => {
      cursor = { x: event.clientX, y: event.clientY }
    }
    const onClick = (event: PointerEvent) => {
      if (clickHighlight) ripples.push({ x: event.clientX, y: event.clientY, at: performance.now() })
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
    window.addEventListener('pointerdown', onClick, { passive: true, capture: true })

    let frame = requestAnimationFrame(function loop(now: number) {
      draw(context, now)
      frame = requestAnimationFrame(loop)
    })

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      window.removeEventListener('pointerdown', onClick, { capture: true })
    }
  })

  function startStroke(event: PointerEvent) {
    if (!drawing) return
    event.preventDefault()
    canvas?.setPointerCapture(event.pointerId)
    active = { points: [{ x: event.clientX, y: event.clientY }], colour, finishedAt: null }
    strokes.push(active)
  }

  function extendStroke(event: PointerEvent) {
    if (!active) return
    active.points.push({ x: event.clientX, y: event.clientY })
  }

  function endStroke(event: PointerEvent) {
    if (!active) return
    canvas?.releasePointerCapture(event.pointerId)
    active.finishedAt = performance.now()
    active = null
  }
</script>

<canvas
  bind:this={canvas}
  class:drawing
  onpointerdown={startStroke}
  onpointermove={extendStroke}
  onpointerup={endStroke}
  onpointercancel={endStroke}
></canvas>

<style>
  canvas {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2147482998;
    /* Transparent to the page unless the pen is out. */
    pointer-events: none;
  }

  canvas.drawing {
    pointer-events: auto;
    cursor: crosshair;
  }
</style>
