// chrome.runtime.sendMessage broadcasts to every context, so each message names
// its `target`. The two recording hosts are addressed separately because both
// can be alive at once.

import type { EncoderFault } from '@butterfly-record/core'

export type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'error'

export type RecordScope = 'tab' | 'screen' | 'window' | 'region'

/** In source pixels. */
export interface CropRect {
  left: number
  top: number
  width: number
  height: number
}

/** Snapshot taken at Start, so the worker and both hosts agree on settings. */
export interface CaptureOptions {
  /** Ceiling; never upscales past the source. */
  maxHeight: number
  frameRate: number
  encoder: 'auto' | 'webcodecs' | 'media-recorder'
  /** null for the system default. */
  microphoneId: string | null
  /** Region capture; null for the whole surface. */
  crop: CropRect | null
}

export type HostKind = 'offscreen' | 'recorder-tab'

/** A host's reply to a second start; never a reason to try the other host. */
export const HOST_BUSY = 'A recording is already in progress.'

export interface DeviceChoice {
  deviceId: string
  label: string
}

export interface DeviceList {
  cameras: DeviceChoice[]
  microphones: DeviceChoice[]
  /** False until access is granted at the extension origin. */
  labelled: boolean
}

export interface HostStatus {
  phase: RecordingPhase
  sessionId: string | null
  /** Seconds of captured material, excluding paused spans. */
  elapsed: number
  bytesWritten: number
}

/**
 * Sent to the host that minted a download's blob URL once the download completes or fails.
 * The minting context must revoke: a service worker has no URL.revokeObjectURL.
 */
export interface DownloadSettled {
  type: 'download-settled'
  url: string
  sessionId: string
  completed: boolean
  /** File name Chrome settled on, after any "(1)" suffix; null when interrupted. */
  filename: string | null
}

/** Where a finished recording was saved by its host, or should be downloaded to. */
export type FinishedDestination =
  | { kind: 'folder'; folder: string; name: string }
  | {
      kind: 'downloads'
      /** Blob URL minted in a host context, which must also revoke it. */
      blobUrl: string
      filename: string
      /** Why the recordings folder was not used, when one is set. */
      folderError: string | null
    }

export type OffscreenRequest =
  | {
      target: 'offscreen'
      type: 'start-tab'
      sessionId: string
      /** From chrome.tabCapture.getMediaStreamId; redeemed in this context. */
      streamId: string
      sourceLabel: string
      withMicrophone: boolean
      /** Chrome mutes a tab while capturing its audio, so false also keeps it audible. */
      withTabAudio: boolean
      /** Hold the stream open this long before the encoder starts. */
      countdownMs: number
      capture: CaptureOptions
    }
  | { target: 'offscreen'; type: 'stop' }
  | { target: 'offscreen'; type: 'cancel' }
  | { target: 'offscreen'; type: 'pause' }
  | { target: 'offscreen'; type: 'resume' }
  | { target: 'offscreen'; type: 'status' }
  | { target: 'offscreen'; type: 'set-mic-muted'; muted: boolean }
  | { target: 'offscreen'; type: 'list-devices' }
  | ({ target: 'offscreen' } & DownloadSettled)
  /** Allowed with the DISPLAY_MEDIA reason; the picker supplies the user activation. */
  | {
      target: 'offscreen'
      type: 'start-display'
      sessionId: string
      scope: Exclude<RecordScope, 'tab'>
      withMicrophone: boolean
      countdownMs: number
      capture: CaptureOptions
    }
  // Pre-roll mic meter. Runs here because the overlay is at the page's origin,
  // which has no microphone grant.
  | { target: 'offscreen'; type: 'start-monitor'; microphoneId: string | null }
  | { target: 'offscreen'; type: 'stop-monitor' }
  | { target: 'offscreen'; type: 'levels' }
  /** Mirrors the recordings folder's permission to storage, since only a page can query it. */
  | { target: 'offscreen'; type: 'check-folder' }

