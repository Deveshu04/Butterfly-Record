// Draws the camera into window recordings, frame by frame, off the main thread: the main
// window is minimized while recording, so nothing paced on its event loop can be trusted.
// Pacing comes from the screen track itself — one output frame per captured frame, with
// the captured timestamp kept so the recording stays in sync.

import { cameraRect } from '../camera-layout.ts'
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
}
let latest: VideoFrame | null = null
let stopped = false
let started = false

function settings(message: CompositeFrame): CompositeFrame {
  return {
    shape: message.shape,
    size: message.size,
    anchor: message.anchor,
    corner: message.corner,
    mirror: message.mirror,
    hidden: message.hidden,
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
    }
  } finally {
    dropCamera()
    await reader.cancel().catch(() => {})
  }
}

function drawCamera(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  camera: VideoFrame,
): void {
  const rect = cameraRect(width, height, frame.shape, frame.size, frame)
  const source = coverRect(camera.displayWidth, camera.displayHeight, rect.w, rect.h)
  context.save()
  context.beginPath()
  context.roundRect(rect.x, rect.y, rect.w, rect.h, rect.radius)
  context.clip()
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
    return
  }
  if (started) return
  started = true
  frame = settings(message)
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
