// One camera frame in, the same frame with its background effect and touch-up out. The overlay
// window and the window-recording worker both draw through this, so a recording shows what
// the overlay showed.

import {
  approachTone,
  DEFAULT_CAMERA_EFFECTS,
  effectsActive,
  meterLuma,
  needsSegmentation,
  NEUTRAL_TONE,
  segmentSize,
  shownBackground,
  smoothMask,
  touchUpTone,
  type CameraEffects,
  type Size,
  type Tone,
} from '../camera-effects.ts'
import { coverRect, type SourceRect } from '../workers/composite-protocol.ts'
import { EffectRenderer, METER_SIZE, type EffectCanvas } from './renderer.ts'
import { Segmentation, type Mask } from './segmentation.ts'

/** The touch-up meters every few frames; light does not change faster than that. */
const METER_EVERY = 10

export interface EffectView {
  /** Output size in pixels; the camera is cover-fitted into it. */
  width: number
  height: number
  mirror: boolean
}

export class CameraEffect {
  readonly canvas: EffectCanvas
  #renderer: EffectRenderer
  #effects: CameraEffects = DEFAULT_CAMERA_EFFECTS
  #segmentation: Segmentation | null = null
  /** A frame is being scaled down for the model. */
  #requesting = false
  /** The size masks are asked for at; masks of any other size are from an older frame shape. */
  #maskSize: Size = { width: 0, height: 0 }
  #mask: Float32Array | null = null
  #maskBytes = new Uint8Array(0)
  #maskChanged = false
  #tone: Tone = NEUTRAL_TONE
  #toneTarget: Tone = NEUTRAL_TONE
  #toneAt = 0
  #frames = 0

  constructor(canvas: EffectCanvas) {
    this.canvas = canvas
    this.#renderer = new EffectRenderer(canvas)
  }

  /** Why the effect cannot be drawn any more; null while it can. */
  get failure(): string | null {
    if (this.#renderer.lost) return 'The camera effect stopped working.'
    return this.#segmentation?.failure ?? null
  }

  setEffects(effects: CameraEffects): void {
    if (!effects.touchUp) {
      this.#tone = NEUTRAL_TONE
      this.#toneTarget = NEUTRAL_TONE
      this.#toneAt = 0
    }
    if (!needsSegmentation(effects)) this.#stopSegmentation()
    this.#effects = effects
  }

  setImage(image: ImageBitmap | null): void {
    this.#renderer.setImage(image)
  }

  /** Starts the segmentation model when the effects need it; rejects when it cannot run. */
  async prepare(): Promise<void> {
    if (!needsSegmentation(this.#effects)) return
    this.#segmentation ??= new Segmentation((mask) => this.#takeMask(mask))
    await this.#segmentation.ready
  }

  /**
   * Draws `frame` cover-fitted into a canvas of the view's size. False when nothing was
   * drawn: no effect is on, or the person has not been found yet. The caller then decides
   * whether the plain camera may be shown instead.
   */
  draw(frame: TexImageSource, frameWidth: number, frameHeight: number, view: EffectView): boolean {
    const effects = this.#effects
    if (!effectsActive(effects) || frameWidth <= 0 || frameHeight <= 0) return false

    const width = Math.max(1, Math.round(view.width))
    const height = Math.max(1, Math.round(view.height))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height

    const crop = coverRect(frameWidth, frameHeight, width, height)
    let masked = false
    if (needsSegmentation(effects)) {
      const segmentation = this.#segmentation
      if (!segmentation) return false
      this.#requestMask(segmentation, frame, crop)
      if (!this.#mask) return false
      if (this.#maskChanged) {
        this.#renderer.setMask(this.#maskBytes, this.#maskSize.width, this.#maskSize.height)
        this.#maskChanged = false
      }
      masked = true
    }

    this.#renderer.upload(frame, frameWidth, frameHeight)
    if (effects.touchUp) this.#meter(crop, performance.now())
    this.#renderer.render({
      crop,
      background: shownBackground(effects),
      blur: effects.blur,
      color: effects.color,
      mirror: view.mirror,
      tone: this.#tone,
      masked,
    })
    return true
  }

  close(): void {
    this.#stopSegmentation()
    this.#renderer.close()
  }

  #stopSegmentation(): void {
    this.#segmentation?.close()
    this.#segmentation = null
    this.#mask = null
    this.#maskSize = { width: 0, height: 0 }
  }

  /** Sends the visible part of the frame, scaled down, whenever the model is free for it. */
  #requestMask(segmentation: Segmentation, frame: TexImageSource, crop: SourceRect): void {
    const size = segmentSize(crop.w, crop.h)
    if (size.width !== this.#maskSize.width || size.height !== this.#maskSize.height) {
      // A new frame shape starts afresh rather than blending masks of different shapes.
      this.#maskSize = size
      this.#mask = null
    }
    if (!segmentation.idle || this.#requesting) return
    this.#requesting = true
    // Scaled off this thread. A VideoFrame's owner may close it before that is done, so the
    // scaling works from a clone of its own.
    const source = frame instanceof VideoFrame ? frame.clone() : frame
    createImageBitmap(source as ImageBitmapSource, crop.x, crop.y, crop.w, crop.h, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'low',
    })
      .then((image) => segmentation.send(image))
      .catch((error: unknown) => {
        console.warn('[butterfly-record] camera frame not segmented', error)
      })
      .finally(() => {
        if (source !== frame) (source as VideoFrame).close()
        this.#requesting = false
      })
  }

  #takeMask(mask: Mask): void {
    const { width, height } = this.#maskSize
    if (mask.width !== width || mask.height !== height || mask.values.length !== width * height) {
      return
    }
    if (this.#mask) smoothMask(this.#mask, mask.values)
    else this.#mask = mask.values
    const values = this.#mask
    if (this.#maskBytes.length !== values.length) this.#maskBytes = new Uint8Array(values.length)
    const bytes = this.#maskBytes
    for (let index = 0; index < values.length; index++) bytes[index] = values[index]! * 255 + 0.5
    this.#maskChanged = true
  }

  #meter(crop: SourceRect, now: number): void {
    const pixels = this.#frames++ % METER_EVERY === 0 ? this.#renderer.meter(crop) : null
    if (pixels) {
      this.#toneTarget = touchUpTone(meterLuma(pixels, METER_SIZE, METER_SIZE))
      // The first reading is used as it is rather than faded in from neutral.
      if (this.#toneAt === 0) this.#tone = this.#toneTarget
    }
    if (this.#toneAt > 0) {
      this.#tone = approachTone(this.#tone, this.#toneTarget, now - this.#toneAt)
    }
    if (pixels || this.#toneAt > 0) this.#toneAt = now
  }
}
