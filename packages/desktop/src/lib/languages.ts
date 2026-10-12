// Canonical codes are the ones Sarvam's text and speech APIs use (`od-IN` for Odia).

export interface Language {
  code: string
  name: string
  native: string
  /** Speech to text (Saaras). */
  stt: boolean
  /** Text translation with sarvam-translate:v1. */
  translate: boolean
  /** Text translation with mayura:v1. */
  mayura: boolean
  /** Text to speech with bulbul:v3. */
  tts: boolean
  /** Sarvam Dubbing, as source or target. */
  dub: boolean
  /** On-device transcription with Whisper. */
  whisper: boolean
}

const MAJOR = new Set([
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
])

const DUB = new Set([...MAJOR, 'as-IN'])

/** The app languages Whisper was trained on. */
const WHISPER = new Set([
  'as-IN',
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'ne-IN',
  'pa-IN',
  'sa-IN',
  'sd-IN',
  'ta-IN',
  'te-IN',
  'ur-IN',
])

/** [code, English name, native name, ISO 639-2/T for container track metadata] */
const TABLE: ReadonlyArray<readonly [string, string, string, string]> = [
  ['as-IN', 'Assamese', 'অসমীয়া', 'asm'],
  ['bn-IN', 'Bengali', 'বাংলা', 'ben'],
  ['brx-IN', 'Bodo', 'बड़ो', 'brx'],
  ['doi-IN', 'Dogri', 'डोगरी', 'doi'],
  ['en-IN', 'English', 'English', 'eng'],
  ['gu-IN', 'Gujarati', 'ગુજરાતી', 'guj'],
  ['hi-IN', 'Hindi', 'हिन्दी', 'hin'],
  ['kn-IN', 'Kannada', 'ಕನ್ನಡ', 'kan'],
  ['ks-IN', 'Kashmiri', 'کٲشُر', 'kas'],
  ['kok-IN', 'Konkani', 'कोंकणी', 'kok'],
  ['mai-IN', 'Maithili', 'मैथिली', 'mai'],
  ['ml-IN', 'Malayalam', 'മലയാളം', 'mal'],
  ['mni-IN', 'Manipuri', 'মৈতৈলোন্', 'mni'],
  ['mr-IN', 'Marathi', 'मराठी', 'mar'],
  ['ne-IN', 'Nepali', 'नेपाली', 'nep'],
  ['od-IN', 'Odia', 'ଓଡ଼ିଆ', 'ori'],
  ['pa-IN', 'Punjabi', 'ਪੰਜਾਬੀ', 'pan'],
  ['sa-IN', 'Sanskrit', 'संस्कृतम्', 'san'],
  ['sat-IN', 'Santali', 'ᱥᱟᱱᱛᱟᱲᱤ', 'sat'],
  ['sd-IN', 'Sindhi', 'سنڌي', 'snd'],
  ['ta-IN', 'Tamil', 'தமிழ்', 'tam'],
  ['te-IN', 'Telugu', 'తెలుగు', 'tel'],
  ['ur-IN', 'Urdu', 'اردو', 'urd'],
]

export const LANGUAGES: Language[] = TABLE.map(([code, name, native]) => ({
  code,
  name,
  native,
  stt: true,
  translate: true,
  mayura: MAJOR.has(code),
  tts: MAJOR.has(code),
  dub: DUB.has(code),
  whisper: WHISPER.has(code),
}))

const BY_CODE = new Map(LANGUAGES.map((language) => [language.code.toLowerCase(), language]))
const ISO_639_2 = new Map(TABLE.map(([code, , , iso]) => [code, iso]))

/** Accepts canonical codes, the Dubbing API's `or-IN`, and bare tags such as `hi`. */
export function findLanguage(code: string | null | undefined): Language | undefined {
  if (!code) return undefined
  const lower = code.trim().toLowerCase()
  const aliased = lower === 'or-in' || lower === 'or' ? 'od-in' : lower
  return BY_CODE.get(aliased) ?? BY_CODE.get(`${aliased}-in`)
}

export function canonicalLanguage(code: string | null | undefined): string | null {
  return findLanguage(code)?.code ?? null
}

export function languageName(code: string | null): string {
  if (code === 'unknown') return 'Auto-detect'
  if (!code) return 'Unknown language'
  return findLanguage(code)?.name ?? code
}

/** Whisper's code for an app language, e.g. 'hi' for 'hi-IN'; null when Whisper lacks it. */
export function whisperCode(code: string | null | undefined): string | null {
  const language = findLanguage(code)
  return language?.whisper ? language.code.split('-')[0]! : null
}

/** The app language for a code Whisper reported; null for languages outside the app's list. */
export function fromWhisperCode(code: string | null | undefined): string | null {
  const language = code && /^[a-z]{2,3}$/.test(code) ? findLanguage(code) : undefined
  return language?.whisper ? language.code : null
}

export function iso639(code: string): string | undefined {
  const canonical = canonicalLanguage(code)
  return canonical ? ISO_639_2.get(canonical) : undefined
}

export const TTS_SPEAKERS: { id: string; name: string; gender: 'male' | 'female' }[] = [
  ...[
    'shubh',
    'aditya',
    'rahul',
    'rohan',
    'amit',
    'dev',
    'ratan',
    'varun',
    'manan',
    'sumit',
    'kabir',
    'aayan',
    'ashutosh',
    'advait',
    'anand',
    'tarun',
    'sunny',
    'mani',
    'gokul',
    'vijay',
    'mohit',
    'rehan',
    'soham',
  ].map((id) => speaker(id, 'male')),
  ...[
    'ritu',
    'priya',
    'neha',
    'pooja',
    'simran',
    'kavya',
    'ishita',
    'shreya',
    'roopa',
    'tanya',
    'shruti',
    'suhani',
    'kavitha',
    'rupali',
  ].map((id) => speaker(id, 'female')),
]

export const DEFAULT_TTS_SPEAKER = 'shubh'

function speaker(id: string, gender: 'male' | 'female') {
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1), gender }
}
