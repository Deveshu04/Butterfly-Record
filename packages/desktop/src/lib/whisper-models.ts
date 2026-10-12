// The Whisper models offered for on-device transcription, the precision each runs at on a
// GPU and on the CPU, and what each of those downloads. Sizes are the files' byte counts on
// Hugging Face.

import type { WhisperDtype } from '@butterfly-record/core/transcribe'

export type WhisperModelId = 'base' | 'small' | 'large-v3-turbo'
export type TranscriptionEngine = 'local' | 'sarvam'
export type ProcessorChoice = 'auto' | 'cpu'
export type WhisperBackend = 'gpu' | 'cpu'

export interface WhisperProfile {
  device: 'webgpu' | 'wasm'
  dtype: { encoder_model: WhisperDtype; decoder_model_merged: WhisperDtype }
}

export interface WhisperModel {
  id: WhisperModelId
  repo: string
  name: string
  /** Whisper can write English from other languages; Turbo was not trained to. */
  translates: boolean
  /** Too slow to be useful without a GPU. */
  needsGpu: boolean
  /** Bytes of every file a profile can fetch. */
  files: Record<string, number>
}

export interface GpuInfo {
  vendor: string
  architecture: string
  description: string
}

/** Cache Storage that holds the downloaded model files, one entry per file URL. */
export const MODEL_CACHE = 'speech-models'

const HUB = 'https://huggingface.co/'

const SUFFIX: Record<WhisperDtype, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  q4: '_q4',
  q4f16: '_q4f16',
}

/** Fetched alongside the two ONNX graphs whatever the precision. */
const SHARED_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
] as const

// WebGPU has no 8-bit kernels, and 16-bit or full-precision encoders were either wrong or
// many times slower on integrated graphics, so a GPU runs both graphs in 4-bit. In
// WebAssembly the 8-bit encoder is fastest; ONNX Runtime cannot load the 8-bit decoder.
export const PROFILES: Record<WhisperBackend, WhisperProfile> = {
  gpu: { device: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
  cpu: { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' } },
}

export const WHISPER_MODELS: readonly WhisperModel[] = [
  {
    id: 'base',
    repo: 'onnx-community/whisper-base',
    name: 'Base',
    translates: true,
    needsGpu: false,
    files: {
      'config.json': 2243,
      'generation_config.json': 3832,
      'preprocessor_config.json': 339,
      'tokenizer.json': 2480466,
      'tokenizer_config.json': 282682,
      'onnx/encoder_model_q4.onnx': 18772451,
      'onnx/encoder_model_quantized.onnx': 23201314,
      'onnx/decoder_model_merged_q4.onnx': 123602419,
    },
  },
  {
    id: 'small',
    repo: 'onnx-community/whisper-small',
    name: 'Small',
    translates: true,
    needsGpu: false,
    files: {
      'config.json': 2227,
      'generation_config.json': 3893,
      'preprocessor_config.json': 339,
      'tokenizer.json': 2480466,
      'tokenizer_config.json': 282683,
      'onnx/encoder_model_q4.onnx': 66182104,
      'onnx/encoder_model_quantized.onnx': 92326160,
      'onnx/decoder_model_merged_q4.onnx': 233149327,
    },
  },
  {
    id: 'large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    name: 'Large-v3 Turbo',
    translates: false,
    needsGpu: true,
    files: {
      'config.json': 1332,
      'generation_config.json': 3897,
      'preprocessor_config.json': 340,
      'tokenizer.json': 2480617,
      'tokenizer_config.json': 282843,
      'onnx/encoder_model_q4.onnx': 424942775,
      'onnx/encoder_model_quantized.onnx': 644822195,
      'onnx/decoder_model_merged_q4.onnx': 334147222,
    },
  },
]

export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'small'

export function whisperModel(id: WhisperModelId): WhisperModel {
  return WHISPER_MODELS.find((model) => model.id === id) ?? WHISPER_MODELS[0]!
}

/** A GPU is used only when the choice allows it and WebGPU found a hardware adapter. */
export function whisperBackend(choice: ProcessorChoice, gpu: GpuInfo | null): WhisperBackend {
  return choice === 'auto' && gpu ? 'gpu' : 'cpu'
}

export function profileFiles(profile: WhisperProfile): string[] {
  return [
    ...SHARED_FILES,
    `onnx/encoder_model${SUFFIX[profile.dtype.encoder_model]}.onnx`,
    `onnx/decoder_model_merged${SUFFIX[profile.dtype.decoder_model_merged]}.onnx`,
  ]
}

export function downloadBytes(model: WhisperModel, backend: WhisperBackend): number {
  return profileFiles(PROFILES[backend]).reduce((sum, file) => sum + (model.files[file] ?? 0), 0)
}

/** The URL transformers.js downloads a file from, which is also its key in the cache. */
export function modelFileUrl(repo: string, file: string): string {
  return `${HUB}${repo}/resolve/main/${file}`
}

/** The model repository a cached file belongs to, or null for anything else in the cache. */
export function cachedRepo(url: string): string | null {
  if (!url.startsWith(HUB)) return null
  const match = /^([^/]+\/[^/]+)\/resolve\//.exec(url.slice(HUB.length))
  return match ? decodeURIComponent(match[1]!) : null
}

export interface CachedModel {
  repo: string
  /** null for a repository this version does not offer. */
  model: WhisperModel | null
  bytes: number
}

/** Per repository, how many bytes of model files are cached, in catalogue order. */
export function cachedModels(files: ReadonlyArray<{ url: string; bytes: number }>): CachedModel[] {
  const totals = new Map<string, number>()
  for (const file of files) {
    const repo = cachedRepo(file.url)
    if (repo) totals.set(repo, (totals.get(repo) ?? 0) + file.bytes)
  }
  const rank = (model: WhisperModel | null) =>
    model ? WHISPER_MODELS.indexOf(model) : WHISPER_MODELS.length
  return [...totals]
    .map(([repo, bytes]) => ({
      repo,
      model: WHISPER_MODELS.find((model) => model.repo === repo) ?? null,
      bytes,
    }))
    .sort((a, b) => rank(a.model) - rank(b.model) || a.repo.localeCompare(b.repo))
}

/** Without a saved key there is nothing to choose; until a choice is made a key means Sarvam. */
export function transcriptionEngine(
  chosen: TranscriptionEngine | null,
  hasKey: boolean | null,
): TranscriptionEngine {
  if (!hasKey) return 'local'
  return chosen ?? 'sarvam'
}

/** The transcript's `model` field, marked the way Sarvam translations are. */
export function whisperModelLabel(model: WhisperModel, task: 'transcribe' | 'translate'): string {
  return task === 'translate' ? `${model.repo} (translate)` : model.repo
}

const VENDORS: Record<string, string> = {
  amd: 'AMD',
  apple: 'Apple',
  arm: 'Arm',
  intel: 'Intel',
  microsoft: 'Microsoft',
  nvidia: 'NVIDIA',
  qualcomm: 'Qualcomm',
}

/** "NVIDIA GeForce RTX 4060", or "Intel (gen-12lp)" when the browser withholds the name. */
export function gpuName(gpu: GpuInfo): string {
  if (gpu.description.trim()) return gpu.description.trim()
  const vendor = VENDORS[gpu.vendor.toLowerCase()] ?? gpu.vendor
  if (!vendor) return 'A graphics adapter'
  return gpu.architecture ? `${vendor} (${gpu.architecture})` : vendor
}