export type RecorderTabRequest =
  | {
      target: 'recorder-tab'
      type: 'start-desktop'
      sessionId: string
      /** From chrome.desktopCapture.chooseDesktopMedia. */
      streamId: string
      scope: Exclude<RecordScope, 'tab'>
      sourceLabel: string
      withMicrophone: boolean
      /** The user ticked "Also share audio" in Chrome's picker. */
      withSystemAudio: boolean
      /** Hold the stream open this long before the encoder starts. */
      countdownMs: number
      capture: CaptureOptions
    }
  | { target: 'recorder-tab'; type: 'stop' }
  | { target: 'recorder-tab'; type: 'cancel' }
  | { target: 'recorder-tab'; type: 'pause' }
  | { target: 'recorder-tab'; type: 'resume' }
  | { target: 'recorder-tab'; type: 'status' }
  | { target: 'recorder-tab'; type: 'set-mic-muted'; muted: boolean }
  | ({ target: 'recorder-tab' } & DownloadSettled)
  | { target: 'recorder-tab'; type: 'request-permissions' }

export type HostRequest = OffscreenRequest | RecorderTabRequest

export type BackgroundRequest =
  | {
      target: 'background'
      type: 'start-recording'
      scope: RecordScope
      /** Region capture only; null for every other scope. */
      crop: CropRect | null
    }
  | { target: 'background'; type: 'stop-recording' }
  | { target: 'background'; type: 'cancel-recording' }
  | { target: 'background'; type: 'pause-recording' }
  | { target: 'background'; type: 'resume-recording' }
  | { target: 'background'; type: 'get-state' }
  | { target: 'background'; type: 'request-permissions' }
  | { target: 'background'; type: 'open-library' }
  | { target: 'background'; type: 'list-devices' }
  | { target: 'background'; type: 'restart-recording' }
  | { target: 'background'; type: 'set-mic-muted'; muted: boolean }
  | { target: 'background'; type: 'set-camera-on'; on: boolean }
  /** Pre-roll mic meter, relayed to the offscreen document. */
  | { target: 'background'; type: 'start-monitor' }
  | { target: 'background'; type: 'stop-monitor' }
  | { target: 'background'; type: 'levels' }
  | { target: 'background'; type: 'check-folder' }
  | { target: 'background'; type: 'set-folder-needs-reconnect'; needed: boolean }
  /** Sent via the worker because a content script cannot reach the extension's OPFS. */
  | { target: 'background'; type: 'dev-report'; sessionId: string; report: unknown }
  | {
      target: 'background'
      type: 'recording-finished'
      sessionId: string
      destination: FinishedDestination
      /** Where to send download-settled. */
      host: HostKind
    }
  /** Finalize failed; anything captured stays in the library for recovery. */
  | {
      target: 'background'
      type: 'recording-failed'
      sessionId: string
      error: string
      /** False when nothing reached the disk. */
      recoverable: boolean
    }
  /** Sent once the host has a live stream, so the countdown never runs over the picker. */
  | { target: 'background'; type: 'capture-ready'; sessionId: string; countdownMs: number }
  | { target: 'background'; type: 'recording-faulted'; sessionId: string; fault: EncoderFault }
  | { target: 'background'; type: 'recorder-tab-ready' }

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export function ok<T>(value: T): Reply<T> {
  return { ok: true, value }
}

export function fail(error: unknown): Reply<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

type AnyRequest = OffscreenRequest | RecorderTabRequest | BackgroundRequest

export function isFor<T extends AnyRequest['target']>(
  message: unknown,
  target: T,
): message is Extract<AnyRequest, { target: T }> {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { target?: unknown }).target === target
  )
}

export const SCOPE_LABELS: Record<RecordScope, string> = {
  tab: 'This tab',
  screen: 'Screen',
  window: 'Window',
  region: 'Region',
}
