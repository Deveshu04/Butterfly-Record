# Butterfly Record

Butterfly Record is a free, open-source screen recorder that saves every recording to
your own disk: no account, no upload, no time limit and no watermark. It comes as a
Windows app and as a Chrome extension, both built on the same recording engine. Sharing
a link is optional and goes through a server you run yourself. The Windows app can also
transcribe recordings on your PC, and with your own Sarvam AI API key translate, dub and
summarize them.

## Download

### Windows app

Download the installer, `Butterfly Record_<version>_x64-setup.exe`, from the
[latest release](https://github.com/Deveshu04/Butterfly-Record/releases/latest)
(GitHub lists it with a dot in place of the space) and run it. It needs 64-bit Windows
10 or 11.

- **SmartScreen warning.** The installer is not code-signed, so Windows may show
  "Windows protected your PC". Choose **More info**, then **Run anyway**. Your browser
  may also warn that the file is not commonly downloaded; choose to keep it.
- **No administrator rights.** The installer installs for your Windows account only.
- **WebView2.** The app uses the Microsoft Edge WebView2 Runtime, which Windows 11
  already includes. If it is missing, the installer downloads and installs it from
  Microsoft.
- **Where recordings go.** Each recording is a `.webm` file in
  `%USERPROFILE%\Videos\Butterfly Record`. You can choose another folder in Settings.
  The app keeps its data for each video (thumbnail, transcripts) in a hidden
  `.butterfly` folder inside that folder.
- **Uninstalling** from Windows Settings > Apps keeps your recordings and the
  `.butterfly` folder. If you tick **Delete the application data** in the uninstaller,
  it also removes your settings, the downloaded speech models and the saved Sarvam key.

### Chrome extension

The extension is not on the Chrome Web Store yet. Until it is, load it unpacked:

1. Download `butterfly-record-extension-<version>.zip` from the
   [latest release](https://github.com/Deveshu04/Butterfly-Record/releases/latest)
   and extract it to a folder you will keep, or build it from source (see
   [Building from source](#building-from-source)).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the folder that contains `manifest.json` (for a
   source build, `dist/chrome-mv3`, not the repository root).

It needs Chrome 123 or later. Chrome identifies an unpacked extension by its folder, and
the extension keeps its library in its own storage. To update, replace the files in the
same folder and press the reload button on the extension's card; loading a different
folder adds a second copy with an empty library. Removing the extension deletes its
library, but the `.webm` files it already saved to your folder or to Downloads stay.

To record, open an ordinary web page, click the butterfly in the toolbar and press
**Start Recording**. The extension cannot run on Chrome's own `chrome://` pages, the
Chrome Web Store or the built-in PDF viewer. The first recording asks for microphone
access; if you decline, the recording has no narration.

## Windows app

- Record the **whole screen or one window** at up to 720p, 1080p, 1440p or 4K (a
  smaller screen is never upscaled), at 30 or 60 fps.
- Your **microphone** (pick the device and check it on a live level meter) and **system
  audio**: turn on **Share with system audio** in the screen picker. System audio is
  available for screen recordings, not single windows.
- Your **camera** in a floating window you can put anywhere on any monitor: four frames
  (circle, rounded, wide, tall), resizable by its corner or with Ctrl and the mouse
  wheel, mirrored or not. Wherever you drag it is where it appears in the video, for
  screen and window recordings alike. Blur what is behind you (light or strong), replace
  it with a picture of your own or a plain color, and turn on a light touch-up for dim
  rooms; finding you in the picture happens on your PC. The recording bar can hide and
  show it while you record, and it releases the camera as soon as you are done.
- An optional 3-second **countdown**, and an option to minimize the window while
  recording.
- A small **floating recording bar** with a timer, pause and resume, microphone mute,
  stop and discard. It stays on top of other windows and is excluded from the capture,
  so it never appears in the video.
- **Alt+Shift+R** from anywhere opens New recording, or stops a recording in progress.
  The menu of the notification-area icon does the same, and closing the window leaves
  the app running there unless you turn that off in Settings.
- Each recording is a **regular VP9/Opus WebM file** named after its title, with a
  correct duration and seek index.
- A **library** with thumbnails, search over titles and descriptions, sorting (newest,
  oldest, name, longest, largest) and **import** of existing video and audio (MP4,
  MOV, M4V, WebM, MKV, MP3, WAV, M4A, AAC, OGG, Opus, FLAC). Imported files stay where
  they are.
- **Rename** a recording and its file is renamed to match.
- **Delete** moves the video and its data to the Recycle Bin. Removing an imported
  video from the library leaves its file untouched.
- **Crash recovery**: if a recording is interrupted (a crash or power loss), what was
  captured stays on disk, and **Recover recording** on the video's page rebuilds a
  playable file from it.
- A **player** with playback speed (0.5x to 2x), captions and keyboard shortcuts:
  Space or K to play and pause, J and L or the arrow keys to skip 6 seconds, comma and
  period to skip 1 second, F for full screen, M to mute, C for captions.
- **Transcribe on your PC** with Whisper, with no account or key: English, 14 Indian
  languages and the other languages Whisper knows, with automatic language detection
  and, with the Base and Small models, an English-translation mode. It runs on the GPU
  when there is one and on the CPU otherwise. The speech model downloads once from
  Hugging Face, between about 140 MB (Base) and 940 MB (Large-v3 Turbo); after that
  transcription works offline and the audio never leaves your PC. Search the
  transcript, click a line to jump to it, and export SRT, VTT or plain text.
- With your own **Sarvam AI** key:
  - **Transcribe** with Sarvam instead, in 22 Indian languages and English, with
    automatic language detection, an English-translation mode and speaker labels.
  - **Translate** subtitles into another language.
  - **Dub** into other Indian languages or English with Sarvam Dubbing, which keeps each
    speaker's voice, or with a Sarvam text-to-speech voice at lower cost. Dubbed copies are saved
    as new files next to the original, and the player can switch to them.
  - **Summarize** a transcript into a title and a description.

Build details, environment variables and known limitations are in
[packages/desktop/README.md](packages/desktop/README.md).

### Setting up Sarvam

1. Create an API key at [dashboard.sarvam.ai](https://dashboard.sarvam.ai).
2. In the app, open **Settings > Sarvam**, paste the key and choose **Save**. The app
   checks the key straight away; **Test** checks it again at any time.

Sarvam bills each job to your own Sarvam account. The Transcribe, Translate and Dub
panels show an estimated cost before you start; the amount charged is whatever Sarvam
bills. The key is stored in Windows Credential Manager, and the app contacts Sarvam only
when you start a job. [PRIVACY.md](PRIVACY.md) lists what each feature sends.

When dubbing with Sarvam Dubbing, the **Upload** option decides what leaves your PC.
**Audio only** (the default) sends just the soundtrack; the dubbed audio comes back and
is put onto the video on your PC. **Full video** uploads the whole file, picture
included.

## Chrome extension

- Record a **tab**, a **whole screen** or a **single window**
- Tab audio, system audio and your microphone, mixed into one track
- Unlimited length: chunks stream to disk as you record, at flat memory
- VP9/Opus WebM at a resolution-appropriate bitrate (never Chrome's flat 2.5 Mbps)
- A **seekable** output file, with a working scrubber and correct duration
- **On-screen controls** while recording: a countdown, a draggable bar with stop,
  pause, restart, cancel, a live timer and microphone mute, and a draggable, resizable
  **camera bubble** (circle or rounded rectangle)
- **Draw on the page** while recording (strokes fade on their own), highlight clicks
  and spotlight the cursor
- Keyboard shortcuts: `Alt+Shift+R` starts and stops, `Alt+Shift+P` pauses and
  resumes, `Alt+Shift+C` cancels, `Alt+Shift+D` draws on the page
- Quality (720p to 4K) and frame-rate (30/60) settings that are honoured at capture, a
  chosen microphone that is actually used, and a live input level meter before you
  record
- Every finished recording is also saved as a `.webm` file, in a folder you choose or
  in `Downloads\Butterfly Record`
- A **library** with generated thumbnails, hover previews, search, folders, sort, a
  player with keyboard shortcuts, rename, export, and a **trash**: deleting keeps a
  recording restorable for 30 days
- Pin any frame as a recording's thumbnail
- A **non-destructive editor**: split, trim, cut out the middle, undo/redo, an audio
  **waveform**, 1x to 50x timeline **zoom**, and export. Cuts are **frame-exact** (the
  boundary GOP is re-encoded; everything else is a lossless packet copy). Your original
  file is never rewritten, so Revert always works
- **Filler-word and silence removal**: transcript-driven, two aggressiveness levels,
  exactly reversible
- **On-device transcription** with search, click-to-seek, and SRT / VTT / TXT
  downloads. The model runs on your machine; nothing is uploaded
- **Crash recovery**: if a recording is interrupted, the captured video is rebuilt
  from disk instead of lost
- Sticky settings: it remembers how you recorded last time

On-device transcription is why the extension is about 25 MB rather than under 1 MB.
Almost all of that is the ONNX Runtime WebAssembly file the speech model needs, which
must be bundled because Manifest V3 forbids loading code at run time.

## Sharing

Recording is entirely local. To hand someone a link from the Chrome extension, run
[butterfly-share](packages/share-server/README.md), a small server with no runtime
dependencies. No prebuilt image is published, so build it first, from the repository
root:

```
docker build -t butterfly-share packages/share-server
docker run -d --name butterfly-share -p 8080:8080 -v butterfly-share-data:/data \
  -e BUTTERFLY_PUBLIC_URL=https://share.example.com butterfly-share
docker logs butterfly-share
```

The log shows the server's upload token. In the extension's library, open a recording,
enter the server URL and the token in the **Share** panel, and choose **Upload and get
a link**. The extension uploads the finished recording; it does not stream while you
record. The link is created before the upload finishes and starts playing once it
completes. Each link can have a password, an expiry and downloads turned on or off.
Playback supports seeking, and view counts use no cookies and cannot identify a viewer.

The Windows app does not share links yet.

## Building from source

Requirements:

- Node 24 and pnpm 10.
- For the Windows app, also Rust (stable, MSVC toolchain) and Visual Studio Build Tools
  with the **Desktop development with C++** workload.

```
pnpm install
pnpm build            # Chrome extension into dist/chrome-mv3
pnpm dev              # extension watch build that reloads as you edit
pnpm zip              # extension build, zipped into dist/
pnpm desktop:dev      # Windows app with hot reload
pnpm desktop:build    # Windows installer
pnpm check            # typecheck every package
pnpm test             # unit tests
pnpm icons            # regenerate the icons from the SVGs in assets/
```

`pnpm desktop:build` writes the installer to
`packages/desktop/src-tauri/target/release/bundle/nsis/Butterfly Record_<version>_x64-setup.exe`.

The end-to-end checks, which record for real in Chromium and in the built Windows app,
are described in [e2e/README.md](e2e/README.md).

## Project layout

```
packages/core          recording engine: capture, mixing, encoding, storage, edits, share client
packages/ui            design tokens, icons and the logo shared by both apps
packages/extension     the Chrome MV3 extension (WXT + Svelte 5)
packages/desktop       the Windows app (Tauri v2 + Svelte 5) driving the same engine
packages/share-server  butterfly-share, the optional self-hosted link server
e2e                    Playwright harness that records for real and verifies the result
scripts                icon generation, third-party notices and version bumps
assets                 source artwork for the icons
```

`core` knows nothing about Chrome extension APIs, so the Windows app drives the same
capture, mixing, encoding and finalize code.

## How it works

Three things in the architecture are non-obvious and load-bearing:

- **The extension records in an offscreen document.** A service worker has no DOM and
  gets torn down mid-recording, so it cannot hold a `MediaRecorder`. The worker only
  mints tab-capture stream IDs and coordinates.
- **Audio is always mixed through Web Audio.** Chrome's `MediaRecorder` records only the
  *first* audio track, so handing it both tab audio and a microphone silently drops the
  microphone. Capturing a tab also mutes it for you, so the captured audio is re-routed
  back to your speakers.
- **The file is rebuilt when you stop.** `MediaRecorder` writes the WebM header before
  it knows the duration, so it omits `Duration` and never writes the seek index: the
  classic `duration === Infinity` bug. Finalize remuxes the file (a packet copy, not a
  re-encode) to add both.

## Privacy

There are no accounts and no telemetry. Recordings stay on your disk unless you upload
one to a share server you run yourself, or start a Sarvam job in the Windows app with
your own key, which sends the recording's audio, its transcript text or, if you choose,
the whole video. The only other network request either app makes downloads a speech
model from Hugging Face the first time you transcribe on your computer. The full policy,
including what each Sarvam feature sends and why the extension needs each permission, is
in [PRIVACY.md](PRIVACY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and how releases are made.
Questions and bug reports go to
[GitHub issues](https://github.com/Deveshu04/Butterfly-Record/issues).

## Licence

MIT; see [LICENSE](LICENSE). Bundled third-party software keeps its own licence. Each
build writes the full list with licence texts to `THIRD_PARTY_NOTICES.txt`: the
extension links to it from the library, and the Windows app shows it under
**Settings > About > Third-party notices**.
