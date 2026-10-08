// Pictures and playable files for mock mode, drawn on a canvas in flat colours.

import { AudioBufferSource, BufferTarget, CanvasSource, Output, WebMOutputFormat } from 'mediabunny'

import type { Scene } from './mock-data.ts'

const WIDTH = 640
const HEIGHT = 360

function rect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, r = 0) {
  context.fillStyle = color
  context.beginPath()
  context.roundRect(x, y, w, h, r)
  context.fill()
}

function lines(context: CanvasRenderingContext2D, x: number, y: number, widths: number[], color: string, gap = 18) {
  widths.forEach((w, index) => rect(context, x, y + index * gap, w, 8, color, 4))
}

function drawApp(context: CanvasRenderingContext2D, scene: Scene) {
  rect(context, 56, 40, 528, 300, '#f6f6f4', 8)
  rect(context, 56, 40, 528, 28, '#e7e7e3', 8)
  rect(context, 56, 60, 528, 8, '#e7e7e3')
  rect(context, 56, 68, 132, 272, '#eeeeea')
  lines(context, 72, 88, [88, 72, 96, 64, 80], '#cfcfca', 22)
  rect(context, 72, 84, 4, 16, scene.tint, 2)
  rect(context, 208, 88, 200, 14, '#3b3b3b', 4)
  lines(context, 208, 118, [320, 290, 336], '#d8d8d3')
  for (let index = 0; index < 3; index++) {
    rect(context, 208 + index * 120, 180, 108, 72, '#ffffff', 6)
    rect(context, 220 + index * 120, 194, 48, 8, '#d0d0cb', 4)
    rect(context, 220 + index * 120, 214, 64, 18, index === 0 ? scene.tint : '#bdbdb8', 4)
  }
  rect(context, 208, 272, 96, 26, scene.tint, 6)
}

function drawSlides(context: CanvasRenderingContext2D, scene: Scene) {
  rect(context, 72, 44, 496, 280, '#fbfbf9', 6)
  rect(context, 104, 84, 260, 18, '#2f2f2f', 4)
  rect(context, 104, 112, 160, 10, '#9a9a96', 4)
  const bars = [0.45, 0.62, 0.38, 0.8, 0.7, 0.92]
  bars.forEach((value, index) => {
    const h = 130 * value
    rect(context, 112 + index * 44, 290 - h, 28, h, index === bars.length - 1 ? scene.tint : '#c9c9c4', 3)
  })
  lines(context, 400, 160, [120, 96, 132, 84], '#c9c9c4', 22)
  rect(context, 392, 156, 4, 16, scene.tint, 2)
}

function drawCall(context: CanvasRenderingContext2D, scene: Scene) {
  const tiles: [number, number, string, string][] = [
    [24, 32, '#3d4652', '#9fb0c2'],
    [328, 32, '#4a4552', scene.tint],
  ]
  for (const [x, y, fill, face] of tiles) {
    rect(context, x, y, 288, 254, fill, 8)
    context.fillStyle = face
    context.beginPath()
    context.arc(x + 144, y + 112, 44, 0, Math.PI * 2)
    context.fill()
    rect(context, x + 96, y + 168, 96, 64, face, 32)
    rect(context, x + 12, y + 222, 88, 20, 'rgba(0,0,0,0.45)', 4)
  }
  rect(context, 248, 302, 144, 36, '#1f2226', 18)
  ;['#e5484d', '#5c6470', '#5c6470'].forEach((color, index) => {
    context.fillStyle = color
    context.beginPath()
    context.arc(284 + index * 36, 320, 11, 0, Math.PI * 2)
    context.fill()
  })
}

function drawCode(context: CanvasRenderingContext2D, scene: Scene) {
  rect(context, 40, 32, 560, 300, '#1f2328', 8)
  rect(context, 40, 32, 48, 300, '#181b1f', 8)
  rect(context, 88, 32, 512, 26, '#262b31')
  const palette = ['#7aa2c8', '#c8a07a', '#9ac38a', '#b8b8b8', scene.tint]
  for (let row = 0; row < 12; row++) {
    const indent = [0, 16, 32, 32, 16, 0, 16, 32, 48, 32, 16, 0][row]!
    const widths = [60 + ((row * 37) % 90), 40 + ((row * 53) % 120), 30 + ((row * 29) % 70)]
    let x = 108 + indent
    widths.forEach((w, index) => {
      rect(context, x, 74 + row * 20, w, 8, palette[(row + index) % palette.length]!, 3)
      x += w + 8
    })
  }
  rect(context, 330, 140, 220, 120, '#f6f6f4', 6)
  rect(context, 346, 156, 120, 10, '#2f2f2f', 4)
  lines(context, 346, 180, [180, 150], '#cfcfca')
  rect(context, 466, 226, 68, 22, scene.tint, 5)
}

export function drawScene(context: CanvasRenderingContext2D, scene: Scene) {
  context.fillStyle = scene.backdrop
  context.fillRect(0, 0, WIDTH, HEIGHT)
  if (scene.kind === 'app') drawApp(context, scene)
  else if (scene.kind === 'slides') drawSlides(context, scene)
  else if (scene.kind === 'call') drawCall(context, scene)
  else drawCode(context, scene)
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas')
  element.width = WIDTH
  element.height = HEIGHT
  return [element, element.getContext('2d')!]
}

export async function posterJpeg(scene: Scene): Promise<Uint8Array> {
  const [element, context] = canvas()
  drawScene(context, scene)
  const blob = await new Promise<Blob | null>((resolve) => element.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new Error('Canvas could not encode a poster.')
  return new Uint8Array(await blob.arrayBuffer())
}

const FRAME_SECONDS = 4
const AUDIO_CHUNK_SECONDS = 4

/**
 * A real WebM with the right duration: one frame every few seconds plus silent Opus,
 * so the player, seeking, probing and audio extraction all behave as they would on disk.
 */
export async function clipWebm(scene: Scene, duration: number): Promise<Uint8Array> {
  const [element, context] = canvas()
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
  const video = new CanvasSource(element, { codec: 'vp8', bitrate: 300_000, keyFrameInterval: FRAME_SECONDS })
  const audio = new AudioBufferSource({ codec: 'opus', bitrate: 24_000 })
  output.addVideoTrack(video, { frameRate: 1 / FRAME_SECONDS })
  output.addAudioTrack(audio)
  await output.start()

  const length = Math.max(FRAME_SECONDS, duration)
  for (let at = 0; at < length; at += FRAME_SECONDS) {
    drawScene(context, scene)
    // A thin moving bar so seeking visibly changes the picture.
    rect(context, 0, HEIGHT - 4, (WIDTH * at) / length, 4, 'rgba(255,255,255,0.6)')
    await video.add(at, Math.min(FRAME_SECONDS, length - at))
  }
  const silence = new AudioBuffer({ length: 48_000 * AUDIO_CHUNK_SECONDS, numberOfChannels: 1, sampleRate: 48_000 })
  for (let at = 0; at < length; at += AUDIO_CHUNK_SECONDS) await audio.add(silence)

  await output.finalize()
  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) throw new Error('The mock clip was not written.')
  return new Uint8Array(buffer)
}

/** 0.5 s of silence as a 16-bit mono WAV, for the text-to-speech stub. */
export function silentWav(): ArrayBuffer {
  const samples = 12_000
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24_000, true)
  view.setUint32(28, 48_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  return buffer
}
