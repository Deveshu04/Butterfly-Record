import { mount, unmount } from 'svelte'
import Overlay from './Overlay.svelte'

export default defineContentScript({
  matches: ['<all_urls>'],
  // Injected by the service worker via chrome.scripting when a recording starts.
  registration: 'runtime',
  // Required for createShadowRootUi to find and inject the component CSS.
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'butterfly-record-overlay',
      position: 'overlay',
      // Not <body>: some pages replace body during navigation.
      anchor: 'html',
      append: 'last',
      mode: 'closed',
      // Keystrokes in the overlay's inputs must not reach the host page.
      isolateEvents: ['keydown', 'keyup', 'keypress'],
      onMount: (container) => mount(Overlay, { target: container }),
      onRemove: (mounted) => {
        if (mounted) void unmount(mounted)
      },
    })

    ui.mount()
  },
})
