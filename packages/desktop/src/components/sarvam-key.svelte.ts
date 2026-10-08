import { sarvamKeyClear, sarvamKeySet, sarvamKeyStatus, sarvamKeyTest } from '../lib/ipc.ts'

export type KeyCheck = { ok: boolean; message: string } | null

class SarvamKey {
  /** null until the first status read finishes. */
  present = $state<boolean | null>(null)
  check = $state<KeyCheck>(null)

  async refresh() {
    try {
      this.present = (await sarvamKeyStatus()).present
    } catch {
      this.present = false
    }
  }

  async save(key: string) {
    await sarvamKeySet(key)
    this.present = true
    this.check = null
  }

  async clear() {
    await sarvamKeyClear()
    this.present = false
    this.check = null
  }

  async test(): Promise<KeyCheck> {
    this.check = await sarvamKeyTest()
    return this.check
  }
}

export const sarvamKey = new SarvamKey()
