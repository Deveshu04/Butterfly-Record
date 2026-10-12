// What the camera shows behind the person, and the light touch-up. Kept pure so the settings,
// the overlay window and the window-recording compositor work from the same numbers.

export type CameraBackground = 'none' | 'blur' | 'image' | 'color'
export type BlurStrength = 'light' | 'strong'

export interface CameraEffects {
  background: CameraBackground
  blur: BlurStrength
  /** File name of the chosen picture in the app's own folder; null until one is chosen. */
  image: string | null
  /** `#rrggbb`. */
  color: string
  /** Gently brightens a dim picture. */
  touchUp: boolean
}

export const CAMERA_BACKGROUNDS: readonly CameraBackground[] = ['none', 'blur', 'image', 'color']
export const BLUR_STRENGTHS: readonly BlurStrength[] = ['light', 'strong']

export const DEFAULT_CAMERA_EFFECTS: CameraEffects = {
  background: 'none',
  blur: 'light',
  image: null,
  color: '#30353b',
  touchUp: false,
}

/** The names the app gives the pictures it copies; anything else is not loaded. */
const IMAGE_NAME = /^background-\d{1,20}\.(?:jpe?g|png|webp|bmp)$/
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function isBackgroundImageName(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_NAME.test(value)
}

/** `#rgb` and `#rrggbb` in any case become lowercase `#rrggbb`; anything else is rejected. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX.test(value)) return null
  const hex = value.slice(1).toLowerCase()
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex}`
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function normalizeCameraEffects(raw: unknown): CameraEffects {
  const effects =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const defaults = DEFAULT_CAMERA_EFFECTS
  return {
    background: pick(effects.background, CAMERA_BACKGROUNDS, defaults.background),
    blur: pick(effects.blur, BLUR_STRENGTHS, defaults.blur),
    image: isBackgroundImageName(effects.image) ? effects.image : null,
    color: normalizeColor(effects.color) ?? defaults.color,
    touchUp: typeof effects.touchUp === 'boolean' ? effects.touchUp : defaults.touchUp,
  }
}

export function sameEffects(a: CameraEffects, b: CameraEffects): boolean {
  return (
    a.background === b.background &&
    a.blur === b.blur &&
    a.image === b.image &&
    a.color === b.color &&
    a.touchUp === b.touchUp
  )
}

/** What is actually drawn: a picture background with no picture chosen draws none. */
export function shownBackground(effects: CameraEffects): CameraBackground {
  return effects.background === 'image' && !effects.image ? 'none' : effects.background
}

/** Whether frames go through the segmentation model. */
export function needsSegmentation(effects: CameraEffects): boolean {
  return shownBackground(effects) !== 'none'
}

/** Whether the camera is drawn any differently from the plain picture. */
export function effectsActive(effects: CameraEffects): boolean {
  return needsSegmentation(effects) || effects.touchUp
}

/**
 * What a window recording draws. Its camera goes without a background: running the model
 * there as well as in the overlay stalls the recording on modest PCs.
 */
export function compositedEffects(effects: CameraEffects): CameraEffects {
  return { ...effects, background: 'none' }
}

export interface Size {
  width: number
  height: number
}

/** Longest side of the picture the model is given; it works at 256 × 256 itself. */
export const SEGMENT_SIZE = 256

/** The visible part of the camera, scaled down for the model with its shape kept. */
export function segmentSize(width: number, height: number): Size {
  if (!(width > 0) || !(height > 0)) return { width: SEGMENT_SIZE, height: SEGMENT_SIZE }
  const scale = SEGMENT_SIZE / Math.max(width, height)
  return {
    width: Math.max(16, Math.round(width * scale)),
    height: Math.max(16, Math.round(height * scale)),
  }
}

/**
 * Mask values in this range are the soft edge between person and background; below it is
 * background, above it is person. Sitting above one half pulls the edge in slightly, so the
 * old background does not show as a halo around the shoulders and hair.
 */
export const MASK_EDGE: readonly [number, number] = [0.5, 0.88]

/** Share of the gap to a new mask value closed at once, however small the change. */
const MASK_FOLLOW_MIN = 0.35
/** How quickly a larger change is followed in full. */
const MASK_FOLLOW_GAIN = 2.5

/**
 * Blends a new mask into the running one, in place. Values that barely moved are averaged
 * over a few frames, which stops the edge shimmering; values that moved a lot are followed
 * at once, so a turning head or a waving hand leaves no trail.
 */
export function smoothMask(running: Float32Array, next: ArrayLike<number>): void {
  const count = Math.min(running.length, next.length)
  for (let index = 0; index < count; index++) {
    const value = next[index]!
    const current = running[index]!
    const change = value - current
    const follow = Math.min(1, MASK_FOLLOW_MIN + Math.abs(change) * MASK_FOLLOW_GAIN)
    running[index] = current + change * follow
  }
}

