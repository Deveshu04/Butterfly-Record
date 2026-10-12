import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  DEFAULT_WHISPER_MODEL,
  PROFILES,
  WHISPER_MODELS,
  cachedModels,
  cachedRepo,
  downloadBytes,
  gpuName,
  modelFileUrl,
  profileFiles,
  transcriptionEngine,
  whisperBackend,
  whisperModel,
  whisperModelLabel,
} from '../src/lib/whisper-models.ts'

const MB = 1024 * 1024
const gpu = { vendor: 'intel', architecture: 'gen-12lp', description: '' }

describe('WHISPER_MODELS', () => {
  it('offers Base, Small and Large-v3 Turbo from onnx-community', () => {
    assert.deepEqual(
      WHISPER_MODELS.map((model) => [model.id, model.repo]),
      [
        ['base', 'onnx-community/whisper-base'],
        ['small', 'onnx-community/whisper-small'],
        ['large-v3-turbo', 'onnx-community/whisper-large-v3-turbo'],
      ],
    )
    assert.equal(whisperModel(DEFAULT_WHISPER_MODEL).id, 'small')
  })

  it('knows the size of every file each profile downloads', () => {
    for (const model of WHISPER_MODELS) {
      for (const profile of Object.values(PROFILES)) {
        for (const file of profileFiles(profile)) {
          assert.ok((model.files[file] ?? 0) > 0, `${model.repo} ${file}`)
        }
      }
    }
  })

  it('adds up to what the download actually fetched', () => {
    // Totals transformers.js reported while downloading these profiles.
    assert.equal(downloadBytes(whisperModel('base'), 'cpu'), 149_573_295)
    assert.equal(downloadBytes(whisperModel('small'), 'gpu'), 302_101_039)
    assert.equal(downloadBytes(whisperModel('large-v3-turbo'), 'gpu'), 761_859_026)
    const mb = (id: 'base' | 'small' | 'large-v3-turbo', backend: 'gpu' | 'cpu') =>
      Math.round(downloadBytes(whisperModel(id), backend) / MB)
    assert.deepEqual(
      [mb('base', 'gpu'), mb('small', 'cpu'), mb('large-v3-turbo', 'cpu')],
      [138, 313, 936],
    )
  })

  it('leaves translation out of Turbo and asks for a GPU there', () => {
    const turbo = whisperModel('large-v3-turbo')
    assert.equal(turbo.translates, false)
    assert.equal(turbo.needsGpu, true)
    assert.ok(WHISPER_MODELS.filter((model) => model !== turbo).every((model) => model.translates))
  })

  it('runs 4-bit on a GPU and the 8-bit encoder on the CPU', () => {
    assert.deepEqual(profileFiles(PROFILES.gpu).slice(-2), [
      'onnx/encoder_model_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx',
    ])
    assert.deepEqual(profileFiles(PROFILES.cpu).slice(-2), [
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_q4.onnx',
    ])
    assert.equal(PROFILES.gpu.device, 'webgpu')
    assert.equal(PROFILES.cpu.device, 'wasm')
  })
})

describe('whisperBackend', () => {
  it('uses the GPU only when allowed and found', () => {
    assert.equal(whisperBackend('auto', gpu), 'gpu')
    assert.equal(whisperBackend('auto', null), 'cpu')
    assert.equal(whisperBackend('cpu', gpu), 'cpu')
  })
})

describe('cached models', () => {
  it('maps cache keys back to their repository', () => {
    const url = modelFileUrl('onnx-community/whisper-small', 'onnx/encoder_model_q4.onnx')
    assert.equal(url, 'https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/encoder_model_q4.onnx')
    assert.equal(cachedRepo(url), 'onnx-community/whisper-small')
    assert.equal(cachedRepo('https://example.com/onnx-community/whisper-small/resolve/main/x'), null)
    assert.equal(cachedRepo('https://huggingface.co/api/models/x'), null)
  })

  it('sums each repository and lists them in catalogue order', () => {
    const file = (repo: string, name: string, bytes: number) => ({ url: modelFileUrl(repo, name), bytes })
    const listed = cachedModels([
      file('onnx-community/whisper-large-v3-turbo', 'config.json', 10),
      file('someone/other-model', 'config.json', 5),
      file('onnx-community/whisper-base', 'config.json', 1),
      file('onnx-community/whisper-base', 'onnx/encoder_model_q4.onnx', 100),
      { url: 'https://example.com/elsewhere', bytes: 999 },
    ])
    assert.deepEqual(
      listed.map((entry) => [entry.repo, entry.model?.id ?? null, entry.bytes]),
      [
        ['onnx-community/whisper-base', 'base', 101],
        ['onnx-community/whisper-large-v3-turbo', 'large-v3-turbo', 10],
        ['someone/other-model', null, 5],
      ],
    )
  })
})

describe('transcriptionEngine', () => {
  it('runs on this device whenever no Sarvam key is saved', () => {
    assert.equal(transcriptionEngine(null, false), 'local')
    assert.equal(transcriptionEngine(null, null), 'local')
    assert.equal(transcriptionEngine('sarvam', false), 'local')
  })

  it('follows the choice once a key is saved, and Sarvam until a choice is made', () => {
    assert.equal(transcriptionEngine(null, true), 'sarvam')
    assert.equal(transcriptionEngine('local', true), 'local')
    assert.equal(transcriptionEngine('sarvam', true), 'sarvam')
  })
})

describe('labels', () => {
  it('stores the model id, marked like Sarvam translations', () => {
    const small = whisperModel('small')
    assert.equal(whisperModelLabel(small, 'transcribe'), 'onnx-community/whisper-small')
    assert.equal(whisperModelLabel(small, 'translate'), 'onnx-community/whisper-small (translate)')
  })

  it('names the GPU with whatever the browser reveals', () => {
    assert.equal(gpuName(gpu), 'Intel (gen-12lp)')
    assert.equal(gpuName({ ...gpu, description: 'Intel(R) Iris(R) Xe Graphics' }), 'Intel(R) Iris(R) Xe Graphics')
    assert.equal(gpuName({ vendor: 'nvidia', architecture: '', description: '' }), 'NVIDIA')
    assert.equal(gpuName({ vendor: '', architecture: '', description: '' }), 'A graphics adapter')
  })
})

describe('ONNX Runtime', () => {
  it('serves the WebAssembly binary of the version transformers.js runs', () => {
    const read = (path: string) =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
        dependencies: Record<string, string>
      }
    const desktop = read('../package.json')
    const transformers = read('../../core/node_modules/@huggingface/transformers/package.json')
    assert.equal(desktop.dependencies['onnxruntime-web'], transformers.dependencies['onnxruntime-web'])
  })
})
