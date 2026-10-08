# Privacy policy

Last updated: 8 October 2026

This policy covers the Butterfly Record Windows app and the Butterfly Record Chrome
extension, published by Butterfly Labs at
<https://github.com/butterfly-labs/butterfly-record>.

## Summary

- Your recordings are stored on your own computer.
- There are no accounts, no analytics, no telemetry, no crash reporting and no ads.
  Butterfly Labs does not receive your recordings or any information about how you use
  the apps.
- The apps make network requests only for features you start yourself: the Sarvam AI
  features of the Windows app (transcription, translation, dubbing and summaries, with
  your own API key), the speech-model download in the extension, and uploads to a share
  server you run yourself. Each is described below.

## Windows app

### What is stored on your PC

| What | Where |
|---|---|
| Recordings, dubbed copies, and captions you save to the library folder | `%USERPROFILE%\Videos\Butterfly Record`, or the folder you choose in Settings |
| Data for each video: title, description, thumbnail, transcripts and translations, a record of Sarvam jobs not yet collected, and the raw capture while a recording is in progress | A hidden `.butterfly` folder inside that folder |
| Settings, the chosen library folder, and the locations of files you imported | `%APPDATA%\com.butterflylabs.record` |
| Interface preferences (such as the library sort order and player volume) and a diagnostic log of warnings and errors, limited to three files of 1 MB | `%LOCALAPPDATA%\com.butterflylabs.record` |
| Your Sarvam API key, if you add one | Windows Credential Manager, as `Butterfly Record/sarvam` |

Imported files are not copied or moved; the app remembers where they are.

Uninstalling the app keeps the recordings folder and its `.butterfly` folder. If you
tick **Delete the application data** in the uninstaller, it also deletes the two
`com.butterflylabs.record` folders and the Sarvam key. **Settings > Sarvam > Remove**
deletes the key at any time.

### Microphone and screen

The app opens your microphone for a recording, for the level meter on the New
recording page, and briefly to read the names of your microphones. It records a screen
or window only after you pick one in the screen picker. Nothing captured leaves your PC
unless you start a Sarvam job.

### Network connections

The app connects to the internet only to use Sarvam AI, and only with an API key you
have added. Requests go to `api.sarvam.ai` and to the temporary storage links Sarvam
issues for uploading and downloading job files. Every request carries your API key, and
Sarvam bills your Sarvam account for the work.

The app contacts Sarvam when you:

- start a transcription, translation, dub or summary;
- save or test your key (the test sends the word "Hello" to Sarvam's language
  identification service);
- reopen the app after closing it while a Sarvam job was running, to collect that job's
  results.

What each feature sends:

| Feature | Sent to Sarvam |
|---|---|
| Transcribe | The video's audio track, and the language and speaker-label options you choose |
| Translate | The transcript text |
| Summarize | The transcript text |
| Dub with Sarvam Dubbing, **Audio only** (the default) | The video's audio track |
| Dub with Sarvam Dubbing, **Full video** | The whole video file, picture included |
| Dub with a text-to-speech voice | The transcript text, for translation and then for speech |

Besides your IP address, which any internet connection reveals, and the app's name and
version, nothing else about you or your PC is sent. Sarvam handles the data it receives
under its own terms and privacy policy; see <https://www.sarvam.ai>.

The installer also downloads the Microsoft Edge WebView2 Runtime from Microsoft if
Windows does not already have it. WebView2 is a Windows component that Microsoft
installs and updates under its own terms.

## Chrome extension

### What is stored on your computer

- **Your library** (recordings, thumbnails, previews, transcripts, edits and the trash)
  is kept in the extension's private storage in your Chrome profile. Chrome deletes it
  when you remove the extension.
- **A `.webm` copy of each finished recording** is saved in a folder you choose or, if
  you have not chosen one, in `Downloads\Butterfly Record`. Exports from the library are
  saved where you choose in Chrome's save dialog, and subtitle and transcript downloads
  go to your Downloads folder. These files stay if you remove the extension.
- **Settings**, including a share server's address and upload token if you enter them,
  are kept in the extension's storage in Chrome. Access to the folder you choose is kept
  in the extension's storage too.
- **The speech model**, once downloaded, is kept in the extension's cache so later
  transcriptions work offline.

### Network connections

- **Speech model.** The first time you transcribe a recording, the extension downloads
  the speech model from Hugging Face (`huggingface.co` and the download servers it
  redirects to). Transcription itself runs on your computer; your audio is never sent
  anywhere. Hugging Face receives the request as it would from any browser, including
  your IP address.
- **Share server.** If you enter a share server and choose **Upload and get a link**,
  the extension first checks that the server is reachable, then uploads the recording
  file with its title, duration, dimensions and an internal recording id, along with
  the password, expiry and download setting you chose. This server is one you or your
  organization run; Butterfly Labs does not run one and receives nothing.

The extension makes no other network requests.

### Camera, microphone and screen

The extension turns on the camera and microphone only for a recording, the camera
preview and the microphone level meter in its panel, and Chrome asks for your
permission before the first use. It records a screen or window only after you pick one
in Chrome's picker, and a tab only after you start recording it. The camera bubble is
shown on the page and recorded as part of it. If a site blocks the bubble and you choose
**Use this site's camera**, Chrome asks for camera permission for that site rather than
for the extension. Nothing captured leaves your computer unless you upload a recording
to a share server.

### Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Keeps your settings and the state of a recording in progress. |
| `unlimitedStorage` | Lets the library in the extension's private storage hold long recordings. |
| `offscreen` | Runs the recorder in a hidden extension page, because the background worker cannot use media APIs. |
| `scripting` | Shows the recording controls, camera bubble and drawing layer on the tab you are recording. They are added only when you click the toolbar button or use a shortcut. |
| `activeTab` | Gives access to the current tab when you click the toolbar button or use a shortcut, which is what allows recording that tab. |
| `tabCapture` | Records a tab's picture and sound. |
| `desktopCapture` | Shows Chrome's picker for recording a screen or a window. |
| `downloads` | Saves recordings to `Downloads\Butterfly Record` and opens Chrome's save dialog for exports. |
| `notifications` | Tells you when a recording is saved or fails, including on pages where the controls cannot be shown. |
| Access to all sites (`<all_urls>`) | Shows the controls on whichever page you record, uploads to the share server address you enter, and downloads the speech model. The extension does not read or collect the content of the pages you visit. |

## Self-hosted share server

butterfly-share is software you run yourself, so you control the data it holds. It
stores uploaded recordings, their titles and settings, password hashes, and view counts.
To count views without cookies, it keeps a daily-changing code derived from a viewer's
IP address and browser, from which neither can be recovered; it does not store IP
addresses or request logs. The only cookie it sets is the one that keeps a
password-protected link unlocked for 12 hours. A reverse proxy you run in front of it
may keep its own logs.

## Changes to this policy

Changes are published in this file in the repository, where its full history is
available. The date at the top shows the latest change.

## Contact

Questions about privacy: open an issue at
<https://github.com/butterfly-labs/butterfly-record/issues>.
