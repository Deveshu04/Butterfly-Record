// Usage:
//   node scripts/set-version.mjs <version>           write <version> to every versioned file
//   node scripts/set-version.mjs --check <version>   exit 1 unless every versioned file has <version>

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const PACKAGE_DIRS = [
  '.',
  'packages/core',
  'packages/ui',
  'packages/extension',
  'packages/desktop',
  'packages/share-server',
]
const CARGO_DIR = 'packages/desktop/src-tauri'
const CORE_INDEX = 'packages/core/src/index.ts'

export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value)
}

// Each locator returns where the version string sits in the file, so the edit
// leaves formatting and line endings untouched.
function packageJsonVersion(text) {
  const match = /("version"\s*:\s*")([^"]*)"/.exec(text)
  if (!match || JSON.parse(text).version !== match[2]) return null
  return { index: match.index + match[1].length, value: match[2] }
}

function tomlSection(text, header) {
  const start = new RegExp(`^\\[${header}\\][ \\t]*\\r?$`, 'm').exec(text)
  if (!start) return null
  const from = start.index + start[0].length
  const next = /^\[/m.exec(text.slice(from))
  return { from, body: text.slice(from, next ? from + next.index : text.length) }
}

function tomlKey(section, key) {
  const match = new RegExp(`^(${key}[ \\t]*=[ \\t]*")([^"]*)"`, 'm').exec(section.body)
  if (!match) return null
  return { index: section.from + match.index + match[1].length, value: match[2] }
}

function cargoTomlVersion(text) {
  const section = tomlSection(text, 'package')
  return section && tomlKey(section, 'version')
}

function cargoLockVersion(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^(name = "${escaped}"\\r?\\nversion = ")([^"]*)"`, 'm').exec(text)
  return match && { index: match.index + match[1].length, value: match[2] }
}

function coreVersionConstant(text) {
  const match = /^(export const VERSION = ')([^']*)'/m.exec(text)
  return match && { index: match.index + match[1].length, value: match[2] }
}

function targets(root) {
  const cargoToml = readFileSync(join(root, CARGO_DIR, 'Cargo.toml'), 'utf8')
  const crate = tomlKey(tomlSection(cargoToml, 'package') ?? { from: 0, body: '' }, 'name')?.value
  if (!crate) throw new Error(`${CARGO_DIR}/Cargo.toml: no [package] name`)

  return [
    ...PACKAGE_DIRS.map((dir) => ({ file: join(dir, 'package.json'), locate: packageJsonVersion })),
    { file: join(CARGO_DIR, 'Cargo.toml'), locate: cargoTomlVersion },
    { file: join(CARGO_DIR, 'Cargo.lock'), locate: (text) => cargoLockVersion(text, crate) },
    { file: CORE_INDEX, locate: coreVersionConstant, optional: true },
  ]
}

/**
 * Sets `version` in every versioned file under `root`, or with `check` only
 * compares. Returns one entry per file: { file, from, to, skipped? }.
 */
export function setVersion(root, version, { check = false } = {}) {
  if (!isSemver(version)) {
    throw new Error(`"${version}" is not a semantic version such as 1.2.3 or 1.2.3-rc.1`)
  }
  const results = []
  for (const { file, locate, optional } of targets(root)) {
    const path = join(root, file)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : null
    const found = text === null ? null : locate(text)
    if (!found) {
      if (optional) {
        results.push({ file, from: null, to: version, skipped: true })
        continue
      }
      throw new Error(`${file}: version field not found`)
    }
    results.push({ file, from: found.value, to: version })
    if (check || found.value === version) continue
    const updated = text.slice(0, found.index) + version + text.slice(found.index + found.value.length)
    writeFileSync(path, updated)
  }
  return results
}

function main(argv) {
  const check = argv[0] === '--check'
  const args = check ? argv.slice(1) : argv
  if (args.length !== 1) {
    console.error('Usage: node scripts/set-version.mjs [--check] <version>')
    return 2
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  let results
  try {
    results = setVersion(root, args[0], { check })
  } catch (error) {
    console.error(error.message)
    return 1
  }
  const mismatched = results.filter((r) => !r.skipped && r.from !== r.to)
  for (const r of results) {
    const file = r.file.replaceAll('\\', '/')
    if (r.skipped) console.log(`${file}: no version constant, skipped`)
    else if (r.from === r.to) console.log(`${file}: ${r.to}`)
    else console.log(`${file}: ${r.from} ${check ? '!=' : '->'} ${r.to}`)
  }
  if (check && mismatched.length > 0) {
    console.error(`${mismatched.length} file(s) do not have version ${args[0]}`)
    return 1
  }
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
