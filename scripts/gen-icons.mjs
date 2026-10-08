// Rasterizes assets/icon*.svg into the extension icons, the desktop app icons and the installer images (`pnpm icons`).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// The full mark blurs below 48 px, so smaller sizes use icon-small.svg.
const source = join(root, 'assets', 'icon.svg')
const sourceSmall = join(root, 'assets', 'icon-small.svg')
const extensionDir = join(root, 'packages', 'extension', 'public', 'icons')
const desktopIconDir = join(root, 'packages', 'desktop', 'src-tauri', 'icons')
const installerDir = join(root, 'packages', 'desktop', 'src-tauri', 'installer')

// 16/32/48/128: manifest; 19/38: action icons; 256/512: store listing.
const extensionSizes = [16, 19, 32, 38, 48, 128, 256, 512]
const desktopPngs = {
  '32x32.png': 32,
  '64x64.png': 64,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
  'StoreLogo.png': 50,
}
// Tauri builds the window and tray icon from the first frame only, so 32 px leads.
// The rest serve the exe resource (Explorer, shortcuts, taskbar), where Windows picks by size.
const icoSizes = [32, 16, 20, 24, 40, 48, 64, 256]

const font = 'Segoe UI'
const textColor = '#1a1a1a'
const wordmark = 'Butterfly Record'

const written = []

async function save(path, data) {
  await writeFile(path, data)
  written.push(path)
}

const icons = new Map()

function renderIcon(size) {
  if (!icons.has(size)) {
    icons.set(
      size,
      sharp(size < 48 ? sourceSmall : source, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    )
  }
  return icons.get(size)
}

// PNG-compressed entries (Windows Vista and later); a 0 in the size bytes means 256.
function encodeIco(frames) {
  const directory = Buffer.alloc(6 + 16 * frames.length)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(frames.length, 4)
  let offset = directory.length
  frames.forEach(({ size, png }, i) => {
    if (size < 1 || size > 256) throw new Error(`ICO frames must be 1-256 px, got ${size}`)
    const entry = 6 + 16 * i
    directory.writeUInt8(size % 256, entry)
    directory.writeUInt8(size % 256, entry + 1)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([directory, ...frames.map((frame) => frame.png)])
}

// sharp has no BMP writer; NSIS wants a plain 24-bit BI_RGB bitmap with bottom-up BGR rows padded to 4 bytes.
function encodeBmp({ data, info }) {
  const { width, height, channels } = info
  if (channels !== 3) throw new Error(`BMP needs RGB input, got ${channels} channels`)
  const stride = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = stride * height
  const bmp = Buffer.alloc(54 + pixelBytes)
  bmp.write('BM', 0, 'ascii')
  bmp.writeUInt32LE(bmp.length, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(width, 18)
  bmp.writeInt32LE(height, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(24, 28)
  bmp.writeUInt32LE(0, 30)
  bmp.writeUInt32LE(pixelBytes, 34)
  // 2835 px/m = 72 dpi
  bmp.writeInt32LE(2835, 38)
  bmp.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3
      const dst = row + x * 3
      bmp[dst] = data[src + 2]
      bmp[dst + 1] = data[src + 1]
      bmp[dst + 2] = data[src]
    }
  }
  return bmp
}

function textSvg(width, height, { x, y, size, anchor = 'start', family = font }) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="600" ` +
      `fill="${textColor}" text-anchor="${anchor}">${wordmark}</text></svg>`,
  )
}

// Without the font, fontconfig silently substitutes a fallback face; compare against a family that cannot exist.
async function assertFontInstalled() {
  const measure = async (family) => {
    const { info } = await sharp(textSvg(400, 40, { x: 0, y: 28, size: 15, family }))
      .trim()
      .toBuffer({ resolveWithObject: true })
    return info.width
  }
  if ((await measure(font)) === (await measure('Butterfly Record Missing Font'))) {
    throw new Error(`${font} is not installed; the installer images must be generated on Windows`)
  }
}

async function installerImage(width, height, { icon, text }) {
  const canvas = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await renderIcon(icon.size), left: icon.left, top: icon.top },
      { input: textSvg(width, height, text), left: 0, top: 0 },
    ])
    .png()
    .toBuffer()
  const raw = await sharp(canvas)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return encodeBmp(raw)
}

await Promise.all([extensionDir, desktopIconDir, installerDir].map((dir) => mkdir(dir, { recursive: true })))

for (const size of extensionSizes) {
  await save(join(extensionDir, `${size}.png`), await renderIcon(size))
}

for (const [name, size] of Object.entries(desktopPngs)) {
  await save(join(desktopIconDir, name), await renderIcon(size))
}

const frames = await Promise.all(icoSizes.map(async (size) => ({ size, png: await renderIcon(size) })))
await save(join(desktopIconDir, 'icon.ico'), encodeIco(frames))

// MUI2 header image (left of the inner-page header) and welcome/finish sidebar; both sit on white dialog areas.
await assertFontInstalled()
await save(
  join(installerDir, 'header.bmp'),
  await installerImage(150, 57, {
    icon: { size: 24, left: 12, top: 16 },
    text: { x: 44, y: 33, size: 13 },
  }),
)
await save(
  join(installerDir, 'sidebar.bmp'),
  await installerImage(164, 314, {
    icon: { size: 64, left: 50, top: 80 },
    text: { x: 82, y: 176, size: 15, anchor: 'middle' },
  }),
)

for (const path of written) console.log(relative(root, path).replaceAll('\\', '/'))
console.log(`\n${written.length} files written`)
