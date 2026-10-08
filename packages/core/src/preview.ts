// Re-encodes through canvas + MediaRecorder so no demuxer is needed.

const PREVIEW_SECONDS = 3
const PREVIEW_WIDTH = 320
const VIDEO_BITRATE = 500_000
const MIME_TYPE = 'video/webm;codecs=vp8'

export interface PreviewOptions {
  /** From the start, in seconds. */
  seconds?: number
  /** Pixels; height follows the source aspect ratio. */
  width?: number
}

/** Resolves to null instead of throwing on any failure. */
export async function generatePreview(
  file: Blob,
  options: PreviewOptions = {},
): Promise<Blob | null> {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(MIME_TYPE)) {
    return null
  }

  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url

  let stream: MediaStream | null = null
  try {
    await once(video, 'loadedmetadata')

    const { videoWidth, videoHeight } = video
    if (videoWidth === 0 || videoHeight === 0) return null

    const scale = Math.min(1, (options.width ?? PREVIEW_WIDTH) / videoWidth)
    const canvas = document.createElement('canvas')
    // Even dimensions: some encoders refuse odd frame sizes.
    canvas.width = Math.max(2, 2 * Math.round((videoWidth * scale) / 2))
    canvas.height = Math.max(2, 2 * Math.round((videoHeight * scale) / 2))
    const context = canvas.getContext('2d')
    if (!context) return null

    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const seconds = Math.min(
      options.seconds ?? PREVIEW_SECONDS,
      duration > 0 ? duration : options.seconds ?? PREVIEW_SECONDS,
    )

    stream = canvas.captureStream()
    const recorder = new MediaRecorder(stream, {
      mimeType: MIME_TYPE,
      videoBitsPerSecond: VIDEO_BITRATE,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })

    const draw = () => context.drawImage(video, 0, 0, canvas.width, canvas.height)
    draw()
    recorder.start()

    await playThrough(video, seconds, draw)

    video.pause()
    recorder.stop()
    await stopped

    const blob = new Blob(chunks, { type: 'video/webm' })
    return blob.size > 0 ? blob : null
  } catch {
    return null
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

function playThrough(
  video: HTMLVideoElement,
  seconds: number,
  draw: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('ended', finish)
      resolve()
    }
    const done = () => video.currentTime >= seconds || video.ended

    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number
      }
    ).requestVideoFrameCallback?.bind(video)

    const onFrame = () => {
      if (settled) return
      draw()
      if (done()) finish()
      else rvfc!(onFrame)
    }
    const onTimeUpdate = () => {
      draw()
      if (done()) finish()
    }

    if (rvfc) rvfc(onFrame)
    else video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', finish, { once: true })

    // Guards against a stalled decode; a partial capture is still usable.
    const timer = setTimeout(finish, (seconds + 5) * 1000)

    video.play().catch((cause) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('ended', finish)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    })
  })
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true })
    target.addEventListener('error', () => reject(new Error(`${event} failed`)), { once: true })
  })
}
