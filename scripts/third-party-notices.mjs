// Vite plugin: writes THIRD_PARTY_NOTICES.txt into the build output, covering the npm packages the
// bundle actually contains and, when `cargoManifest` is given, the crates linked into the binary.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LICENSES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'licenses')
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i
const WIDTH = 80

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd()
}

function licenseFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort()
}

function spdxIds(expression) {
  return (expression ?? '').split(/[\s()/]+/).filter((id) => id && !['OR', 'AND', 'WITH'].includes(id))
}

const isApache = (text) => /Apache License\s+Version 2\.0, January 2004/.test(text)
const isMit = (text) => text.includes('Permission is hereby granted, free of charge')

/** Packages offered under MIT or Apache-2.0 are used under MIT, so the Apache copy is left out. */
function electMit(component) {
  const expression = component.license ?? ''
  if (!/\bMIT\b/.test(expression) || !/\bOR\b|\//.test(expression) || /\bAND\b/.test(expression)) return component
  const kept = component.texts.filter(({ text }) => !isApache(text))
  if (kept.length < component.texts.length && kept.some(({ text }) => isMit(text))) {
    component.texts = kept
    component.license = `${expression}, used under MIT`
  }
  return component
}

/** Standard texts for packages that ship no licence file; an unknown licence fails the build. */
function standardTexts(component) {
  const ids = spdxIds(component.license)
  const missing = ids.filter((id) => !fs.existsSync(path.join(LICENSES, `${id}.txt`)))
  if (ids.length === 0 || missing.length > 0) {
    throw new Error(
      `${component.name} ${component.version} ships no licence file and is declared ` +
        `"${component.license ?? 'unlicensed'}"; add the standard text as scripts/licenses/<SPDX id>.txt`,
    )
  }
  return ids.map((id) => ({ text: readText(path.join(LICENSES, `${id}.txt`)), standard: id }))
}

function npmComponent(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const license =
    typeof pkg.license === 'string'
      ? pkg.license
      : (pkg.license?.type ?? pkg.licenses?.map((entry) => entry.type ?? entry).join(' OR '))
  const component = {
    name: pkg.name,
    version: pkg.version,
    license,
    source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
  }
  const files = licenseFiles(dir)
  component.texts = files.length > 0 ? files.map((file) => ({ text: readText(file) })) : standardTexts(component)
  return electMit(component)
}

/** Package directory of a bundled module, or null for first-party code. */
function packageDir(id, viteDir) {
  if (id.startsWith('\0vite/')) return viteDir
  if (id.startsWith('\0')) return null
  const file = id.split('?')[0].split(path.sep).join('/')
  const at = file.lastIndexOf('/node_modules/')
  if (at === -1) return null
  const rest = file.slice(at + '/node_modules/'.length).split('/')
  const segments = rest[0]?.startsWith('@') ? 2 : 1
  return path.normalize(file.slice(0, at + '/node_modules/'.length) + rest.slice(0, segments).join('/'))
}

function hostTriple() {
  const info = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  const host = info.match(/^host: (\S+)/m)?.[1]
  if (!host) throw new Error('could not read the host target from `rustc -vV`')
  return host
}

const normalizeRepo = (url) => url?.toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '') ?? null

/** Crates compiled into the binary: normal dependencies, without build scripts' and proc macros' trees. */
function rustComponents(manifest, target) {
  const meta = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--filter-platform', target, '--manifest-path', manifest],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    ),
  )
  const packages = new Map(meta.packages.map((pkg) => [pkg.id, pkg]))
  const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]))
  const linked = new Set()
  const pending = [meta.resolve.root]
  while (pending.length > 0) {
    const id = pending.pop()
    if (linked.has(id)) continue
    linked.add(id)
    for (const dep of nodes.get(id).deps) {
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue
      if (packages.get(dep.pkg).targets.some((t) => t.kind.includes('proc-macro'))) continue
      pending.push(dep.pkg)
    }
  }
  const crates = [...linked].map((id) => packages.get(id)).filter((pkg) => pkg.source !== null)
  const filesOf = (pkg) => {
    const dir = path.dirname(pkg.manifest_path)
    const files = licenseFiles(dir)
    if (pkg.license_file) files.push(path.resolve(dir, pkg.license_file))
    return [...new Set(files)]
  }
  return crates.map((pkg) => {
    const component = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? 'see licence text',
      source: /crates\.io-index|index\.crates\.io/.test(pkg.source)
        ? `https://crates.io/crates/${pkg.name}/${pkg.version}`
        : (pkg.repository ?? pkg.source),
    }
    let files = filesOf(pkg)
    if (files.length === 0) {
      // Crates published from one repository often ship the licence file in only one of them.
      const sibling = crates.find(
        (other) =>
          pkg.repository &&
          other !== pkg &&
          other.license === pkg.license &&
          normalizeRepo(other.repository) === normalizeRepo(pkg.repository) &&
          filesOf(other).length > 0,
      )
      if (sibling) files = filesOf(sibling)
    }
    component.texts = files.length > 0 ? files.map((file) => ({ text: readText(file) })) : standardTexts(component)
    return electMit(component)
  })
}

