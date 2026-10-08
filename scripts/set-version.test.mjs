import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { isSemver, setVersion } from './set-version.mjs'

const FILES = {
  'package.json': '{\n  "name": "root",\n  "version": "0.1.0",\n  "private": true\n}\n',
  'packages/core/package.json': '{\n  "name": "@x/core",\n  "version": "0.1.0"\n}\n',
  'packages/ui/package.json': '{\n  "name": "@x/ui",\n  "version": "0.1.0"\n}\n',
  'packages/extension/package.json': '{\n  "name": "@x/extension",\n  "version": "0.1.0"\n}\n',
  'packages/desktop/package.json': '{\n  "name": "@x/desktop",\n  "version": "0.1.0"\n}\n',
  'packages/share-server/package.json':
    '{\n  "name": "@x/share",\n  "version": "0.1.0",\n  "bin": { "share": "./src/index.ts" }\n}\n',
  'packages/desktop/src-tauri/Cargo.toml':
    '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n',
  'packages/desktop/src-tauri/Cargo.lock':
    '[[package]]\nname = "anyhow"\nversion = "0.1.0"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n',
  'packages/core/src/index.ts': "// engine\r\n\r\nexport const VERSION = '0.1.0'\r\n",
}

let root
const read = (file) => readFileSync(join(root, file), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'set-version-'))
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('validates semver', () => {
  for (const ok of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3+build.5']) assert.ok(isSemver(ok), ok)
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-', '']) assert.ok(!isSemver(bad), bad)
  assert.throws(() => setVersion(root, 'v1.2.3'), /not a semantic version/)
})

test('changes only the version strings', () => {
  setVersion(root, '1.4.0-rc.1')
  for (const [file, text] of Object.entries(FILES)) {
    const expected =
      file.endsWith('Cargo.lock')
        ? text.replace('"app"\nversion = "0.1.0"', '"app"\nversion = "1.4.0-rc.1"')
        : file.endsWith('Cargo.toml')
          ? text.replace('version = "0.1.0"', 'version = "1.4.0-rc.1"')
          : text.replace('0.1.0', '1.4.0-rc.1')
    assert.equal(read(file), expected, file)
  }
})

test('the current version is a no-op and check mode never writes', () => {
  assert.ok(setVersion(root, '0.1.0').every((r) => r.from === r.to))
  const results = setVersion(root, '2.0.0', { check: true })
  assert.equal(results.filter((r) => r.from !== r.to).length, Object.keys(FILES).length)
  for (const [file, text] of Object.entries(FILES)) assert.equal(read(file), text, file)
})

test('a missing core constant is skipped', () => {
  writeFileSync(join(root, 'packages/core/src/index.ts'), 'export {}\n')
  const core = setVersion(root, '1.0.0').find((r) => r.file.endsWith('index.ts'))
  assert.equal(core.skipped, true)
})
