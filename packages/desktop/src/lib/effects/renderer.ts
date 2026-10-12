// Draws a camera frame with its background effect and touch-up on the GPU. Everything is
// computed relative to the visible picture, so the same frame comes out the same at the
// overlay's size and at the size it is composited into a recording.

import {
  blurPlan,
  MASK_EDGE,
  mipLevel,
  type BlurStrength,
  type CameraBackground,
  type Size,
  type Tone,
} from '../camera-effects.ts'
import { coverRect, type SourceRect } from '../workers/composite-protocol.ts'

export type EffectCanvas = HTMLCanvasElement | OffscreenCanvas

export interface RenderParams {
  /** The part of the uploaded frame that is shown, in frame pixels. */
  crop: SourceRect
  background: CameraBackground
  blur: BlurStrength
  /** `#rrggbb`. */
  color: string
  mirror: boolean
  tone: Tone
  /** A mask has been set for this crop; without one the background cannot be told apart. */
  masked: boolean
}

/** Side of the picture read back to meter the touch-up. */
export const METER_SIZE = 16

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`

// Rows are stored top first everywhere except the canvas itself, which is flipped at the end.
const COPY = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform vec2 u_size;
uniform vec4 u_crop;
uniform float u_lod;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  color = vec4(textureLod(u_frame, u_crop.xy + uv * u_crop.zw, u_lod).rgb, 1.0);
}`

// The person counts for almost nothing in the background blur; otherwise they would be
// smeared into a halo around themselves.
const WEIGHT = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform vec2 u_size;
uniform vec4 u_crop;
uniform float u_lod;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec3 rgb = textureLod(u_frame, u_crop.xy + uv * u_crop.zw, u_lod).rgb;
  float weight = mix(1.0, 0.02, smoothstep(0.15, 0.5, texture(u_mask, uv).r));
  color = vec4(rgb * weight, weight);
}`

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_size;
uniform vec2 u_step;
uniform float u_sigma;
uniform int u_radius;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float falloff = -0.5 / (u_sigma * u_sigma);
  vec4 sum = texture(u_source, uv);
  float total = 1.0;
  for (int i = 1; i <= 12; i++) {
    if (i > u_radius) break;
    float g = exp(float(i * i) * falloff);
    vec2 offset = u_step * float(i);
    sum += (texture(u_source, uv + offset) + texture(u_source, uv - offset)) * g;
    total += 2.0 * g;
  }
  color = sum / total;
}`

const COMPOSE = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform sampler2D u_blur;
uniform sampler2D u_image;
uniform vec2 u_size;
uniform vec4 u_crop;
uniform vec2 u_maskTexel;
uniform vec2 u_edge;
uniform int u_mode;
uniform bool u_mirror;
uniform vec4 u_imageRect;
uniform vec3 u_color;
uniform vec3 u_tone;
out vec4 color;

vec3 touchUp(vec3 rgb) {
  rgb = pow(max(rgb, vec3(0.0)), vec3(u_tone.x));
  rgb = (rgb - 0.5) * u_tone.y + 0.5;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  return clamp(mix(vec3(luma), rgb, u_tone.z), 0.0, 1.0);
}

