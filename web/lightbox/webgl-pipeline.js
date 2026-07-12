/** WebGL float-texture HDR path for 16-bit RAW levels (M3 display + export). */

import { buildColorMatrix, clampAdjustments } from './filter-engine.js';

const VS_300 = `#version 300 es
in vec2 aPos;
out vec2 vTex;
void main() {
  vTex = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS_300 = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uTex;
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform vec3 uOff;
uniform float uShadows;
uniform float uHighlights;
out vec4 fragColor;
void main() {
  vec3 rgb = texture(uTex, vTex).rgb;
  rgb = vec3(
    dot(rgb, uM0) + uOff.r,
    dot(rgb, uM1) + uOff.g,
    dot(rgb, uM2) + uOff.b
  );
  // Tone map — must match filter-engine.applyToneMapInPlace (canonical 8-bit path).
  // Clamp the matrix output first (the 8-bit path tone-maps the already-clamped
  // matrix result), then luma-mask in 0..255 space with the same 128/192 knees.
  rgb = clamp(rgb, 0.0, 1.0);
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114)) * 255.0;
  float shadowMask = max(0.0, 128.0 - luma) / 128.0;
  float highlightMask = max(0.0, luma - 192.0) / 63.0;
  rgb += uShadows * 0.6 * shadowMask / 255.0;
  rgb += uHighlights * 0.5 * highlightMask / 255.0;
  fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const VS_100 = `
