// Draws the camera into window recordings, frame by frame, off the main thread: the main
// window is minimized while recording, so nothing paced on its event loop can be trusted.
// Pacing comes from the screen track itself — one output frame per captured frame, with
// the captured timestamp kept so the recording stays in sync.

import { DEFAULT_CAMERA_EFFECTS, effectsActive, needsSegmentation } from '../camera-effects.ts'
import { cameraRect, type CompositeRect } from '../camera-layout.ts'
import type { CameraEffect } from '../effects/camera-effect.ts'
import { coverRect, type CompositeFrame, type CompositeRequest } from './composite-protocol.ts'

interface WorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<CompositeRequest>) => void): void
}

const scope = self as unknown as WorkerScope

let frame: CompositeFrame = {
  shape: 'circle',
  size: 240,
  anchor: null,
  corner: 'bottom-right',
  mirror: true,
  hidden: false,
  effects: DEFAULT_CAMERA_EFFECTS,
}
let latest: VideoFrame | null = null
/** Counts camera frames, so the effect runs once per camera frame rather than per screen frame. */
let cameraSerial = 0
let stopped = false
let started = false
let effect: CameraEffect | null = null
/** Set while the effect loads; a background the user asked to hide is never drawn meanwhile. */
let effectLoading = false
/** What the effect canvas holds: which camera frame, drawn at which size. */
let drawn = { serial: -1, w: 0, h: 0 }

function settings(message: CompositeFrame): CompositeFrame {
  return {
    shape: message.shape,
    size: message.size,
    anchor: message.anchor,
    corner: message.corner,
    mirror: message.mirror,
    hidden: message.hidden,
    effects: message.effects,
  }
}

function dropCamera(): void {
  latest?.close()
  latest = null
}

/** The camera runs at its own rate: every screen frame uses the newest one that arrived. */
async function readCamera(stream: ReadableStream<VideoFrame>): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      dropCamera()
      if (stopped) {
        value.close()
        return
      }
      latest = value
      cameraSerial++
    }
  } finally {
    dropCamera()
    await reader.cancel().catch(() => {})
  }
}

async function startEffect(background: ImageBitmap | null): Promise<void> {
  if (!effectsActive(frame.effects)) {
    background?.close()
    return
  }
  effectLoading = true
  let created: CameraEffect | null = null
  try {
    const { CameraEffect } = await import('../effects/camera-effect.ts')
    created = new CameraEffect(new OffscreenCanvas(1, 1))
    created.setEffects(frame.effects)
    created.setImage(background)
    await created.prepare()
    if (stopped) created.close()
    else effect = created
  } catch (error) {
    created?.close()
    effectFailed(error)
  } finally {
    effectLoading = false
    background?.close()
  }
}

function effectFailed(error: unknown): void {
  console.warn('[butterfly-record] camera effect unavailable in the recording', error)
  effect?.close()
  effect = null
  scope.postMessage({
    type: 'effects-failed',
    message: 'The camera is being recorded without its background effect.',
  })
}

/**
 * The camera with its effect; null to draw the plain frame instead. Until the person has
 * been found, a background the user asked to hide is not shown at all: 'hide'.
 */
function withEffect(camera: VideoFrame, rect: CompositeRect): OffscreenCanvas | 'hide' | null {
  const hiding = needsSegmentation(frame.effects)
  if (!effect) return effectLoading && hiding ? 'hide' : null
  if (drawn.serial !== cameraSerial || drawn.w !== rect.w || drawn.h !== rect.h) {
    let ok = false
    try {
      const view = { width: rect.w, height: rect.h, mirror: frame.mirror }
      ok = effect.draw(camera, camera.displayWidth, camera.displayHeight, view)
    } catch (error) {
      effectFailed(error)
      return null
    }
    if (!ok) {
      const failure = effect.failure
      if (!failure) return hiding ? 'hide' : null
      effectFailed(failure)
      return null
    }
    drawn = { serial: cameraSerial, w: rect.w, h: rect.h }
  }
  return effect.canvas as OffscreenCanvas
}

function drawPlain(
  context: OffscreenCanvasRenderingContext2D,
  camera: VideoFrame,
  rect: CompositeRect,
): void {
  const source = coverRect(camera.displayWidth, camera.displayHeight, rect.w, rect.h)
  if (frame.mirror) {
    // Flip around the frame's own centre, so the clip keeps its place.
    context.translate(rect.x * 2 + rect.w, 0)
    context.scale(-1, 1)
  }
  context.drawImage(
    camera,
    source.x,
    source.y,
    source.w,
    source.h,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
  )
}

function drawCamera(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  camera: VideoFrame,
): void {
  const rect = cameraRect(width, height, frame.shape, frame.size, frame)
  const styled = withEffect(camera, rect)
  if (styled === 'hide') return
  context.save()
  context.beginPath()
  context.roundRect(rect.x, rect.y, rect.w, rect.h, rect.radius)
  context.clip()
  // The effect is drawn cropped and mirrored already.
  if (styled) context.drawImage(styled, rect.x, rect.y, rect.w, rect.h)
  else drawPlain(context, camera, rect)
  context.restore()
}

async function compose(
  screen: ReadableStream<VideoFrame>,
  output: WritableStream<VideoFrame>,
): Promise<void> {
  const reader = screen.getReader()
  const writer = output.getWriter()
  let canvas: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null

  try {
    for (;;) {
      const { value: source, done } = await reader.read()
      if (done) break
      if (stopped) {
        source.close()
        break
      }

      const width = source.displayWidth
      const height = source.displayHeight
      if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height)
        context = canvas.getContext('2d', { alpha: false })
      }
      if (!context) throw new Error('This computer cannot draw the camera into the recording.')

      context.drawImage(source, 0, 0, width, height)
      const camera = latest
      if (!frame.hidden && camera) drawCamera(context, width, height, camera)

      const init: VideoFrameInit =
        source.duration === null
          ? { timestamp: source.timestamp, alpha: 'discard' }
          : { timestamp: source.timestamp, duration: source.duration, alpha: 'discard' }
      source.close()
      const composed = new VideoFrame(canvas, init)
      await writer.write(composed)
      // The sink takes ownership, but closing twice is harmless and leaks nothing if it did not.
      composed.close()
    }
    await writer.close().catch(() => {})
  } finally {
    await reader.cancel().catch(() => {})
    stopped = true
    dropCamera()
    effect?.close()
    effect = null
  }
}

scope.addEventListener('message', (event: MessageEvent<CompositeRequest>) => {
  const message = event.data
  if (message.type === 'stop') {
    stopped = true
    return
  }
  if (message.type === 'update') {
    frame = settings(message)
    effect?.setEffects(frame.effects)
    drawn.serial = -1
    return
  }
  if (started) {
    message.background?.close()
    return
  }
  started = true
  frame = settings(message)
  void startEffect(message.background)
  void readCamera(message.camera)
  compose(message.screen, message.output).then(
    () => scope.postMessage({ type: 'ended' }),
    (error: unknown) => {
      stopped = true
      scope.postMessage({
        type: 'failed',
        message: error instanceof Error ? error.message : 'The camera could not be recorded.',
      })
    },
  )
})
