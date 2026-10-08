<script lang="ts">
  // A visible extension tab is required: an offscreen document cannot redeem a desktopCapture
  // stream ID ("Invalid state") or show camera/microphone permission prompts.
  import { onMount } from 'svelte'
  import { Butterfly } from '@butterfly-record/ui'
  import {
    assertIdle,
    beginRecording,
    cancelRecording,
    downloadSettled,
    markFailed,
    pauseRecording,
    resumeRecording,
    setSourceMuted,
    status,
    stopRecording,
    tryMicrophone,
    isRecording,
  } from '../../lib/recording-host.ts'
  import {
    fail,
    isFor,
    ok,
    type CaptureOptions,
    type RecorderTabRequest,
  } from '../../lib/messages.ts'

  type Screen = 'waiting' | 'recording' | 'permissions' | 'done' | 'kept' | 'error'

  let screen = $state<Screen>('waiting')
  let sourceLabel = $state('')
  let detail = $state('')
  let cameraGranted = $state(false)
  let micGranted = $state(false)

  // Desktop capture ignores modern constraints; caps must be legacy max* keys in `mandatory`.
  // minFrameRate stops a static screen dropping below 1 fps, which players show as frozen.
  // Requesting audio the user did not opt into in Chrome's picker rejects the whole call.
  function desktopConstraints(
    streamId: string,
    withAudio: boolean,
    capture: CaptureOptions,
  ): MediaStreamConstraints {
    return {
      audio: withAudio
        ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          maxWidth: Math.round((capture.maxHeight * 16) / 9),
          maxHeight: capture.maxHeight,
          maxFrameRate: capture.frameRate,
          minFrameRate: 5,
        },
      },
    } as unknown as MediaStreamConstraints
  }

  // A desktopCapture stream ID is single use, consumed even by a failed attempt, so never retry.
  // `withAudio` comes from Chrome's canRequestAudioTrack.
  async function openDesktopStream(
    streamId: string,
    withAudio: boolean,
    capture: CaptureOptions,
  ): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia(
      desktopConstraints(streamId, withAudio, capture),
    )

    const [video] = stream.getVideoTracks()
    if (!video || video.readyState !== 'live') {
      for (const track of stream.getTracks()) track.stop()
      throw new Error('The screen share ended before recording could start. Please try again.')
    }

    return stream
  }

  async function startDesktop(request: Extract<RecorderTabRequest, { type: 'start-desktop' }>) {
    console.info('[butterfly-record] redeeming desktop stream', {
      scope: request.scope,
      withSystemAudio: request.withSystemAudio,
      withMicrophone: request.withMicrophone,
    })

    assertIdle()
    const captureStream = await openDesktopStream(
      request.streamId,
      request.withSystemAudio,
      request.capture,
    )
    const micStream = request.withMicrophone
      ? await tryMicrophone(request.capture.microphoneId)
      : null

    console.info('[butterfly-record] desktop stream live', {
      video: captureStream.getVideoTracks().map((t) => `${t.label}:${t.readyState}`),
      systemAudio: captureStream.getAudioTracks().length,
      mic: micStream?.getAudioTracks().length ?? 0,
    })

    sourceLabel = request.sourceLabel
    const result = await beginRecording({
      sessionId: request.sessionId,
      surface: request.scope === 'screen' ? 'display' : 'window',
      sourceLabel: request.sourceLabel,
      captureStream,
      micStream,
      countdownMs: request.countdownMs,
      host: 'recorder-tab',
    })

    detail = [
      captureStream.getAudioTracks().length > 0 ? 'system audio' : null,
      micStream ? 'microphone' : null,
    ]
      .filter(Boolean)
      .join(' + ')
    screen = 'recording'
    return result
  }

  // getUserMedia is the only way to trigger the prompts; the tracks are stopped at once.
  async function askForPermissions() {
    for (const kind of ['video', 'audio'] as const) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ [kind]: true })
        for (const track of stream.getTracks()) track.stop()
        if (kind === 'video') cameraGranted = true
        else micGranted = true
      } catch {
        // Denied or absent; the popup offers to ask again.
      }
    }
    screen = 'permissions'
  }

  async function handle(request: RecorderTabRequest): Promise<unknown> {
    switch (request.type) {
      case 'start-desktop':
        return startDesktop(request)
      case 'stop':
        try {
          // A stop during the countdown discards the start, which has nothing to save.
          const recorded = isRecording()
          const result = await stopRecording()
          if (recorded) screen = 'done'
          return result
        } catch (error) {
          screen = 'kept'
          throw error
        }
      case 'cancel': {
        const result = await cancelRecording()
        screen = 'done'
        return result
      }
      case 'pause':
        return pauseRecording()
      case 'resume':
        return resumeRecording()
      case 'status':
        return status()
      case 'download-settled':
        return downloadSettled(request)
      case 'set-mic-muted':
        return setSourceMuted('mic', request.muted)
      case 'request-permissions':
        await askForPermissions()
        return { camera: cameraGranted, microphone: micGranted }
    }
  }

  onMount(() => {
    const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      if (!isFor(message, 'recorder-tab')) return false
      handle(message).then(
        (value) => sendResponse(ok(value)),
        (error) => {
          const text = error instanceof Error ? error.message : String(error)
          if (message.type === 'start-desktop' && text !== 'cancelled') {
            markFailed(error)
            screen = 'error'
            detail = text
          }
          sendResponse(fail(error))
        },
      )
      return true
    }
    chrome.runtime.onMessage.addListener(listener)

    // Closing this tab kills the encoder mid-write; the part file is recoverable, but warn first.
    const guard = (event: BeforeUnloadEvent) => {
      if (isRecording()) event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)

    void chrome.runtime.sendMessage({ target: 'background', type: 'recorder-tab-ready' })

    return () => {
      chrome.runtime.onMessage.removeListener(listener)
      window.removeEventListener('beforeunload', guard)
    }
  })