function wrap(words) {
  const lines = []
  let line = ''
  for (const word of words) {
    if (line && line.length + 1 + word.length > WIDTH) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

function render(product, components, notes) {
  const label = (c) => `${c.name} ${c.version}`
  const unique = new Map(components.map((c) => [label(c), c]))
  components = [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  )
  const groups = new Map()
  for (const component of components) {
    for (const { text, standard } of component.texts) {
      const key = standard ? `standard:${standard}` : text.replace(/\s+/g, ' ')
      const group = groups.get(key) ?? { text, standard, members: [] }
      if (!group.members.includes(component)) group.members.push(component)
      groups.set(key, group)
    }
  }
  const out = [
    'Third-party notices',
    '',
    wrap(
      (
        `${product} includes the open-source components listed below, each used under the licence named for it. ` +
        'Their licence texts follow the list. The source code of every component, including those under the ' +
        'Mozilla Public License 2.0, is available at the address listed for it.'
      ).split(' '),
    ),
    ...notes.flatMap((note) => ['', wrap(note.split(' '))]),
    '',
    '',
    'Components',
    '',
    ...components.map((c) => `${label(c)}  (${c.license})\n  ${c.source}`),
    '',
    '',
    'Licence texts',
  ]
  for (const group of [...groups.values()]) {
    const members = group.members.map((c, i) => label(c) + (i < group.members.length - 1 ? ',' : ''))
    out.push(
      '',
      '='.repeat(WIDTH),
      group.standard
        ? wrap(`Standard ${group.standard} text, for components that ship no licence file:`.split(' ').concat(members))
        : wrap(['Applies to:', ...members]),
      '-'.repeat(WIDTH),
      '',
      group.text,
    )
  }
  return `${out.join('\n')}\n`
}

export default function thirdPartyNotices({
  product,
  cargoManifest,
  target,
  notes = [],
  fileName = 'THIRD_PARTY_NOTICES.txt',
}) {
  const moduleIds = new Set()
  const collect = {
    name: 'third-party-notices:collect',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, info] of Object.entries(output.modules)) if (info.renderedLength > 0) moduleIds.add(id)
      }
    },
  }
  let root = process.cwd()
  let viteDir = null
  return {
    name: 'third-party-notices',
    apply: 'build',
    // Workers are bundled separately; their modules count too.
    config: () => ({ worker: { plugins: () => [collect] } }),
    configResolved(config) {
      root = config.root
      viteDir = packageDir(createRequire(path.join(root, 'package.json')).resolve('vite'), null)
    },
    generateBundle(options, bundle) {
      collect.generateBundle(options, bundle)
      const dirs = new Set([...moduleIds].map((id) => packageDir(id, viteDir)).filter(Boolean))
      const components = [...dirs].map(npmComponent)
      if (cargoManifest) {
        const triple = target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple()
        const crates = rustComponents(path.resolve(root, cargoManifest), triple)
        components.push(...crates)
        const loader = crates.find((c) => c.name === 'webview2-com-sys')
        if (loader) {
          components.push({
            name: 'Microsoft Edge WebView2 SDK loader',
            version: `(via webview2-com-sys ${loader.version})`,
            license: 'BSD-3-Clause',
            source: 'https://www.nuget.org/packages/Microsoft.Web.WebView2',
            texts: [{ text: readText(path.join(LICENSES, 'WebView2-SDK.txt')) }],
          })
        }
      }
      this.emitFile({ type: 'asset', fileName, source: render(product, components, notes) })
    },
  }
}
