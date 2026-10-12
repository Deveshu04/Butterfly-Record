// Geometry shared by the camera overlay window and the window-recording compositor, kept
// pure so both can be tested without a webview.

export type CameraShape = 'circle' | 'rounded' | 'wide' | 'tall'
export type CameraCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const CAMERA_SHAPES: readonly CameraShape[] = ['circle', 'rounded', 'wide', 'tall']
export const CAMERA_CORNERS: readonly CameraCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]

/** Overlay width in logical pixels. */
export const MIN_CAMERA_SIZE = 120
export const MAX_CAMERA_SIZE = 640
export const DEFAULT_CAMERA_SIZE = 240
/** Ctrl + wheel and the resize grip move the width by this much. */
export const CAMERA_SIZE_STEP = 16

/** Rounded shapes; a circle is handled separately because its radius is half the side. */
const CORNER_RATIO = 0.14
/** The size slider is calibrated against a 1080p output. */
const REFERENCE_HEIGHT = 1080
/** Share of the output width a composited camera may take. */
const MAX_COMPOSITE_WIDTH = 0.4
/** Share of the output height, so a tall frame cannot fill a short output. */
const MAX_COMPOSITE_HEIGHT = 0.6
const COMPOSITE_MARGIN = 0.025

const ASPECT: Record<CameraShape, number> = {
  circle: 1,
  rounded: 1,
  wide: 16 / 9,
  tall: 3 / 4,
}

export function isCameraShape(value: unknown): value is CameraShape {
  return CAMERA_SHAPES.includes(value as CameraShape)
}

export function isCameraCorner(value: unknown): value is CameraCorner {
  return CAMERA_CORNERS.includes(value as CameraCorner)
}

/** Width ÷ height. */
export function aspectOf(shape: CameraShape): number {
  return ASPECT[shape] ?? 1
}

export function clampCameraSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_CAMERA_SIZE
  return Math.round(Math.min(MAX_CAMERA_SIZE, Math.max(MIN_CAMERA_SIZE, size)))
}

/** Logical window size for a shape at the stored width. */
export function overlaySize(shape: CameraShape, size: number): { width: number; height: number } {
  const width = clampCameraSize(size)
  return { width, height: Math.max(1, Math.round(width / aspectOf(shape))) }
}

/** A circle is a square with a radius of half its side; the rest use 14 % of the short side. */
export function cornerRadius(shape: CameraShape, width: number, height: number): number {
  const short = Math.max(0, Math.min(width, height))
  return shape === 'circle' ? short / 2 : short * CORNER_RATIO
}

export interface CompositeRect {
  x: number
  y: number
  w: number
  h: number
  radius: number
}

/**
 * Where the overlay sits on its monitor, as fractions of the work area: 0 at the left or top
 * edge, 1 at the right or bottom. A window capture is never told where the recorded window is
 * on screen, so the same fractions are used to place the camera inside the recorded frame.
 */
export interface CameraAnchor {
  x: number
  y: number
}

/** The camera's size in output pixels, before it is placed. */
function compositeSize(
  outputW: number,
  outputH: number,
  shape: CameraShape,
  size: number,
): { w: number; h: number } {
  const aspect = aspectOf(shape)
  const scaled = Math.round((clampCameraSize(size) * outputH) / REFERENCE_HEIGHT)
  let w = Math.min(scaled, Math.round(outputW * MAX_COMPOSITE_WIDTH))
  let h = Math.round(w / aspect)
  // A tall frame in a short output would otherwise run past the opposite margin.
  const maxHeight = Math.round(outputH * MAX_COMPOSITE_HEIGHT)
  if (h > maxHeight) {
    h = maxHeight
    w = Math.round(h * aspect)
  }
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(Math.max(value, min), Math.max(min, max)))

/**
 * Where the camera is drawn into a window recording, in output pixels. The overlay is
 * scaled from its logical width so a 240 px bubble looks the same at any capture size.
 */
export function compositeRect(
  outputW: number,
  outputH: number,
  shape: CameraShape,
  size: number,
  corner: CameraCorner,
): CompositeRect {
  const { w, h } = compositeSize(outputW, outputH, shape, size)
  const margin = Math.round(COMPOSITE_MARGIN * outputH)
  const right = corner === 'top-right' || corner === 'bottom-right'
  const bottom = corner === 'bottom-left' || corner === 'bottom-right'
  return {
    x: clamp(right ? outputW - w - margin : margin, 0, outputW - w),
    y: clamp(bottom ? outputH - h - margin : margin, 0, outputH - h),
    w,
    h,
    radius: cornerRadius(shape, w, h),
  }
}

/**
 * The same placement the viewer sees on the desktop, mapped into the recorded frame: the
 * camera's centre lands at the anchor's fractions. Nothing is inset, so a camera dragged
 * into the very corner of the screen reaches the very corner of the video.
 */
export function compositeRectAt(
  outputW: number,
  outputH: number,
  shape: CameraShape,
  size: number,
  anchor: CameraAnchor,
): CompositeRect {
  const { w, h } = compositeSize(outputW, outputH, shape, size)
  const fraction = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5)
  return {
    x: clamp(fraction(anchor.x) * outputW - w / 2, 0, outputW - w),
    y: clamp(fraction(anchor.y) * outputH - h / 2, 0, outputH - h),
    w,
    h,
    radius: cornerRadius(shape, w, h),
  }
}

/** The anchor placement when the overlay's position is known, else the corner fallback. */
export function cameraRect(
  outputW: number,
  outputH: number,
  shape: CameraShape,
  size: number,
  placement: { anchor: CameraAnchor | null; corner: CameraCorner },
): CompositeRect {
  return placement.anchor
    ? compositeRectAt(outputW, outputH, shape, size, placement.anchor)
    : compositeRect(outputW, outputH, shape, size, placement.corner)
}

/** CSS `border-radius` for a frame of the given logical size. */
export function cssRadius(shape: CameraShape, width: number, height: number): string {
  return `${cornerRadius(shape, width, height)}px`
}
