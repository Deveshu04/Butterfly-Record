// Lists every npm package bundled into the extension, with its licence text and where its
// source is published, so the store zip carries the notices its licences require.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BuildOutput, Wxt } from 'wxt'

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'

/**
 * Copyright holders for MIT packages that ship no licence file and whose package.json names
 * no author, or only the publisher.
 */
const COPYRIGHT: Record<string, string> = {
  '@webext-core/isolated-element': 'Aaron Klinker',
  '@webext-core/match-patterns': 'Aaron Klinker',
  'onnxruntime-common': 'Microsoft Corporation',
  'onnxruntime-web': 'Microsoft Corporation',
}

const NOTES: Record<string, string> = {
  'onnxruntime-web':
    "Also covers the ONNX Runtime WebAssembly binary (assets/ort-wasm-*.wasm). ONNX Runtime's own " +
    'third-party notices: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt',
}

const MIT_TEXT = `MIT License

{copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

interface PackageJson {
  name: string
  version: string
  license?: string
  author?: string | { name?: string }
  homepage?: string
  repository?: string | { url?: string }
}

interface Notice {
  name: string
  version: string
  license: string
  source: string
  text: string
  /** The package whose own build inlined this one. */
  inside: string | null
}

interface Found {
  root: string
  /** From the inlining build's path comment; null to use the installed version. */
  version: string | null
  inside: string | null
}

const NODE_MODULES = '/node_modules/'

/** The package directory a bundled module came from, or null for project code. */
function packageRoot(moduleId: string): string | null {
  const path = modulePath(moduleId).replaceAll('\\', '/')
  const at = path.lastIndexOf(NODE_MODULES)
  if (at < 0) return null
  const rest = path.slice(at + NODE_MODULES.length).split('/')
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  if (rest.length <= depth) return null
  return path.slice(0, at + NODE_MODULES.length) + rest.slice(0, depth).join('/')
}

function modulePath(moduleId: string): string {
  return moduleId.replace(/^\0/, '').split('?')[0]!
}

function nameOf(root: string): string {
  return root.slice(root.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)
}

/** Packages a dependency's prebuilt dist inlined, named by the path comments its bundler kept. */
function inlinedPackages(moduleId: string, root: string): Found[] {
  let source: string
  try {
    source = readFileSync(modulePath(moduleId), 'utf8')
  } catch {
    return []
  }
  const parent = nameOf(root)
  const found: Found[] = []
  for (const [, path] of source.matchAll(/^\/\/ (\S*\/node_modules\/\S+)$/gm)) {
    const inner = packageRoot(path!)
    if (!inner || nameOf(inner) === parent) continue
    found.push({
      // pnpm links a package's dependencies next to it.
      root: root.slice(0, root.lastIndexOf(NODE_MODULES) + NODE_MODULES.length) + nameOf(inner),
      version: /\.pnpm\/[^/]+@([^@/_]+)[^/]*\/node_modules\//.exec(path!)?.[1] ?? null,
      inside: parent,
    })
  }
  return found
}

function sourceUrl(pkg: PackageJson): string {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!raw) return pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url
}

/** Null when the package ships no licence file and its text cannot be rebuilt. */
function licenseText(root: string, pkg: PackageJson): string | null {
  const files = readdirSync(root)
    .filter((file) => /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i.test(file))
    .sort()
  if (files.length > 0) {
    return files.map((file) => readFileSync(join(root, file), 'utf8').trim()).join('\n\n')
  }
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const holder = COPYRIGHT[pkg.name] ?? author?.replace(/\s*<.*>$/, '')
  if (pkg.license === 'MIT' && holder) {
    return MIT_TEXT.replace('{copyright}', `Copyright (c) ${holder}`)
  }
  return null
}

function collect(output: Readonly<BuildOutput>): Notice[] {
  const found = new Map<string, Found>()
  for (const step of output.steps) {
    for (const file of step.chunks) {
      if (file.type !== 'chunk') continue
      for (const id of file.moduleIds) {
        const root = packageRoot(id)
        if (!root) continue
        if (!found.has(root)) found.set(root, { root, version: null, inside: null })
        for (const inlined of inlinedPackages(id, root)) {
          if (!found.has(inlined.root)) found.set(inlined.root, inlined)
        }
      }
    }
  }

  const notices = new Map<string, Notice>()
  const missing: string[] = []
  for (const { root, version, inside } of found.values()) {
    if (!existsSync(join(root, 'package.json'))) {
      missing.push(`${nameOf(root)} (inlined in ${inside}, not installed)`)
      continue
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson
    const key = `${pkg.name}@${version ?? pkg.version}`
    if (notices.has(key)) continue
    const text = licenseText(root, pkg)
    if (text === null) missing.push(`${key} (${pkg.license ?? 'no licence field'})`)
    notices.set(key, {
      name: pkg.name,
      version: version ?? pkg.version,
      license: pkg.license ?? 'see licence text',
      source: sourceUrl(pkg),
      text: text ?? '',
      inside,
    })
  }
  if (missing.length > 0) {
    throw new Error(`No licence text for ${missing.join(', ')}; add it to third-party-notices.ts.`)
  }
  return [...notices.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function render(notices: Notice[]): string {
  const rule = '='.repeat(78)
  const header = [
    'Butterfly Record includes the third-party software listed below, unmodified, under the',
    "licences that follow. Each package's source code is available at the address given.",
  ].join('\n')
  const sections = notices.map((notice) =>
    [
      rule,
      `${notice.name} ${notice.version}`,
      `Licence: ${notice.license}`,
      `Source: ${notice.source} (npm: ${notice.name}@${notice.version})`,
      ...(notice.inside ? [`Included in the ${notice.inside} build.`] : []),
      ...(NOTES[notice.name] ? [NOTES[notice.name]!] : []),
      '',
      notice.text,
    ].join('\n'),
  )
  return `${header}\n\n${sections.join('\n\n')}\n`
}

/** A `build:done` hook; a dev server's output has no bundled chunks and is skipped. */
export function writeThirdPartyNotices(wxt: Wxt, output: Readonly<BuildOutput>): void {
  const notices = collect(output)
  if (notices.length === 0) return
  // The BOM makes Chrome read it as UTF-8, which it does not assume for a .txt file.
  writeFileSync(join(wxt.config.outDir, NOTICES_FILE), `\uFEFF${render(notices)}`, 'utf8')
  output.publicAssets.push({ type: 'asset', fileName: NOTICES_FILE })
}
