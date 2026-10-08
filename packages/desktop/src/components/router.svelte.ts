export type VideoTab = 'transcript' | 'translate' | 'dub' | 'details'

export type Route =
  | { name: 'library'; filter: 'all' | 'imported' }
  | { name: 'video'; id: string; tab: VideoTab }
  | { name: 'record' }
  | { name: 'settings'; section: string | null }

const VIDEO_TABS: VideoTab[] = ['transcript', 'translate', 'dub', 'details']

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [head, a, b] = parts
  if (head === 'video' && a) {
    const tab = VIDEO_TABS.find((t) => t === b) ?? 'transcript'
    return { name: 'video', id: a, tab }
  }
  if (head === 'record') return { name: 'record' }
  if (head === 'settings') return { name: 'settings', section: a ?? null }
  return { name: 'library', filter: a === 'imported' ? 'imported' : 'all' }
}

class Router {
  route = $state<Route>(parse(location.hash))

  constructor() {
    window.addEventListener('hashchange', () => {
      this.route = parse(location.hash)
    })
  }
}

export const router = new Router()

export const href = {
  library: (filter: 'all' | 'imported' = 'all') => (filter === 'imported' ? '#/library/imported' : '#/library'),
  video: (id: string, tab?: VideoTab) =>
    `#/video/${encodeURIComponent(id)}${tab && tab !== 'transcript' ? `/${tab}` : ''}`,
  record: () => '#/record',
  settings: (section?: string) => (section ? `#/settings/${section}` : '#/settings'),
}

export function navigate(target: string, options: { replace?: boolean } = {}) {
  if (location.hash === target) return
  if (options.replace) {
    history.replaceState(null, '', target)
    router.route = parse(target)
  } else {
    location.hash = target
  }
}
