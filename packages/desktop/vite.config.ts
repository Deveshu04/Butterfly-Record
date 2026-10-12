import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

import thirdPartyNotices from '../../scripts/third-party-notices.mjs'

export default defineConfig(({ mode }) => ({
  plugins: [
    svelte(),
    thirdPartyNotices({
      product: 'Butterfly Record',
      // Mock builds never ship and may run where Rust is not installed.
      ...(mode === 'mock' ? {} : { cargoManifest: 'src-tauri/Cargo.toml' }),
      notes: [
        'The installer also contains the Microsoft Edge WebView2 Runtime bootstrapper, which ' +
          'installs the runtime when Windows does not already have it. Microsoft licenses the ' +
          'runtime under the Microsoft Software License Terms for Microsoft Edge WebView2.',
      ],
    }),
  ],
  // Tauri watches the terminal for the dev server URL; clearing would hide it.
  clearScreen: false,
  // Outside `--mode mock` the IPC stubs must fold to dead code, whatever the environment says.
  define: mode === 'mock' ? {} : { 'import.meta.env.VITE_MOCK': JSON.stringify('') },
  // Every worker is a module worker; the transcription one loads transformers.js as a chunk.
  worker: { format: 'es' },
  server: {
    // Must match devUrl in tauri.conf.json, and must fail rather than drift.
    port: 1420,
    strictPort: true,
  },
  build: {
    // WebView2 is evergreen Chromium. 123 is the floor the design tokens set
    // (light-dark()); anything older cannot render the app anyway.
    target: 'chrome123',
    // The bundle loads from disk inside the app, so one large chunk costs nothing to fetch.
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      // The recording bar and the camera overlay are their own windows with their own pages.
      input: { main: 'index.html', hud: 'hud.html', camera: 'camera.html' },
    },
  },
}))
