// Sarvam Starter (pay-as-you-go) prices in rupees.
const STT_PER_HOUR = 30
const STT_DIARIZED_PER_HOUR = 45
const TRANSLATE_PER_10K_CHARS = 20
const TTS_PER_10K_CHARS = 30
const DUB_PER_MINUTE = 40

/** Rough density of transcribed speech, used when the transcript is not known yet. */
export const CHARS_PER_MINUTE = 1000

export type CostKind = 'transcribe' | 'translate' | 'dub-sarvam' | 'dub-tts'

export function estimateRupees(
  kind: CostKind,
  durationSec: number,
  languages: number,
  options: { diarize?: boolean; chars?: number } = {},
): number {
  const seconds = Math.max(0, durationSec)
  const targets = Math.max(1, Math.floor(languages))
  const chars = options.chars ?? (seconds / 60) * CHARS_PER_MINUTE

  switch (kind) {
    case 'transcribe': {
      // Billed per second with a one-second minimum.
      const billed = Math.max(1, Math.ceil(seconds))
      return (billed / 3600) * (options.diarize ? STT_DIARIZED_PER_HOUR : STT_PER_HOUR)
    }
    case 'translate':
      return (chars / 10_000) * TRANSLATE_PER_10K_CHARS * targets
    case 'dub-sarvam':
      return (Math.ceil(seconds) / 60) * DUB_PER_MINUTE * targets
    case 'dub-tts':
      return (chars / 10_000) * (TRANSLATE_PER_10K_CHARS + TTS_PER_10K_CHARS) * targets
  }
}

export function formatRupees(amount: number): string {
  if (!(amount >= 1)) return 'under ₹1'
  // Rounded up: an estimate of money should not undersell the bill.
  return `about ₹${Math.ceil(amount).toLocaleString('en-IN')}`
}

export function estimateCost(
  kind: CostKind,
  durationSec: number,
  languages: number,
  options?: { diarize?: boolean; chars?: number },
): string {
  return formatRupees(estimateRupees(kind, durationSec, languages, options))
}
