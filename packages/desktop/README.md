# Butterfly Record for Windows

A free screen recorder that saves every recording as a regular video file on your PC.
Nothing leaves your computer unless you start a Sarvam job with your own API key, and
transcription can run entirely on the PC.
Installation is covered in the [root README](../../README.md#windows-app); this file
covers features, the build and known limitations.

## Features

- **Record** the whole screen or one window at up to 4K and 30 or 60 fps, with your
  microphone and, for screen recordings, system audio. An optional 3-second countdown.
  Pause, resume, mute and discard from a small recording bar that stays on top and out
  of the recording itself.
- **Camera.** Turn the camera on from the Record page and a small floating window shows
  your webcam. Drag it anywhere on any monitor, resize it from its bottom-right corner or
  with Ctrl and the mouse wheel, choose a frame (circle, rounded, wide or tall) and mirror
  it or not. Screen recordings capture it exactly where you put it. A single-window
  capture cannot see another window, so there the camera is drawn into the frames at the
  matching place: the overlay's position on its monitor, as a fraction of the work area,
  becomes the same fraction of the recorded frame, and moving it during a recording moves
  it in the video. The recording bar can hide and show it while you record, and it closes
  and releases the camera as soon as you stop or leave the Record page.
- **Alt+Shift+R** opens New recording from anywhere, or stops a recording in progress;
  the menu of the notification-area icon does the same. Closing the window leaves the
  app running there unless you turn that off in Settings.
- **Real files.** Recordings are VP9/Opus WebM files named after their title, in
  `Videos\Butterfly Record` or a folder you choose in **Settings > General > Library
  folder**. The app keeps its own data for each video (manifest, thumbnail, transcripts,
  pending Sarvam jobs) in a hidden `.butterfly` folder inside it.
- **Library** with search, sorting and **import** of existing video or audio (MP4, MOV,
  M4V, WebM, MKV, MP3, WAV, M4A, AAC, OGG, Opus, FLAC). Renaming a recording renames
  its file, and deleting one moves the file and its data to the Recycle Bin. Imported
  files stay where they are and keep their name; removing one from the library leaves
  the file in place.
- **Recovery.** A recording interrupted by a crash or power loss stays on disk and can
  be rebuilt from its page in the library.
- **Player** with playback speed (0.5x to 2x), captions in any transcript language, a
  switch between the original and dubbed audio, and keyboard shortcuts (Space or K, J
  and L, the arrow keys, comma and period, F, M, C), listed in the player.
- **Transcribe** on this PC with Whisper, or with Sarvam Saaras and your API key; each
  run can use either. On the PC: English, 14 Indian languages and the other languages
  Whisper knows, automatic language detection, and an English-translation mode with the
  Base and Small models. With Sarvam: 22 Indian languages and English, automatic
  language detection, an English-translation mode and speaker labels. Search the
  transcript, click a line to jump to it, and copy it or save it as SRT, VTT or plain
  text.
- **Translate** subtitles into any supported language with Sarvam Translate or Mayura.
- **Dub** a video into other languages with Sarvam Dubbing, which keeps each speaker's
  voice, or with a Bulbul text-to-speech voice at lower cost. Dubbed copies are saved
  next to the original.
- **Summarize** a transcript into a title and description.

## Transcription on this PC

Whisper runs inside the app through transformers.js and ONNX Runtime Web, in a background
worker so the window stays responsive. Without a Sarvam key it is the engine every
transcription uses, with nothing to set up. With a key, **Settings > Transcription >
Default engine** decides which engine the Transcribe panel starts with, and the panel can
switch for a single run.

| Model | Download on a GPU / on the CPU | Notes |
|---|---|---|
| Base | 138 MB / 143 MB | Fastest, and weakest outside English |
| Small (default) | 288 MB / 313 MB | |
| Large-v3 Turbo | 727 MB / 936 MB | Most accurate; needs a GPU to be practical; cannot translate into English |

- **GPU or CPU.** With **Processor** on **Automatic**, the model runs on the GPU through
  WebGPU whenever WebView2 finds a hardware adapter (Settings shows which one), with 4-bit
  weights. Otherwise, or with **CPU only**, it runs in WebAssembly with an 8-bit encoder.
  If the GPU cannot load the model, the job carries on on the CPU.
- **Downloaded once.** The first transcription with a model downloads it from Hugging
  Face (`huggingface.co` and the download servers under `hf.co` it redirects to) into the
  app's WebView2 storage in `%LOCALAPPDATA%\com.butterflylabs.record`. After that no
  connection is needed. **Settings > Transcription > Downloaded models** lists the models
  and deletes them. The ONNX Runtime WebAssembly binary ships with the app.
- **Long recordings** are decoded to 16 kHz mono, about 230 MB of memory per hour, and
  transcribed in windows of up to 30 seconds cut at pauses. Silent stretches are skipped,
  and a window where Whisper starts repeating itself is decoded again. Cancel stops the
  job at once.
- **Language.** Whisper detects the language from the first speech in the recording, or
  uses the one you choose. Choosing it skips a step and is more reliable for short clips
  and for recordings that open with music. Odia, Bodo, Dogri, Kashmiri, Konkani,
  Maithili, Manipuri and Santali are not offered, because Whisper was not trained on them.
- Transcripts are saved in the same format as Sarvam's, with the Whisper model id as the
  model, so captions, translation, dubbing and summaries work on them the same way.

## Sarvam API key

Translation, dubbing, summaries and, when you choose it, transcription run on
[Sarvam AI](https://www.sarvam.ai) and are billed to your own Sarvam account. The
Transcribe, Translate and Dub panels show an estimated cost before you start.

1. Create a key at [dashboard.sarvam.ai](https://dashboard.sarvam.ai).
2. In the app, open **Settings > Sarvam**, paste the key and choose **Save**. The key is
   checked straight away; **Test** checks it again.

The key is stored in Windows Credential Manager (`Butterfly Record/sarvam`). All
requests to Sarvam are made by the app's Rust side, and the key is never handed back to
the interface once saved. Audio is uploaded only when you start a job, and Sarvam
Dubbing uploads the audio track alone unless you choose **Full video**.
[PRIVACY.md](../../PRIVACY.md) lists what each feature sends.

## Build

Requirements: Node 24, pnpm 10, Rust (stable, MSVC toolchain), Visual Studio Build Tools
with the **Desktop development with C++** workload, and the WebView2 Runtime, which
ships with Windows 11.

From the repository root:

```
pnpm install
pnpm desktop:dev      # run with hot reload
pnpm desktop:build    # NSIS installer
pnpm --filter @butterfly-record/desktop check
pnpm --filter @butterfly-record/desktop test
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

`pnpm desktop:build` writes `Butterfly Record_<version>_x64-setup.exe` to
`src-tauri/target/release/bundle/nsis/`, and the bare executable to
`src-tauri/target/release/butterfly-record-desktop.exe`. The installer is per-user,
embeds the WebView2 bootstrapper, and keeps the recordings folder when uninstalling.

`pnpm --filter @butterfly-record/desktop exec vite --mode mock` runs the interface in a
normal browser against an in-memory library, without Rust.

The end-to-end smoke test in [e2e](../../e2e/README.md) (`npm run smoke:desktop`)
drives the built app: it records, finalizes, imports and quits. These environment
variables exist for it and for debugging:

| Variable | Effect |
|---|---|
| `BUTTERFLY_RECORD_LIBRARY_DIR` | Use this folder as the library instead of the saved one, without saving it. |
| `BUTTERFLY_RECORD_CONFIG_DIR` | Keep `settings.json`, `library.json` and `imports.json` in this folder instead of `%APPDATA%\com.butterflylabs.record`. |
| `BUTTERFLY_RECORD_WEBVIEW_ARGS` | Extra WebView2 browser arguments, e.g. `--remote-debugging-port=9222` for DevTools (browser shortcuts such as F12 are turned off). |
| `BUTTERFLY_RECORD_SARVAM_BASE_URL` | Send Sarvam requests to another server (tests). |
| `BUTTERFLY_RECORD_TEST_IMPORT` | `;`-separated file paths that **Import video** uses instead of opening the file dialog. Honoured only together with `BUTTERFLY_RECORD_CONFIG_DIR`. |

## Known limitations

- **Controlled folder access.** When Windows Security's ransomware protection is on, it
  blocks apps it does not know from writing to Documents, Pictures, Videos, Music, Desktop
  and Favorites, including the default `Videos\Butterfly Record`. The app checks its
  library folder at startup and before recording or importing, and offers three ways out:
  use `%USERPROFILE%\Butterfly Record` instead, choose another folder, or allow the app in
  **Windows Security > Virus & threat protection > Manage ransomware protection > Allow an
  app through Controlled folder access** (the dialog shows the exact file to add).
- System audio can be shared only for screen recordings, not single windows, and only
  when "Share with system audio" is turned on in the picker. Audio from one app alone
  cannot be recorded.
- There is no region capture: the whole screen or one window.
- The camera is recorded at the size and position of its window, not at the camera's own
  resolution, so a small overlay enlarged afterwards will look soft.
- In a window recording the camera's place is taken from where the overlay sits on its
  monitor, because a window capture is never told where the recorded window is on screen.
  If that window covers only part of the screen, the camera lands at the matching fraction
  of the video rather than over the same point of the desktop.
- The shortcut and the tray open the recorder but cannot start it by themselves: the
  screen picker needs a click or a key press in the app window.
- The screen picker is WebView2's own and refers to the app as "tauri.localhost".
- Encoding uses the WebView's software VP9 encoder. Long 4K60 recordings need a fast
  CPU.
- Window captures can drop to a low frame rate on some WebView2 versions.
- Imported files play and transcribe only if WebView2 can decode their codecs (HEVC
  needs the HEVC Video Extensions from the Microsoft Store).
- Transcription on the CPU uses a single core: WebAssembly threads need a cross-origin
  isolated page, which the app's pages are not. Small is then slower than real time on
  most PCs, and Large-v3 Turbo is much slower still. Integrated graphics can run the
  larger models slower than real time too.
- Transcription on this PC has no speaker labels, and Large-v3 Turbo has no
  English-translation mode.
- Dubbing an H.264 video produces an MP4 when Windows provides an AAC encoder, otherwise
  an MKV. Text-to-speech dubs are limited to about 12 hours of media.
- There is no link sharing yet; the [share server](../share-server/README.md) works
  with the Chrome extension.
- Windows only.
