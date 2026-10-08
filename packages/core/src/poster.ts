// Not sampled at 0: screen recordings often open on a black or half-painted frame.
const DEFAULT_FRACTION = 0.1
const RETRY_FRACTION = 0.35
const MAX_EDGE = 640
const JPEG_QUALITY = 0.72
/** Mean luma (0-255) below which a frame counts as black. */
const DARK_THRESHOLD = 12

export interface PosterOptions {
  /** Source time in seconds; overrides `fraction` and skips the dark-frame retry. */
  at?: number
  /** 0..1 of the duration. */
  fraction?: number
  /** Longest output edge, in pixels. */
  maxEdge?: number
}

/** Resolves to null instead of throwing when the video cannot be decoded. */
export async function generatePoster(
  file: File,
  options: PosterOptions = {},
): Promise<Blob | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  video.src = url

  try {
    await once(video, 'loadedmetadata')

    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const fraction = options.fraction ?? DEFAULT_FRACTION

    if (options.at !== undefined) {
      const frame = await grab(video, options.at, options.maxEdge ?? MAX_EDGE)
      return frame?.blob ?? null
    }

    let frame = await grab(video, duration * fraction, options.maxEdge ?? MAX_EDGE)
    if (frame && frame.meanLuma < DARK_THRESHOLD && duration > 1) {
      const retry = await grab(video, duration * RETRY_FRACTION, options.maxEdge ?? MAX_EDGE)
      if (retry && retry.meanLuma > frame.meanLuma) frame = retry
    }

    return frame?.blob ?? null
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

interface Frame {
  blob: Blob
  meanLuma: number
}

async function grab(
  video: HTMLVideoElement,
  time: number,
  maxEdge: number,
): Promise<Frame | null> {
  await seek(video, time)

  const { videoWidth: width, videoHeight: height } = video
  if (width === 0 || height === 0) return null

  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(video, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  )
  if (!blob) return null

  return { blob, meanLuma: meanLuma(context, canvas.width, canvas.height) }
}

function meanLuma(context: CanvasRenderingContext2D, width: number, height: number): number {
  const { data } = context.getImageData(0, 0, width, height)
  let sum = 0
  // Every 40th pixel is enough to detect a black frame.
  const stride = 4 * 40
  let samples = 0
  for (let i = 0; i < data.length; i += stride) {
    sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    samples++
  }
  return samples === 0 ? 0 : sum / samples
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('seek failed'))
    }
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    // Seeking exactly to duration can land past the last frame and never fire 'seeked'.
    video.currentTime = Math.max(0, Math.min(time, (video.duration || 0) - 0.05))
  })
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true })
    target.addEventListener('error', () => reject(new Error(`${event} failed`)), { once: true })
  })
}
