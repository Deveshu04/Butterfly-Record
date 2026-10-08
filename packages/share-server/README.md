# butterfly-share

The optional self-hosted share server for [Butterfly Record](../../README.md).

Butterfly Record keeps recordings on your own disk. Run this server if you want to share
a recording as a link: the Chrome extension uploads a finished recording to your server,
which serves a watch page for it. The Windows app does not share links yet.

It has no runtime dependencies. SQLite (`node:sqlite`) and the HTTP server come from
Node's standard library, and Node runs the TypeScript sources directly.

## Running it

With Docker, from the repository root. No prebuilt image is published, so build it
first:

```
docker build -t butterfly-share packages/share-server
docker run -d --name butterfly-share -p 8080:8080 \
  -v butterfly-share-data:/data \
  -e BUTTERFLY_PUBLIC_URL=https://share.example.com \
  butterfly-share
docker logs butterfly-share
```

The image runs as an unprivileged user and has a health check on `/healthz`.

Without Docker (Node 24 or later), from `packages/share-server`:

```
BUTTERFLY_DATA_DIR=./data node src/index.ts
```

In PowerShell: `$env:BUTTERFLY_DATA_DIR = "./data"; node src/index.ts`.

On startup the server prints its **upload token**. In the extension's library, open a
recording and enter the server URL and the token in its **Share** panel. Treat the token
like a password: anyone who has it can upload to your server.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `BUTTERFLY_DATA_DIR` | `/data` | SQLite database, media files and secrets |
| `BUTTERFLY_PUBLIC_URL` | `http://localhost:$PORT` | Base URL for share links; set this behind a proxy |
| `BUTTERFLY_UPLOAD_TOKEN` | generated | Bearer token required to upload |
| `BUTTERFLY_COOKIE_SECRET` | generated | Signs unlock cookies and view fingerprints |
| `BUTTERFLY_MAX_UPLOAD_BYTES` | 20 GB | Larger uploads are rejected |

The data directory holds `butterfly-share.db`, the uploaded files in `media/`, and the
generated secrets (`upload-token`, `cookie-secret`), so they survive restarts.

## How it works

- **Uploads use [tus 1.0](https://tus.io)** (`creation`, `creation-defer-length`,
  `termination`), so an interrupted upload resumes from the last stored byte.
- **The share URL is returned when the upload is created.** Until the upload completes,
  the share page shows an "uploading" notice and refreshes itself.
- **Each link can have a password, an expiry and downloads turned on or off.** With
  downloads on, the share page has a Download button.
- **Playback is a single file served with HTTP Range support**, so seeking works without
  transcoding or HLS.
- **View counts use no cookies.** A viewer is a truncated HMAC of IP address, user agent
  and day, keyed with the server secret, so it rotates daily and cannot be reversed. Only
  requests for the video count, not page loads. A view is marked "watched" after 5
  seconds or 75% of playback.
- **oEmbed and Open Graph tags** let chat and document tools unfurl share links.

## Endpoints

| | |
|---|---|
| `POST /v1/uploads` | Create an upload (auth) → share key, share URL, upload URL |
| `HEAD /v1/uploads/:key` | Current offset, for resuming (auth) |
| `PATCH /v1/uploads/:key` | Append bytes at `Upload-Offset` (auth) |
| `PATCH /v1/uploads/:key/meta` | Set title/duration, mark ready (auth) |
| `DELETE /v1/uploads/:key` | Delete recording and media (auth) |
| `GET /v/:key` | Share page |
| `POST /v/:key/unlock` | Submit a password |
| `GET /media/:key` | The video, with Range support; `?download=1` when downloads are allowed |
| `GET /embed/:key` | Bare player for oEmbed iframes |
| `GET /v1/oembed?url=` | oEmbed payload |
| `POST /v1/beacon/:key` | Mark a view as watched |
| `GET /healthz` | Liveness |

## Security notes

- Share keys are 128 random bits. Links are unlisted, not secret: anyone with the link
  can watch unless a password or expiry is set.
- Passwords are hashed with scrypt. Unlock cookies are HMAC-signed, `HttpOnly`, and
  expire after 12 hours.
- Password protection gates the media endpoint as well as the page. Protected
  recordings are not available through `/embed`.
- Expired links return 404 like unknown links, and an hourly sweep deletes their media.
- `Access-Control-Allow-Origin: *` is safe because every mutating endpoint is
  authorised by a bearer token, never by a cookie.
- **Run it behind TLS.** The server does not terminate TLS itself, and the upload token
  is sent as a bearer header.
- For view counts, the viewer's address is the first `X-Forwarded-For` entry when that
  header is present. Behind a reverse proxy this is the real client; without one,
  clients can set it themselves, which affects only view counts.

## Tests

From `packages/share-server` (or `pnpm --filter @butterfly-record/share-server test`
from the repository root):

```
node --test test/*.test.ts
```

The tests start a real server on an ephemeral port and cover a resumable upload, offset
conflicts, Range requests, password gating, expired links, view de-duplication and
oEmbed.
