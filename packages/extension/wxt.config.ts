import { defineConfig } from 'wxt'

import { version } from './package.json' with { type: 'json' }
import { writeThirdPartyNotices } from './third-party-notices.ts'

// https://wxt.dev/api/config.html
export default defineConfig({
  // Baked in at build time: chrome.runtime.getManifest() is not available in
  // every recording context.
  vite: () => ({
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: {
      // Vite adds `crossorigin` to modulepreload links, which Chrome rejects as a
      // "cross-world extension resource mismatch" inside the embedded camera bubble.
      modulePreload: false,
    },
  }),

  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],

  hooks: { 'build:done': writeThirdPartyNotices },

  // Output goes to <repo>/dist/chrome-mv3, the folder to pick in "Load unpacked".
  outDir: '../../dist',

  manifest: {
    name: 'Butterfly Record',
    short_name: 'Butterfly',
    description:
      'Free screen recording that stays on your machine. Record your screen, camera and voice, edit, and share — no account, no upload, no time limit.',
    homepage_url: 'https://github.com/butterfly-labs/butterfly-record',

    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },

    action: {
      default_title: 'Butterfly Record',
      default_icon: {
        16: 'icons/16.png',
        19: 'icons/19.png',
        32: 'icons/32.png',
        38: 'icons/38.png',
      },
    },

    permissions: [
      // unlimitedStorage lifts the OPFS quota for long recordings.
      'storage',
      'unlimitedStorage',
      // Media APIs need a DOM, which a service worker lacks.
      'offscreen',
      // On-demand injection of the HUD and camera bubble.
      'scripting',
      'activeTab',
      'tabCapture',
      'desktopCapture',
      'downloads',
      // The only feedback channel on pages Chrome blocks from scripting.
      'notifications',
    ],

    // Needed to inject the HUD on any page, upload to a user-chosen share server
    // and fetch the speech model. `tabs` is omitted; activeTab covers the recorded tab.
    host_permissions: ['<all_urls>'],

    // The camera bubble is an extension-origin iframe, so one camera grant covers
    // every site. WXT appends the overlay's CSS here.
    web_accessible_resources: [{ resources: ['bubble.html'], matches: ['<all_urls>'] }],

    // Chrome allows suggested keys for at most four commands. A command counts as
    // invoking the extension, so tabCapture works from a shortcut.
    commands: {
      'toggle-recording': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Start or stop recording',
      },
      'pause-recording': {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Pause or resume recording',
      },
      'cancel-recording': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: 'Cancel recording and discard it',
      },
      'toggle-draw': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Draw on the page',
      },
    },

    content_security_policy: {
      // 'wasm-unsafe-eval' runs the on-device speech model; no remote script is loaded.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },

    // Floor set by light-dark() in the design tokens and chrome.runtime.getContexts().
    minimum_chrome_version: '123',
  },
})