</script>

<main>
  <div class="card">
    <Butterfly size={56} state={screen === 'recording' ? 'active' : 'idle'} />

    {#if screen === 'waiting'}
      <h1>Getting ready</h1>
      <p>Choose what to share in the dialog Chrome is showing.</p>
    {:else if screen === 'recording'}
      <h1><span class="dot"></span> Recording</h1>
      <p class="source">{sourceLabel}</p>
      {#if detail}<p class="detail">Capturing {detail}</p>{/if}
      <p class="warn">Keep this tab open. Closing it ends the recording.</p>
    {:else if screen === 'permissions'}
      <h1>Permissions</h1>
      <ul class="perms">
        <li class:granted={cameraGranted}>{cameraGranted ? '✓' : '—'} Camera</li>
        <li class:granted={micGranted}>{micGranted ? '✓' : '—'} Microphone</li>
      </ul>
      <p>
        {#if cameraGranted && micGranted}
          You're all set. You can close this tab.
        {:else}
          Butterfly Record works without these — you'll just record without a
          camera bubble or narration. Grant them from Chrome's address bar if
          you change your mind.
        {/if}
      </p>
    {:else if screen === 'done'}
      <h1>Finished</h1>
      <p>Your recording is saved. You can close this tab.</p>
    {:else if screen === 'kept'}
      <h1>Kept for recovery</h1>
      <p>The recording couldn't be finished. Open the library to recover it.</p>
    {:else}
      <h1>Couldn't start</h1>
      <p class="error">{detail}</p>
    {/if}
  </div>
</main>

<style>
  main {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 24px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-ui);
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 420px;
    padding: 40px 32px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    text-align: center;
  }

  h1 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0 0;
    font-size: 18px;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--fg-muted);
    line-height: 1.5;
  }

  .source {
    color: var(--fg);
    font-weight: 500;
  }

  .detail {
    font-size: 13px;
  }

  .warn {
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--hairline);
    color: var(--caution);
    font-size: 13px;
  }

  .error {
    color: var(--danger);
  }

  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--record);
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }

  .perms {
    display: flex;
    gap: 18px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-variant-numeric: tabular-nums;
  }

  .perms li {
    color: var(--fg-faint);
  }

  .perms li.granted {
    color: var(--ok);
  }
</style>
