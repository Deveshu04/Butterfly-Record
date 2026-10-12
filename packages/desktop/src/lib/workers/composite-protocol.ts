// Shared by the window-recording compositor and the worker that does the drawing: the
// messages between them, and the small helpers that belong to neither side alone.

import type { CameraEffects } from '../camera-effects.ts'
import type { CameraAnchor, CameraCorner, CameraShape } from '../camera-layout.ts'

/** Everything the worker needs to know about how the camera should look. */
export interface CompositeFrame {
  shape: CameraShape
  /** Overlay width in logical pixels, scaled to the output by cameraRect. */
  size: number
  /** Where the overlay sits on the desktop; null while that is unknown. */
  anchor: CameraAnchor | null
  /** Used only when there is no anchor to follow. */
  corner: CameraCorner
  mirror: boolean
  /** The recording bar's camera toggle: the screen keeps recording without the camera. */
  hidden: boolean
  effects: CameraEffects
}

/** What a drag or a resize of the overlay changes about the drawn camera. */
export interface OverlayPlacement {
  anchor: CameraAnchor | null
  /** Overlay width in logical pixels. */
  size: number
}

/** Drags that land the overlay where it already was do not need a message. */
export function sameAnchor(a: CameraAnchor | null, b: CameraAnchor | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y
}

export function samePlacement(a: OverlayPlacement, b: OverlayPlacement): boolean {
  return a.size === b.size && sameAnchor(a.anchor, b.anchor)
}

export interface CompositeStart extends CompositeFrame {
  type: 'start'
  screen: ReadableStream<VideoFrame>
  camera: ReadableStream<VideoFrame>
  output: WritableStream<VideoFrame>
  /** The chosen background picture, decoded; the worker takes ownership. */
  background: ImageBitmap | null
}

export interface CompositeUpdate extends CompositeFrame {
  type: 'update'
}

export type CompositeRequest = CompositeStart | CompositeUpdate | { type: 'stop' }

export type CompositeEvent =
  | { type: 'ended' }
  | { type: 'failed'; message: string }
  /** The camera goes on being drawn, without its background effect or touch-up. */
  | { type: 'effects-failed'; message: string }

export interface SourceRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The part of a camera frame to draw so it fills a frame of another ratio without
 * stretching: the same crop CSS `object-fit: cover` would make, centred.
 */
export function coverRect(
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number,
): SourceRect {
  if (sourceW <= 0 || sourceH <= 0 || targetW <= 0 || targetH <= 0) {
    return { x: 0, y: 0, w: Math.max(0, sourceW), h: Math.max(0, sourceH) }
  }
  const scale = Math.max(targetW / sourceW, targetH / sourceH)
  const w = Math.min(sourceW, targetW / scale)
  const h = Math.min(sourceH, targetH / scale)
  return { x: (sourceW - w) / 2, y: (sourceH - h) / 2, w, h }
}
