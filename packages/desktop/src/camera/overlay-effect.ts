// The overlay's background effect and touch-up: every camera frame the video presents is
// drawn again, with the effect, into a canvas laid over the video. The effect code and the
// model load only once an effect is turned on, and are released when it is turned off.

import {
  DEFAULT_CAMERA_EFFECTS,
  effectsActive,
  sameEffects,
  shownBackground,
  type CameraEffects,
} from '../lib/camera-effects.ts'
import type { CameraEffect } from '../lib/effects/camera-effect.ts'
import type { CameraEffectState } from '../lib/ipc.ts'

interface Callbacks {
  /** The canvas has a drawn frame and should cover the video, or should not. */
  showing(on: boolean): void
  state(state: CameraEffectState): void
}

const UNAVAILABLE = 'The camera effect could not be started on this computer.'

function describe(error: unknown): string {
  return error instanceof Error && error.message.includes('WebGL') ? error.message : UNAVAILABLE
}

export class OverlayEffect {
  #video: HTMLVideoElement
  #canvas: HTMLCanvasElement
  #callbacks: Callbacks
  #effects: CameraEffects = DEFAULT_CAMERA_EFFECTS
  #mirror = true
  #running = false
  #effect: CameraEffect | null = null
  /** Bumped by every change, so a slow load cannot apply settings that are already stale. */
  #generation = 0
  #image: { name: string; bitmap: ImageBitmap } | null = null
  #frame: number | null = null
  #shown = false

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, callbacks: Callbacks) {
    this.#video = video
    this.#canvas = canvas
    this.#callbacks = callbacks
  }

  /** `live` is whether the video is showing the camera at all. */
  update(effects: CameraEffects, mirror: boolean, live: boolean): void {
    const running = live && effectsActive(effects)
    if (
      running === this.#running &&
      sameEffects(effects, this.#effects) &&
      mirror === this.#mirror
    ) {
      return
    }
    this.#effects = effects
    this.#mirror = mirror
    this.#running = running
    const generation = ++this.#generation
    if (!running) {
      this.#stop()
      this.#callbacks.state({ status: 'off', message: null })
      return
    }
    void this.#start(generation)
  }

  close(): void {
    this.#generation++
    this.#running = false
    this.#stop()
  }

  async #start(generation: number): Promise<void> {
    if (!this.#shown) this.#callbacks.state({ status: 'starting', message: null })
    try {
      if (!this.#effect) {
        const { CameraEffect } = await import('../lib/effects/camera-effect.ts')
        if (generation !== this.#generation) return
        this.#effect = new CameraEffect(this.#canvas)
      }
      const effect = this.#effect
      // The picture is loaded before the switch, so the room never shows in between.
      const image = await this.#loadImage(generation)
      if (generation !== this.#generation) return
      effect.setEffects(this.#effects)
      effect.setImage(image)
      await effect.prepare()
      if (generation !== this.#generation) return
      this.#loop()
    } catch (error) {
      if (generation !== this.#generation) return
      console.warn('[butterfly-record] camera effect unavailable', error)
      this.#fail(describe(error))
    }
  }

  /** The picture only changes when another one is chosen; a missing one draws no background. */
  async #loadImage(generation: number): Promise<ImageBitmap | null> {
    const name = shownBackground(this.#effects) === 'image' ? this.#effects.image : null
    if (!name) return null
    if (this.#image?.name === name) return this.#image.bitmap
    try {
      const { loadBackgroundImage } = await import('../lib/effects/background-image.ts')
      const bitmap = await loadBackgroundImage(name)
      if (generation !== this.#generation) {
        bitmap.close()
        return null
      }
      this.#image?.bitmap.close()
      this.#image = { name, bitmap }
      return bitmap
    } catch (error) {
      console.warn('[butterfly-record] background picture unavailable', error)
      return null
    }
  }

  #loop(): void {
    if (this.#frame !== null) return
    const step = () => {
      this.#frame = null
      if (!this.#running || !this.#effect) return
      if (!this.#draw(this.#effect)) return
      this.#frame = this.#video.requestVideoFrameCallback(step)
    }
    this.#frame = this.#video.requestVideoFrameCallback(step)
  }

  /** False once the effect has failed for good. */
  #draw(effect: CameraEffect): boolean {
    const video = this.#video
    const scale = window.devicePixelRatio || 1
    let drawn: boolean
    try {
      drawn = effect.draw(video, video.videoWidth, video.videoHeight, {
        width: this.#canvas.clientWidth * scale,
        height: this.#canvas.clientHeight * scale,
        mirror: this.#mirror,
      })
    } catch (error) {
      console.warn('[butterfly-record] camera effect failed', error)
      this.#fail(UNAVAILABLE)
      return false
    }
    const failure = drawn ? null : effect.failure
    if (failure) {
      this.#fail(UNAVAILABLE)
      return false
    }
    this.#show(drawn)
    return true
  }

  #fail(message: string): void {
    this.#running = false
    this.#stop()
    this.#callbacks.state({ status: 'failed', message })
  }

  #show(on: boolean): void {
    if (on === this.#shown) return
    this.#shown = on
    this.#callbacks.showing(on)
    if (on) this.#callbacks.state({ status: 'on', message: null })
  }

  #stop(): void {
    if (this.#frame !== null) this.#video.cancelVideoFrameCallback(this.#frame)
    this.#frame = null
    this.#show(false)
    this.#effect?.close()
    this.#effect = null
    this.#image?.bitmap.close()
    this.#image = null
  }
}