// A small tent filter over the low-resolution mask before the edge is drawn, so the
// outline is feathered rather than stepped.
float person(vec2 uv) {
  vec2 t = u_maskTexel;
  float m = texture(u_mask, uv).r * 4.0
    + (texture(u_mask, uv + vec2(t.x, 0.0)).r + texture(u_mask, uv - vec2(t.x, 0.0)).r
      + texture(u_mask, uv + vec2(0.0, t.y)).r + texture(u_mask, uv - vec2(0.0, t.y)).r) * 2.0
    + texture(u_mask, uv + t).r + texture(u_mask, uv - t).r
    + texture(u_mask, uv + vec2(t.x, -t.y)).r + texture(u_mask, uv + vec2(-t.x, t.y)).r;
  return smoothstep(u_edge.x, u_edge.y, m / 16.0);
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_size.x, 1.0 - gl_FragCoord.y / u_size.y);
  // The camera, its mask and its blur are mirrored; a chosen picture is not, so its text
  // still reads the right way round.
  vec2 view = vec2(u_mirror ? 1.0 - uv.x : uv.x, uv.y);
  vec3 camera = touchUp(texture(u_frame, u_crop.xy + view * u_crop.zw).rgb);
  if (u_mode == 0) {
    color = vec4(camera, 1.0);
    return;
  }
  vec3 behind;
  if (u_mode == 1) {
    vec4 blurred = texture(u_blur, view);
    behind = touchUp(blurred.rgb / max(blurred.a, 0.001));
  } else if (u_mode == 2) {
    behind = texture(u_image, u_imageRect.xy + uv * u_imageRect.zw).rgb;
  } else {
    behind = u_color;
  }
  color = vec4(mix(behind, camera, person(view)), 1.0);
}`

const MODES: Record<CameraBackground, number> = { none: 0, blur: 1, image: 2, color: 3 }

type Uniforms = Record<string, WebGLUniformLocation | null>

interface Program {
  program: WebGLProgram
  uniforms: Uniforms
}

interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
}

function rgb(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16)
  if (!Number.isFinite(value)) return [0, 0, 0]
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

export class EffectRenderer {
  readonly canvas: EffectCanvas
  #gl: WebGL2RenderingContext
  #copy: Program
  #weight: Program
  #blur: Program
  #compose: Program
  #frame: WebGLTexture
  #mask: WebGLTexture
  #image: WebGLTexture
  #blank: WebGLTexture
  #frameSize: Size = { width: 0, height: 0 }
  #maskSize: Size = { width: 0, height: 0 }
  #imageSize: Size | null = null
  #blurTargets: [Target, Target] | null = null
  #meterTarget: Target | null = null
  #meterPixels = new Uint8Array(METER_SIZE * METER_SIZE * 4)
  #meterBuffer: WebGLBuffer | null = null
  #meterFence: WebGLSync | null = null
  /** Half floats keep the weighted blur exact where the weights are small. */
  #blurFormat: { internal: number; type: number }
  #lost = false

  constructor(canvas: EffectCanvas) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // The compositor draws the last result again for every screen frame in between.
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('This computer cannot draw camera effects (WebGL 2 is unavailable).')
    this.#gl = gl
    canvas.addEventListener('webglcontextlost', () => (this.#lost = true))

    this.#copy = this.#program(COPY)
    this.#weight = this.#program(WEIGHT)
    this.#blur = this.#program(BLUR)
    this.#compose = this.#program(COMPOSE)
    this.#frame = this.#texture(gl.LINEAR_MIPMAP_LINEAR)
    this.#mask = this.#texture(gl.LINEAR)
    this.#image = this.#texture(gl.LINEAR_MIPMAP_LINEAR)
    this.#blank = this.#texture(gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))

    const halfFloat = gl.getExtension('EXT_color_buffer_float') !== null
    this.#blurFormat = halfFloat
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(gl.createVertexArray())
  }

  get lost(): boolean {
    return this.#lost || this.#gl.isContextLost()
  }

  /** The camera frame every later call draws from. */
  upload(frame: TexImageSource, width: number, height: number): void {
    const gl = this.#gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#frame)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.#frameSize = { width, height }
  }

  /** Person confidence over the crop, 0–255, rows top first. */
  setMask(mask: Uint8Array, width: number, height: number): void {
    const gl = this.#gl
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.#mask)
    if (width !== this.#maskSize.width || height !== this.#maskSize.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, mask)
      this.#maskSize = { width, height }
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, mask)
    }
  }

  setImage(image: ImageBitmap | null): void {
    const gl = this.#gl
    if (!image) {
      this.#imageSize = null
      return
    }
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.#image)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.#imageSize = { width: image.width, height: image.height }
  }

  /**
   * A tiny RGBA copy of the visible picture, for metering the touch-up. The copy is read back
   * once the GPU has finished it, a frame or so later, so drawing never waits for it: this
   * returns the newest copy that is ready, or null while none is.
   */
  meter(crop: SourceRect): Uint8Array | null {
    const gl = this.#gl
    let ready: Uint8Array | null = null
    if (this.#meterFence) {
      if (gl.getSyncParameter(this.#meterFence, gl.SYNC_STATUS) !== gl.SIGNALED) return null
      gl.deleteSync(this.#meterFence)
      this.#meterFence = null
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#meterBuffer)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.#meterPixels)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      ready = this.#meterPixels
    }

    this.#meterTarget ??= this.#target(METER_SIZE, METER_SIZE, gl.RGBA8, gl.UNSIGNED_BYTE)
    const target = this.#meterTarget
    this.#bindFrame(0)
    this.#use(this.#copy, target)
    gl.uniform1i(this.#copy.uniforms.u_frame!, 0)
    gl.uniform4fv(this.#copy.uniforms.u_crop!, this.#cropUv(crop))
    gl.uniform1f(this.#copy.uniforms.u_lod!, mipLevel(Math.max(crop.w, crop.h), METER_SIZE))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (!this.#meterBuffer) {
      this.#meterBuffer = gl.createBuffer()
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#meterBuffer)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.#meterPixels.byteLength, gl.STREAM_READ)
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#meterBuffer)
    gl.readPixels(0, 0, METER_SIZE, METER_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.#meterFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    return ready
  }

  /** Draws the visible picture into the whole canvas, at the canvas's size. */
  render(params: RenderParams): void {
    const gl = this.#gl
    const width = this.canvas.width
    const height = this.canvas.height
    const crop = this.#cropUv(params.crop)
    let mode = params.masked ? MODES[params.background] : 0
    let blur = params.blur
    // A picture that could not be loaded must not reveal the room it was meant to hide.
    if (mode === MODES.image && !this.#imageSize) {
      mode = MODES.blur
      blur = 'strong'
    }

    if (mode === MODES.blur) this.#blurBackground(blur, crop, params.crop, width, height)

    this.#use(this.#compose, null, width, height)
    const uniforms = this.#compose.uniforms
    this.#bindFrame(0)
    this.#bind(1, mode === 0 ? this.#blank : this.#mask)
    const blurred = mode === MODES.blur ? this.#blurTargets?.[0].texture : undefined
    this.#bind(2, blurred ?? this.#blank)
    this.#bind(3, mode === MODES.image ? this.#image : this.#blank)
    gl.uniform1i(uniforms.u_frame!, 0)
    gl.uniform1i(uniforms.u_mask!, 1)
    gl.uniform1i(uniforms.u_blur!, 2)
    gl.uniform1i(uniforms.u_image!, 3)
    gl.uniform4fv(uniforms.u_crop!, crop)
    gl.uniform2f(
      uniforms.u_maskTexel!,
      1 / Math.max(1, this.#maskSize.width),
      1 / Math.max(1, this.#maskSize.height),
    )
    gl.uniform2f(uniforms.u_edge!, MASK_EDGE[0], MASK_EDGE[1])
    gl.uniform1i(uniforms.u_mode!, mode)
    gl.uniform1i(uniforms.u_mirror!, params.mirror ? 1 : 0)
    gl.uniform4fv(uniforms.u_imageRect!, this.#imageRect(width, height))
    gl.uniform3fv(uniforms.u_color!, rgb(params.color))
    gl.uniform3f(uniforms.u_tone!, params.tone.gamma, params.tone.contrast, params.tone.saturation)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Frees the GPU memory but keeps the context, which a canvas can only ever have one of. */
  close(): void {
    const gl = this.#gl
    for (const program of [this.#copy, this.#weight, this.#blur, this.#compose]) {
      gl.deleteProgram(program.program)
    }
    for (const texture of [this.#frame, this.#mask, this.#image, this.#blank]) {
      gl.deleteTexture(texture)
    }
    for (const target of [...(this.#blurTargets ?? []), this.#meterTarget]) {
      if (target) this.#dropTarget(target)
    }
    this.#blurTargets = null
    this.#meterTarget = null
    if (this.#meterFence) gl.deleteSync(this.#meterFence)
    gl.deleteBuffer(this.#meterBuffer)
    this.#meterFence = null
    this.#meterBuffer = null
  }

  #blurBackground(
    strength: BlurStrength,
    crop: Float32Array,
    source: SourceRect,
    width: number,
    height: number,
  ): void {
    const gl = this.#gl
    const plan = blurPlan(strength, width, height)
    const [first, second] = this.#blurPair(plan.width, plan.height)

    this.#use(this.#weight, first)
    this.#bindFrame(0)
    this.#bind(1, this.#mask)
    gl.uniform1i(this.#weight.uniforms.u_frame!, 0)
    gl.uniform1i(this.#weight.uniforms.u_mask!, 1)
    gl.uniform4fv(this.#weight.uniforms.u_crop!, crop)
    gl.uniform1f(this.#weight.uniforms.u_lod!, mipLevel(source.h, plan.height))
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    for (const [from, to, step] of [
      [first, second, [1 / plan.width, 0]],
      [second, first, [0, 1 / plan.height]],
    ] as const) {
      this.#use(this.#blur, to)
      this.#bind(2, from.texture)
      gl.uniform1i(this.#blur.uniforms.u_source!, 2)
      gl.uniform2f(this.#blur.uniforms.u_step!, step[0], step[1])
      gl.uniform1f(this.#blur.uniforms.u_sigma!, plan.sigma)
      gl.uniform1i(this.#blur.uniforms.u_radius!, plan.radius)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }

  #blurPair(width: number, height: number): [Target, Target] {
    const current = this.#blurTargets
    if (current && current[0].width === width && current[0].height === height) return current
    if (current) for (const target of current) this.#dropTarget(target)
    const { internal, type } = this.#blurFormat
    const pair: [Target, Target] = [
      this.#target(width, height, internal, type),
      this.#target(width, height, internal, type),
    ]
    this.#blurTargets = pair
    return pair
  }

  /** The chosen picture cover-fitted to the canvas, as a texture rectangle. */
  #imageRect(width: number, height: number): Float32Array {
    const image = this.#imageSize
    if (!image) return new Float32Array([0, 0, 1, 1])
    const rect = coverRect(image.width, image.height, width, height)
    return new Float32Array([
      rect.x / image.width,
      rect.y / image.height,
      rect.w / image.width,
      rect.h / image.height,
    ])
  }

  #cropUv(crop: SourceRect): Float32Array {
    const { width, height } = this.#frameSize
    if (width <= 0 || height <= 0) return new Float32Array([0, 0, 1, 1])
    return new Float32Array([crop.x / width, crop.y / height, crop.w / width, crop.h / height])
  }

  #use(program: Program, target: Target | null, width = 0, height = 0): void {
    const gl = this.#gl
    gl.useProgram(program.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null)
    const w = target ? target.width : width
    const h = target ? target.height : height
    gl.viewport(0, 0, w, h)
    gl.uniform2f(program.uniforms.u_size!, w, h)
  }

  #bindFrame(unit: number): void {
    this.#bind(unit, this.#frame)
  }

  #bind(unit: number, texture: WebGLTexture): void {
    const gl = this.#gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  #texture(minFilter: number): WebGLTexture {
    const gl = this.#gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  #target(width: number, height: number, internal: number, type: number): Target {
    const gl = this.#gl
    const texture = this.#texture(gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, null)
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture, framebuffer, width, height }
  }

  #dropTarget(target: Target): void {
    this.#gl.deleteFramebuffer(target.framebuffer)
    this.#gl.deleteTexture(target.texture)
  }

  #program(fragment: string): Program {
    const gl = this.#gl
    const program = gl.createProgram()
    const shaders: WebGLShader[] = []
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Camera effects could not be set up.')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Camera effect shader failed: ${gl.getShaderInfoLog(shader) ?? ''}`)
      }
      gl.attachShader(program, shader)
      shaders.push(shader)
    }
    gl.linkProgram(program)
    for (const shader of shaders) gl.deleteShader(shader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Camera effect program failed: ${gl.getProgramInfoLog(program) ?? ''}`)
    }
    const uniforms: Uniforms = {}
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let index = 0; index < count; index++) {
      const info = gl.getActiveUniform(program, index)
      if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name)
    }
    return { program, uniforms }
  }
}
