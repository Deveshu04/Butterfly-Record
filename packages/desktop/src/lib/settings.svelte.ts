import { DEFAULT_SETTINGS, normalizeSettings, type AppSettings } from './app-settings.ts'
import { settingsGet, settingsSet } from './ipc.ts'

export { DEFAULT_SETTINGS, type AppSettings }

let value = $state<AppSettings>(structuredClone(DEFAULT_SETTINGS))
let loaded = $state(false)
let loading: Promise<void> | null = null
/** Keys this version does not know are written back untouched. */
let stored: Record<string, unknown> = {}

export const settings = {
  get value(): AppSettings {
    return value
  },

  get loaded(): boolean {
    return loaded
  },

  load(): Promise<void> {
    loading ??= settingsGet()
      .then((raw) => {
        stored = raw
        value = normalizeSettings(raw)
      })
      .catch((error: unknown) => {
        // Defaults are a working configuration; a broken settings file must not block startup.
        console.warn('[butterfly-record] settings could not be read; using defaults', error)
      })
      .finally(() => {
        loaded = true
      })
    return loading
  },

  async update(patch: (draft: AppSettings) => void): Promise<void> {
    const draft = $state.snapshot(value) as AppSettings
    patch(draft)
    value = normalizeSettings(draft)
    stored = { ...stored, ...$state.snapshot(value) }
    await settingsSet(stored)
  },
}
