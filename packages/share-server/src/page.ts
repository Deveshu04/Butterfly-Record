import type { ShareRecord } from './db.ts'
import { escapeHtml } from './util.ts'

const MARK = `<svg class="mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <circle cx="7.2" cy="9" r="4.8" /><circle cx="8.2" cy="16" r="3.6" />
  <circle cx="16.8" cy="9" r="4.8" /><circle cx="15.8" cy="16" r="3.6" />
  <rect x="11.15" y="7.4" width="1.7" height="10" rx="0.85" />
  <path d="M11.7 7.6 C11.1 5.8 10 4.6 8.8 3.9" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
  <path d="M12.3 7.6 C12.9 5.8 14 4.6 15.2 3.9" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
</svg>`

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    background: light-dark(#fafafa, #161616);
    color: light-dark(#1a1a1a, #ededed);
    font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 9px; height: 52px; padding: 0 20px;
    border-bottom: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14));
  }
  .mark { fill: currentColor; }
  main { max-width: 960px; margin: 0 auto; padding: 20px; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  video { width: 100%; aspect-ratio: 16/9; background: #000;
    border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); border-radius: 8px; }
  .meta { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px;
    color: light-dark(#6f6f6f, #9a9a9a); font-size: 13px; }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  a.button, button {
    padding: 8px 13px; border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14));
    border-radius: 8px; background: light-dark(#fff, #1f1f1f);
    color: inherit; font: inherit; text-decoration: none; cursor: pointer;
  }
  .card { max-width: 380px; margin: 72px auto; padding: 28px; text-align: center;
    border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14));
    border-radius: 12px; background: light-dark(#fff, #1f1f1f); }
  input[type=password] { width: 100%; margin: 14px 0; padding: 9px 11px;
    border: 1px solid light-dark(rgba(0,0,0,.22), rgba(255,255,255,.26));
    border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  .error { color: light-dark(#b3261e, #ff7369); }
  footer { max-width: 960px; margin: 32px auto 0; padding: 14px 20px;
    border-top: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14));
    color: light-dark(#a3a3a3, #6b6b6b); font-size: 12px; }
`

function shell(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
${head}
</head><body>
<header>${MARK}<strong>Butterfly Record</strong></header>
${body}
<footer>Served by butterfly-share — free, self-hosted screen recording.</footer>
</body></html>`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  const total = Math.round(seconds)
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = String(total % 60).padStart(2, '0')
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

export function watchPage(record: ShareRecord, publicUrl: string): string {
  const title = record.title || 'Untitled recording'
  const url = `${publicUrl}/v/${record.shareKey}`
  const media = `${publicUrl}/media/${record.shareKey}`

  // A partial upload would stall the player, so show a notice and auto-refresh.
  if (record.status === 'uploading') {
    return shell(
      title,
      `<main><div class="card">
        <h1>${escapeHtml(title)}</h1>
        <p>This recording is still being uploaded. The page will refresh itself.</p>
      </div></main>`,
      '<meta http-equiv="refresh" content="5">',
    )
  }

  const meta = [
    new Date(record.createdAt).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    formatDuration(record.duration),
    record.width && record.height ? `${record.width}x${record.height}` : '',
    `${record.views} view${record.views === 1 ? '' : 's'}`,
  ].filter(Boolean)

  const head = `
<link rel="alternate" type="application/json+oembed"
      href="${escapeHtml(publicUrl)}/v1/oembed?url=${encodeURIComponent(url)}" title="${escapeHtml(title)}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:video" content="${escapeHtml(media)}">
<meta name="twitter:card" content="player">`

  return shell(
    title,
    `<main>
  <video src="${escapeHtml(media)}" controls playsinline preload="metadata"
         ${record.allowDownload ? '' : 'controlslist="nodownload"'}></video>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
  ${
    record.allowDownload
      ? `<div class="actions"><a class="button" href="${escapeHtml(media)}?download=1" download>Download</a></div>`
      : ''
  }
  <script>
    // Cookie-less engagement: one beacon once the viewer has genuinely
    // watched, so the owner sees "played" separately from "opened". No
    // identity is sent and none is stored.
    (function () {
      var v = document.querySelector('video'), sent = false
      if (!v) return
      v.addEventListener('timeupdate', function () {
        if (sent) return
        var far = v.duration && v.currentTime / v.duration >= 0.75
        if (v.currentTime < 5 && !far) return
        sent = true
        navigator.sendBeacon('${escapeHtml(publicUrl)}/v1/beacon/${record.shareKey}')
      })
    })()
  </script>
</main>`,
    head,
  )
}

export function passwordPage(shareKeyValue: string, failed: boolean): string {
  return shell(
    'Password required',
    `<main><form class="card" method="POST" action="/v/${shareKeyValue}/unlock">
      <h1>This recording is protected</h1>
      <p>Enter the password you were given.</p>
      <input type="password" name="password" autocomplete="current-password" autofocus required>
      ${failed ? '<p class="error">That password did not work.</p>' : ''}
      <button type="submit">Unlock</button>
    </form></main>`,
  )
}

export function messagePage(status: number, heading: string, detail: string): string {
  return shell(
    heading,
    `<main><div class="card"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></div></main>`,
  )
}

/** The minimal player used inside an oEmbed iframe. */
export function embedPage(record: ShareRecord, publicUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%}</style>
</head><body><video src="${escapeHtml(`${publicUrl}/media/${record.shareKey}`)}" controls playsinline></video></body></html>`
}
