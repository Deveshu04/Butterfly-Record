// Finds the person in a camera frame with MediaPipe's selfie segmentation model. The runtime
// and the model are bundled with the app and loaded on first use; nothing is downloaded.

import type { ImageSegmenter } from '@mediapipe/tasks-vision'
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'

import modelUrl from './selfie_segmenter.tflite?url'

export type Delegate = 'GPU' | 'CPU'

type ModuleFactory = (module?: unknown) => Promise<unknown>

/** MediaPipe takes its runtime from the global object, and clears it again after each use. */
interface RuntimeScope {
  ModuleFactory?: ModuleFactory
}

async function loadModel(): Promise<Uint8Array> {
  const response = await fetch(modelUrl)
  if (!response.ok) {
    throw new Error(`The segmentation model could not be loaded (${response.status}).`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export class Segmenter {
  readonly delegate: Delegate
  #segmenter: ImageSegmenter
  #timestamp = 0

  private constructor(segmenter: ImageSegmenter, delegate: Delegate) {
    this.#segmenter = segmenter
    this.delegate = delegate
  }

  static async create(delegate: Delegate): Promise<Segmenter> {
    const [{ ImageSegmenter }, runtime, model] = await Promise.all([
      import('@mediapipe/tasks-vision'),
      import(/* @vite-ignore */ loaderUrl) as Promise<{ default: ModuleFactory }>,
      loadModel(),
    ])
    ;(globalThis as RuntimeScope).ModuleFactory = runtime.default
    const segmenter = await ImageSegmenter.createFromOptions(
      // No loader path: the runtime is already on the global object.
      { wasmLoaderPath: '', wasmBinaryPath: wasmUrl },
      {
        baseOptions: { modelAssetBuffer: model, delegate },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      },
    )
    return new Segmenter(segmenter, delegate)
  }

  /** Person confidence for `image`, 0 to 1 per pixel at the image's size, rows top first. */
  segment(image: TexImageSource): Float32Array | null {
    // Video mode needs strictly increasing timestamps.
    this.#timestamp = Math.max(this.#timestamp + 1, Math.round(performance.now()))
    let mask: Float32Array | null = null
    this.#segmenter.segmentForVideo(image, this.#timestamp, (result) => {
      const masks = result.confidenceMasks
      // The values belong to MediaPipe and are only valid during this call.
      mask = masks?.[masks.length - 1]?.getAsFloat32Array().slice() ?? null
    })
    return mask
  }

  close(): void {
    this.#segmenter.close()
  }
}
