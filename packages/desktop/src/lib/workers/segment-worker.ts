// Runs the segmentation model off the thread that draws the camera, so a slow frame of the
// model never holds up the overlay or the recording.

import { Segmenter, type Delegate } from '../effects/segmenter.ts'
import type { SegmentReply, SegmentRequest } from './segment-protocol.ts'

interface WorkerScope {
  postMessage(message: SegmentReply, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<SegmentRequest>) => void): void
}

const scope = self as unknown as WorkerScope
/** The size the model works at; warming up at it compiles everything a real frame needs. */
const WARM_UP_SIZE = 256

let segmenter: Segmenter | null = null

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function start(delegate: Delegate): Promise<void> {
  try {
    const created = await Segmenter.create(delegate)
    // The first run compiles the model for the device, which can take seconds on a GPU;
    // better here than on the first real frame.
    created.segment(new OffscreenCanvas(WARM_UP_SIZE, WARM_UP_SIZE))
    segmenter = created
    scope.postMessage({ type: 'ready', delegate })
  } catch (error) {
    scope.postMessage({ type: 'failed', delegate, message: describe(error) })
  }
}

function segment(image: ImageBitmap): void {
  const { width, height } = image
  let values: Float32Array | null
  try {
    values = segmenter ? segmenter.segment(image) : null
  } catch (error) {
    const delegate = segmenter?.delegate ?? 'CPU'
    scope.postMessage({ type: 'failed', delegate, message: describe(error) })
    return
  } finally {
    image.close()
  }
  scope.postMessage({ type: 'mask', values, width, height }, values ? [values.buffer] : [])
}

scope.addEventListener('message', ({ data }) => {
  if (data.type === 'start') void start(data.delegate)
  else segment(data.image)
})