/** Gaussian σ of each blur strength, as a share of the visible picture's height. */
const BLUR_SIGMA: Record<BlurStrength, number> = { light: 0.014, strong: 0.034 }
/** σ in working pixels: wider would need more samples per pixel, narrower more pixels. */
const WORK_SIGMA = 2.5
export const MAX_BLUR_RADIUS = 12

export interface BlurPlan {
  /** Output pixels per working pixel. */
  scale: number
  width: number
  height: number
  /** σ in working pixels. */
  sigma: number
  /** Samples each side of the centre. */
  radius: number
}

/**
 * The background is blurred on a smaller copy of the picture, so the cost stays the same
 * however strong the blur and however large the output. Both strengths are a fixed share of
 * the picture's height, so the overlay and the recording look alike at any size.
 */
export function blurPlan(strength: BlurStrength, width: number, height: number): BlurPlan {
  const outputW = Math.max(1, Math.round(width))
  const outputH = Math.max(1, Math.round(height))
  const sigma = BLUR_SIGMA[strength] * outputH
  const scale = Math.max(1, Math.round(sigma / WORK_SIGMA))
  const work = sigma / scale
  return {
    scale,
    width: Math.max(1, Math.ceil(outputW / scale)),
    height: Math.max(1, Math.ceil(outputH / scale)),
    sigma: work,
    radius: Math.min(MAX_BLUR_RADIUS, Math.max(1, Math.ceil(work * 3))),
  }
}

/** Mip level that matches drawing `source` pixels into `target` pixels without aliasing. */
export function mipLevel(source: number, target: number): number {
  if (!(source > 0) || !(target > 0)) return 0
  return Math.max(0, Math.log2(source / target))
}

export interface Tone {
  /** Applied to each channel; below 1 lifts shadows and midtones. */
  gamma: number
  contrast: number
  saturation: number
}

export const NEUTRAL_TONE: Tone = { gamma: 1, contrast: 1, saturation: 1 }

/** Mean brightness, in sRGB terms, that a dim picture is lifted towards. */
const TARGET_LUMA = 0.45
/** Only part of the gap is closed: a dark room should look better lit, not like daylight. */
const LIFT_SHARE = 0.6
const MIN_GAMMA = 0.62
/** A lifted picture looks flat and grey without a little contrast and colour back. */
const LIFT_CONTRAST = 0.08
const LIFT_SATURATION = 0.08

/** The touch-up for a picture of the given mean brightness; a well-lit one is left alone. */
export function touchUpTone(meanLuma: number): Tone {
  if (!Number.isFinite(meanLuma)) return NEUTRAL_TONE
  const luma = Math.min(0.98, Math.max(0.02, meanLuma))
  if (luma >= TARGET_LUMA) return NEUTRAL_TONE
  const goal = luma + (TARGET_LUMA - luma) * LIFT_SHARE
  const gamma = Math.max(MIN_GAMMA, Math.log(goal) / Math.log(luma))
  const amount = (1 - gamma) / (1 - MIN_GAMMA)
  return {
    gamma,
    contrast: 1 + LIFT_CONTRAST * amount,
    saturation: 1 + LIFT_SATURATION * amount,
  }
}

/** How long the touch-up takes to settle on a change of light, so it never visibly pumps. */
const TONE_SETTLE_MS = 700

/** Moves `current` towards `target` by the share of the way `elapsedMs` allows. */
export function approachTone(current: Tone, target: Tone, elapsedMs: number): Tone {
  const step = elapsedMs > 0 ? 1 - Math.exp(-elapsedMs / TONE_SETTLE_MS) : 0
  const towards = (from: number, to: number) => from + (to - from) * step
  return {
    gamma: towards(current.gamma, target.gamma),
    contrast: towards(current.contrast, target.contrast),
    saturation: towards(current.saturation, target.saturation),
  }
}

/**
 * Mean brightness of an RGBA picture, weighted towards the middle where a face usually is,
 * so a bright window at the edge does not hold back the lift.
 */
export function meterLuma(pixels: ArrayLike<number>, width: number, height: number): number {
  let sum = 0
  let weights = 0
  for (let y = 0; y < height; y++) {
    const dy = (y + 0.5) / height - 0.5
    for (let x = 0; x < width; x++) {
      const dx = (x + 0.5) / width - 0.5
      const weight = 1 - 0.75 * Math.min(1, 4 * (dx * dx + dy * dy))
      const at = (y * width + x) * 4
      const luma = 0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!
      sum += (luma / 255) * weight
      weights += weight
    }
  }
  return weights > 0 ? sum / weights : 0
}
