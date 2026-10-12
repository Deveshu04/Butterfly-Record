// A single-window capture only contains that window's pixels, so it can never show the
// camera overlay floating over the desktop. For window recordings the camera is drawn into
// the captured frames instead: the tracks are turned into frame streams, a worker composes
// them, and the result is recorded as an ordinary video track.

import type { CameraAnchor, CameraCorner, CameraShape } from './camera-layout.ts'
import {
  samePlacement,
  type CompositeEvent,
  type CompositeFrame,
  type CompositeRequest,
  type OverlayPlacement,
} from './workers/composite-protocol.ts'

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>
}

interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>
}

/** Breakout Box, which lib.dom does not declare. */
interface FrameStreams {
  MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor
  MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator
}

const streams = globalThis as unknown as FrameStreams

export interface CompositeOptions {
  screen: MediaStreamTrack
  camera: MediaStreamTrack
  shape: CameraShape
  size: number
  /** Where the overlay sits on the desktop, mapped into the recorded frame. */
  anchor: CameraAnchor | null
  /** Where the camera goes while there is no anchor. */
  corner: CameraCorner
  mirror: boolean
  /** Compositing stopped on its own; the recording carries on without the camera. */
  onFailed?: (message: string) => void
}

export interface CameraComposite {
  /** Record this instead of the screen track. */
  readonly track: MediaStreamTrack
  setHidden(hidden: boolean): void
  /** The overlay was dragged or resized: the camera follows it in the frames from here on. */
  setPlacement(placement: OverlayPlacement): void
  close(): void
}

export function compositeSupported(): boolean {
  return (
    typeof streams.MediaStreamTrackProcessor === 'function' &&
    typeof streams.MediaStreamTrackGenerator === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof VideoFrame === 'function' &&
    typeof Worker === 'function'
  )
}

const UNSUPPORTED = 'This computer cannot draw the camera into a window recording.'

/**
 * Throws when the browser lacks the frame APIs; the caller records without the camera.
 */
export function startCameraComposite(options: CompositeOptions): CameraComposite {
  const Processor = streams.MediaStreamTrackProcessor
  const Generator = streams.MediaStreamTrackGenerator
  if (!Processor || !Generator || !compositeSupported()) throw new Error(UNSUPPORTED)

  const screen = new Processor({ track: options.screen })
  const camera = new Processor({ track: options.camera })
  const generator = new Generator({ kind: 'video' })
  const worker = new Worker(new URL('./workers/composite-worker.ts', import.meta.url), {
    type: 'module',
  })

  const frame: CompositeFrame = {
    shape: options.shape,
    size: options.size,
    anchor: options.anchor,
    corner: options.corner,
    mirror: options.mirror,
    hidden: false,
  }

  let closed = false
  function finish(): void {
    if (closed) return
    closed = true
    worker.terminate()
    generator.stop()
  }

  worker.addEventListener('message', (event: MessageEvent<CompositeEvent>) => {
    const failure = event.data.type === 'failed' ? event.data.message : null
    finish()
    if (failure) options.onFailed?.(failure)
  })
  worker.addEventListener('error', () => {
    finish()
    options.onFailed?.(UNSUPPORTED)
  })

  const start: CompositeRequest = {
    type: 'start',
    screen: screen.readable,
    camera: camera.readable,
    output: generator.writable,
    ...frame,
  }
  worker.postMessage(start, [screen.readable, camera.readable, generator.writable])

  function sendFrame(): void {
    worker.postMessage({ type: 'update', ...frame } satisfies CompositeRequest)
  }

  return {
    track: generator,
    setHidden(hidden: boolean): void {
      if (closed || frame.hidden === hidden) return
      frame.hidden = hidden
      sendFrame()
    },
    setPlacement(placement: OverlayPlacement): void {
      if (closed || samePlacement(frame, placement)) return
      frame.anchor = placement.anchor
      frame.size = placement.size
      sendFrame()
    },
    close: finish,
  }
}
