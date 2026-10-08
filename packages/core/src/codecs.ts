// Records WebM only: VP9 is royalty-free, and Chrome's MediaRecorder MP4 is
// fragmented with a zero mvhd duration. MP4 is an export target.

export type RecordingMimeType = `video/webm${string}`

/** Preference order; first supported wins. */
const RECORDING_CANDIDATES: ReadonlyArray<{ mimeType: RecordingMimeType; codec: 'vp9' | 'vp8' }> = [
  { mimeType: 'video/webm;codecs=vp9,opus', codec: 'vp9' },
  { mimeType: 'video/webm;codecs=vp8,opus', codec: 'vp8' },
  { mimeType: 'video/webm', codec: 'vp8' },
]

export interface RecordingCodecChoice {
  mimeType: RecordingMimeType
  videoCodec: 'vp9' | 'vp8'
  audioCodec: 'opus'
}

const VIDEO_ONLY_CANDIDATES: ReadonlyArray<{
  mimeType: RecordingMimeType
  codec: 'vp9' | 'vp8'
}> = [
  { mimeType: 'video/webm;codecs=vp9', codec: 'vp9' },
  { mimeType: 'video/webm;codecs=vp8', codec: 'vp8' },
  { mimeType: 'video/webm', codec: 'vp8' },
]

/**
 * Declaring `opus` for a stream with no audio track can produce an unreadable
 * file, so `hasAudio` must be accurate. Throws rather than falling back to an
 * unsupported type, which would make MediaRecorder fail mid-recording.
 */
export function pickRecordingCodec(hasAudio = true): RecordingCodecChoice {
  const candidates = hasAudio ? RECORDING_CANDIDATES : VIDEO_ONLY_CANDIDATES

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return {
        mimeType: candidate.mimeType,
        videoCodec: candidate.codec,
        audioCodec: 'opus',
      }
    }
  }
  throw new Error('No supported WebM recording codec found in this browser.')
}

/** Without H.264 encoding, an MP4 would be a VP9 remux that most players reject. */
export function canExportMp4(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
  )
}
