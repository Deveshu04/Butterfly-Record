// Messages between a camera effect and the worker that runs the segmentation model.

import type { Delegate } from '../effects/segmenter.ts'

export type SegmentRequest =
  | { type: 'start'; delegate: Delegate }
  /** The worker takes ownership of the image. */
  | { type: 'segment'; image: ImageBitmap }

export type SegmentReply =
  /** The model has run once, so the next frame is answered at full speed. */
  | { type: 'ready'; delegate: Delegate }
  | { type: 'failed'; delegate: Delegate; message: string }
  /** Person confidence from 0 to 1, rows top first; `values` is null when nothing came back. */
  | { type: 'mask'; values: Float32Array | null; width: number; height: number }