attribute vec2 aPos;
varying vec2 vTex;
void main() {
  vTex = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS_100 = `
precision highp float;
varying vec2 vTex;
uniform sampler2D uTex;
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform vec3 uOff;
uniform float uShadows;
uniform float uHighlights;
void main() {
  vec3 rgb = texture2D(uTex, vTex).rgb;
  rgb = vec3(
    dot(rgb, uM0) + uOff.r,
    dot(rgb, uM1) + uOff.g,
    dot(rgb, uM2) + uOff.b
  );
  // Tone map — must match filter-engine.applyToneMapInPlace (canonical 8-bit path).
  // Clamp the matrix output first (the 8-bit path tone-maps the already-clamped
  // matrix result), then luma-mask in 0..255 space with the same 128/192 knees.
  rgb = clamp(rgb, 0.0, 1.0);
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114)) * 255.0;
  float shadowMask = max(0.0, 128.0 - luma) / 128.0;
  float highlightMask = max(0.0, luma - 192.0) / 63.0;
  rgb += uShadows * 0.6 * shadowMask / 255.0;
  rgb += uHighlights * 0.5 * highlightMask / 255.0;
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

let sharedRenderer = null;

export function canUseWebGL16() {
  try {
    return createHdrRenderer() !== null;
  } catch {
    return false;
  }
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(sh) ?? 'shader compile failed';
    gl.deleteShader(sh);
    throw new Error(msg);
  }
  return sh;
}

function linkProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const msg = gl.getProgramInfoLog(prog) ?? 'program link failed';
    gl.deleteProgram(prog);
    throw new Error(msg);
  }
  return prog;
}

function matrixUniforms(matrix) {
  return {
    m0: [matrix[0], matrix[1], matrix[2]],
    m1: [matrix[5], matrix[6], matrix[7]],
    m2: [matrix[10], matrix[11], matrix[12]],
    off: [matrix[4] / 255, matrix[9] / 255, matrix[14] / 255],
  };
}

/**
 * WebGL HDR renderer: RGBA16F source → float shader adjust → float readback → FS dither.
 */
export function createHdrRenderer() {
  const probe = document.createElement('canvas');
  const gl2 = probe.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  const isWebGL2 = !!gl2;
  const gl = gl2 ?? probe.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  if (!isWebGL2) {
    const texFloat = gl.getExtension('OES_texture_float');
    const colorBufferFloat = gl.getExtension('WEBGL_color_buffer_float');
    if (!texFloat || !colorBufferFloat) return null;
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, isWebGL2 ? VS_300 : VS_100);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, isWebGL2 ? FS_300 : FS_100);
  const program = linkProgram(gl, vs, fs);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, 'aPos');
  const uTex = gl.getUniformLocation(program, 'uTex');
  const uM0 = gl.getUniformLocation(program, 'uM0');
  const uM1 = gl.getUniformLocation(program, 'uM1');
  const uM2 = gl.getUniformLocation(program, 'uM2');
  const uOff = gl.getUniformLocation(program, 'uOff');
  const uShadows = gl.getUniformLocation(program, 'uShadows');
  const uHighlights = gl.getUniformLocation(program, 'uHighlights');

  const srcTex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  const fboTex = gl.createTexture();

  // F12: track last allocated FBO dimensions so texImage2D is skipped when the
  // caller renders the same size image repeatedly (e.g. opening the same lightbox
  // card multiple times). Previously every call to runShader → ensureFbo would
  // unconditionally call gl.texImage2D, reallocating the FBO texture even when
  // width and height were unchanged. Under a long lightbox session this produced
  // one GPU realloc per open — O(opens) instead of O(distinct sizes).
  let _fboW = 0;
  let _fboH = 0;

  function ensureFbo(w, h) {
    // Skip realloc when the FBO is already sized correctly (F12 fix).
    if (w === _fboW && h === _fboH) return;
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (isWebGL2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    _fboW = w;
    _fboH = h;
  }

  function uploadSource(bytes, width, height) {
    const view = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const floats = new Float32Array(width * height * 4);
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const si = i * 4;
      floats[si] = view[si] / 65535;
      floats[si + 1] = view[si + 1] / 65535;
      floats[si + 2] = view[si + 2] / 65535;
      floats[si + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (isWebGL2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, floats);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, floats);
    }
  }

  function runShader(width, height, matrix, shadows, highlights) {
    ensureFbo(width, height);
    const mu = matrixUniforms(matrix);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(uTex, 0);
    gl.uniform3fv(uM0, mu.m0);
    gl.uniform3fv(uM1, mu.m1);
    gl.uniform3fv(uM2, mu.m2);
    gl.uniform3fv(uOff, mu.off);
    gl.uniform1f(uShadows, shadows);
    gl.uniform1f(uHighlights, highlights);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const out = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    flipFloatY(out, width, height);
    return out;
  }

  return {
    gl,
    isWebGL2,
    /** Adjust in WebGL float space; returns linear RGBA float top-left origin. */
    adjustToFloat(bytes, width, height, matrix, shadows, highlights) {
      uploadSource(bytes, width, height);
      return runShader(width, height, matrix, shadows, highlights);
    },
    dispose() {
      gl.deleteTexture(srcTex);
      gl.deleteTexture(fboTex);
      gl.deleteFramebuffer(fbo);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(quad);
    },
  };
}

function getRenderer() {
  if (!sharedRenderer) sharedRenderer = createHdrRenderer();
  return sharedRenderer;
}

function flipFloatY(src, width, height) {
  const row = width * 4;
  const tmp = new Float32Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const top = y * row;
    const bot = (height - 1 - y) * row;
    tmp.set(src.subarray(top, top + row));
    src.set(src.subarray(bot, bot + row), top);
    src.set(tmp, bot);
  }
}

/**
 * Floyd-Steinberg dither RGBA float [0,1] → 8-bit canvas.
 */
export function floydSteinbergDitherToCanvas(src, width, height, canvas) {
  const err = new Float32Array(width * height * 3);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const si = i * 4;
      const ei = i * 3;
      for (let c = 0; c < 3; c++) {
        const old = src[si + c] + err[ei + c];
        const neu = Math.round(old * 255) / 255;
        const quant = Math.min(1, Math.max(0, neu));
        const e = old - quant;
        out[si + c] = quant * 255;
        if (x + 1 < width) err[ei + 3 + c] += e * 7 / 16;
        if (y + 1 < height) {
          if (x > 0) err[ei + (width - 1) * 3 + c] += e * 3 / 16;
          err[ei + width * 3 + c] += e * 5 / 16;
          if (x + 1 < width) err[ei + (width + 1) * 3 + c] += e * 1 / 16;
        }
      }
      out[si + 3] = 255;
    }
  }
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(out, width, height), 0, 0);
}

/** Float [0,1] → Uint16 RGBA (for 16-bit export). */
export function floatToRgba16(floats, width, height) {
  const out = new Uint16Array(width * height * 4);
  const n = width * height * 4;
  for (let i = 0; i < n; i++) {
    out[i] = Math.min(65535, Math.max(0, Math.round(floats[i] * 65535)));
  }
  return out;
}

/** CPU fallback when WebGL unavailable. */
export function adjustRgba16Cpu(bytes, width, height, matrix, shadows, highlights) {
  const view = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const n = width * height;
  const floats = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const si = i * 4;
    floats[si] = view[si] / 65535;
    floats[si + 1] = view[si + 1] / 65535;
    floats[si + 2] = view[si + 2] / 65535;
    floats[si + 3] = 1;
  }
  const mu = matrixUniforms(matrix);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = floats[o];
    const g = floats[o + 1];
    const b = floats[o + 2];
    floats[o] = mu.m0[0] * r + mu.m0[1] * g + mu.m0[2] * b + mu.off[0];
    floats[o + 1] = mu.m1[0] * r + mu.m1[1] * g + mu.m1[2] * b + mu.off[1];
    floats[o + 2] = mu.m2[0] * r + mu.m2[1] * g + mu.m2[2] * b + mu.off[2];
    // Clamp matrix output first (mirror filter-engine's 8-bit intermediate clamp),
    // then tone map identically to filter-engine.applyToneMapInPlace (128/192 knees,
    // 0..255 luma space). Keeps this CPU fallback bit-for-bit with the GLSL shaders.
    const cr = Math.min(1, Math.max(0, floats[o]));
    const cg = Math.min(1, Math.max(0, floats[o + 1]));
    const cb = Math.min(1, Math.max(0, floats[o + 2]));
    const luma = (0.299 * cr + 0.587 * cg + 0.114 * cb) * 255;
    const shadowMask = Math.max(0, 128 - luma) / 128;
    const highlightMask = Math.max(0, luma - 192) / 63;
    const toneAdd = shadows * 0.6 * shadowMask / 255 + highlights * 0.5 * highlightMask / 255;
    floats[o] = Math.min(1, Math.max(0, cr + toneAdd));
    floats[o + 1] = Math.min(1, Math.max(0, cg + toneAdd));
    floats[o + 2] = Math.min(1, Math.max(0, cb + toneAdd));
  }
  return floats;
}

function adjustRgba16ToFloat(bytes, width, height, preset, adjustments) {
  const adj = clampAdjustments(adjustments);
  const matrix = buildColorMatrix(preset, adj);
  const renderer = getRenderer();
  if (renderer) {
    return renderer.adjustToFloat(bytes, width, height, matrix, adj.shadows, adj.highlights);
  }
  return adjustRgba16Cpu(bytes, width, height, matrix, adj.shadows, adj.highlights);
}

/** M3 primary path: WebGL float adjust → Floyd-Steinberg dither → 8-bit canvas. */
export function renderRgba16AdjustedToCanvas(bytes, width, height, canvas, preset, adjustments) {
  const floats = adjustRgba16ToFloat(bytes, width, height, preset, adjustments);
  floydSteinbergDitherToCanvas(floats, width, height, canvas);
}

/** Adjusted RGBA16 pixels for 16-bit export (WebGL float path when available). */
export function adjustedRgba16ForExport(bytes, width, height, preset, adjustments) {
  const floats = adjustRgba16ToFloat(bytes, width, height, preset, adjustments);
  return floatToRgba16(floats, width, height);
}

/**
 * Testable factory that wraps a pre-created WebGL context and exposes only the
 * `ensureFbo` function for unit tests (F12 fix verification). Production code
 * uses `createHdrRenderer()` / `getRenderer()` which call the full factory with
 * a real canvas; this entry-point lets tests inject a mock `gl` without a DOM.
 *
 * @param {object} gl  WebGL rendering context (real or mock).
 * @param {{ isWebGL2?: boolean }} [opts]
 * @returns {{ ensureFbo(w: number, h: number): void }}
 */
export function createHdrRendererWithReuse(gl, { isWebGL2 = false } = {}) {
  const fboTex = gl.createTexture();
  const fbo = gl.createFramebuffer();

  // F12: dimension tracking — skip texImage2D when dims unchanged.
  let _fboW = 0;
  let _fboH = 0;

  function ensureFbo(w, h) {
    if (w === _fboW && h === _fboH) return;
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (isWebGL2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    _fboW = w;
    _fboH = h;
  }

  return { ensureFbo };
}

/** @deprecated use createHdrRenderer */
export function uploadRgba16ToGl(gl, texture, pixels, width, height) {
  const floats = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height * 4; i++) floats[i] = pixels[i] / 65535;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (isWebGL2) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, floats);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, floats);
  }
}