# End-to-end harness

Drives a headed Chromium via Playwright with the built extension loaded, records for
real, and checks what lands in the extension's storage (OPFS). A second script drives the
built Windows app over the WebView2 DevTools protocol.

This is a standalone npm package (Playwright and `ws`), outside the pnpm workspace.

## Running

```
pnpm build                # from the repo root; the harness loads dist/chrome-mv3
cd e2e
npm install
npx playwright install chromium
npm run verify:remux      # record 15 s of screen → finalize → seek test
npm run verify:bubble     # camera bubble with fake devices, prompt-free
npm run probe:real-camera # camera bubble against the machine's real webcam
npm run probe:permission  # how Chromium treats the extension origin

pnpm desktop:build        # from the repo root; the smoke test runs the release exe
npm run smoke:desktop     # record, finalize, import and quit in the real app
```

The Chromium scripts launch a fresh profile (`profile-*/`) and close their browser. A
Chromium window appears for about 30 s per run; `probe:real-camera` briefly opens the
real webcam (nothing is recorded or saved).

`smoke:desktop` runs the app on a scratch library and settings folder in the temp
directory, so your own recordings and settings are never touched. Quit Butterfly Record
(including from the tray) before running it: a second launch hands over to the running
copy, and the test checks for this and stops. It also needs port 9333 free.

Every script writes a `report-*.json` verdict and a `logs-*.txt` console capture;
`smoke:desktop` also saves `failure-desktop-smoke.png` when it fails. All of these are
gitignored.

## Scripts

| Script | Checks |
|---|---|
| `verify:remux` | Capture → OPFS → `finalizeRecording` produces a **seekable** file with finite duration, and `source.part` is cleaned up. Fails if the salvage path ran (duration 0) or a mid-file seek doesn't land. |
| `verify:bubble` | The camera bubble iframe goes live during a recording (fake camera, with and without `--use-fake-ui-for-media-stream`). |
| `probe:real-camera` | Same, against real hardware and real permission prompts. |
| `probe:permission` | How Chromium grants camera access to the extension origin at top level versus in an iframe on a web page. |
| `smoke:desktop` | Launches `packages/desktop/src-tauri/target/release/butterfly-record-desktop.exe` on a scratch library (`BUTTERFLY_RECORD_LIBRARY_DIR`) and settings folder (`BUTTERFLY_RECORD_CONFIG_DIR`) with DevTools enabled (`BUTTERFLY_RECORD_WEBVIEW_ARGS`). It records the screen for 6 s from the Record page, stops from the recording bar, and checks the library folder: exactly one `.webm` with VP9 video and a duration in its header, a `ready` manifest pointing at it, a poster and no `source.part`. It then imports a copy from outside the library (`BUTTERFLY_RECORD_TEST_IMPORT` stands in for the file dialog) and quits through `app_quit`. |

`smoke:desktop` records the real screen with no microphone. Options:

| Variable | Effect |
|---|---|
| `SMOKE_CAPTURE=fake` | Record Chromium's generated test pattern and a generated microphone instead; no real audio device is opened. Also turns on the generated camera, checks the overlay, then turns on a background blur from the Record page and checks the overlay draws it over a live picture. |
| `SMOKE_SCREENSHOTS=<dir>` | Save a screenshot of every view. |
| `SMOKE_KEEP=1` | Keep the scratch library and settings folders for inspection. |

Key flags: `--auto-select-desktop-capture-source` (skips the picker),
`--use-fake-ui-for-media-stream` (grants capture without a prompt),
`--use-fake-device-for-media-stream` (deterministic camera and microphone), and a CDP
console collector attached to every target so the offscreen document's
`finalizing`/`finalized` lines are captured.
