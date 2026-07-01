// probe.mjs — JXL-as-video proof-of-concept probe.
//
// Generates 4 motion sequences of 48 frames (2s @ 24fps) from the Mandelbrot
// seahorse valley, each isolating ONE motion regime the video-codec thesis
// depends on, then measures real JXL byte cost under three coding strategies:
//   INTRA        — every frame coded independently (Motion-JXL, today's behaviour)
//   DELTA_NONE   — I-frame + zero-motion residuals (current - previous)
//   DELTA_SHIFT  — I-frame + horizontal-shift-compensated residuals (single dx)
//   DELTA_LAYERED— per-depth-band horizontal-shift residuals (train parallax)
//
// All coding is LOSSLESS (cjxl -d 0) so the numbers are a clean information
// signal with zero drift — a real codec would use lossy residuals with an
// in-loop reconstruct, but lossless isolates "how much information is in the
// frame vs the motion-compensated delta", which is the load-bearing question.
//
// Usage:
//   node probe.mjs gen       # render + write PNG frames to the sibling folders
//   node probe.mjs measure   # encode INTRA/DELTA variants, print + write results
//   node probe.mjs all
//
// Deliverable frames  -> C:\Foo\raw-converter\tests\fractal_gen_seahorse_<seq>\
// Measurement scratch -> %TEMP%\jxl-video-probe\
// Results JSON        -> ./results.json (next to this script)

import { deflateSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const CJXL = String.raw`C:\Foo\bld-libjxl-static\tools\cjxl.exe`;
const DJXL = String.raw`C:\Foo\bld-libjxl-static\tools\djxl.exe`;
const OUT_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const WORK = join(tmpdir(), 'jxl-video-probe');

// ---- frame + fractal geometry -------------------------------------------------
const W = 1280, H = 720, N = 48, MAXIT = 280;
// Seahorse valley of the Mandelbrot set.
const CX = -0.745, CY = 0.113;
const PPU = 14000;                        // pixels per complex unit for a frame
const SPICENTER = { cx: -0.74364, cy: 0.11017 }; // seahorse spiral, zoom target
// Dense seahorse-valley viewport used as the base image for pan/parallax/static.
// Panning the raw complex plane drifts into the set interior (black); instead we
// render one rich base frame and mirror-tile it into a seamless wide strip so
// every crop stays detailed (like landscape footage with mixed sky/ground detail).
const BASE = { cx: -0.7453, cy: 0.1122, ppu: 30000 };

// Per-sequence horizontal motion, expressed as total pixels of pan over N frames.
const PAN_TOTAL = 1280;                   // pan one screen width in 2s
const BANDS = [                           // parallax: depth layers by image row
  { name: 'far',  y0: 0,   y1: 288, pan: 376  }, // top 40% — slow (distant)
  { name: 'mid',  y0: 288, y1: 504, pan: 940  }, // 30% — medium
  { name: 'near', y0: 504, y1: 720, pan: 2068 }, // bottom 30% — fast (trackside)
];
const ZOOM_TOTAL = 2.0;                    // zoom in by 2x across the sequence

const SEQS = ['static', 'motion', 'parallax', 'zoom'];
const seqDir = (s) => join(OUT_ROOT, `fractal_gen_seahorse_${s}`);

// ---- Mandelbrot render --------------------------------------------------------
// Smooth (continuous) escape-time + phase-shifted sine palette, tone-mapped to 8-bit.
function renderViewport(w, h, xMin, xMax, yMin, yMax) {
  const buf = Buffer.allocUnsafe(w * h * 3);
  const tau = Math.PI * 2;
  for (let py = 0; py < h; py++) {
    const cy = yMin + (py / h) * (yMax - yMin);
    for (let px = 0; px < w; px++) {
      const cx = xMin + (px / w) * (xMax - xMin);
      let x = 0, y = 0, i = 0, x2 = 0, y2 = 0;
      for (; i < MAXIT; i++) {
        x2 = x * x; y2 = y * y;
        if (x2 + y2 > 256) break;
        y = 2 * x * y + cy; x = x2 - y2 + cx;
      }
      let r, g, b;
      if (i >= MAXIT) { r = g = b = 0; }
      else {
        const logZn = Math.log(x2 + y2) / 2;
        const nu = Math.log(logZn / Math.LN2) / Math.LN2;
        const it = i + 1 - nu;
        const t = Math.min(1, Math.max(0, it / MAXIT));
        const sr = 0.5 + 0.5 * Math.sin(tau * (t * 3 + 0.00));
        const sg = 0.5 + 0.5 * Math.sin(tau * (t * 3 + 0.33));
        const sb = 0.5 + 0.5 * Math.sin(tau * (t * 3 + 0.66));
        const hdr = 1 + 2 * t;             // HDR peaks ~3
        r = tone(sr * hdr); g = tone(sg * hdr); b = tone(sb * hdr);
      }
      const o = (py * w + px) * 3;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
    }
  }
  return buf;
}
function tone(x) {                          // Reinhard + gamma 1/2.2 -> 0..255
  const m = x / (1 + x);
  return Math.round(255 * Math.pow(m, 1 / 2.2));
}
function viewportFor(cx, cy, ppu, w, h) {
  const hw = (w / 2) / ppu, hh = (h / 2) / ppu;
  return [cx - hw, cx + hw, cy - hh, cy + hh];
}

// crop a wide RGB8 buffer [wideW x h] at horizontal pixel offset -> W x h
function crop(wide, wideW, h, xoff, w = W) {
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let y = 0; y < h; y++) {
    const src = (y * wideW + xoff) * 3;
    wide.copy(out, y * w * 3, src, src + w * 3);
  }
  return out;
}
// mirror-tile a base [bw x h] into a seamless rich strip [stripW x h]
function mirrorTileStrip(base, bw, h, stripW) {
  const out = Buffer.allocUnsafe(stripW * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < stripW; x++) {
      const tile = Math.floor(x / bw);
      let sx = x % bw;
      if (tile % 2 === 1) sx = bw - 1 - sx;      // reflect odd tiles -> seamless
      const so = (y * bw + sx) * 3, doo = (y * stripW + x) * 3;
      out[doo] = base[so]; out[doo + 1] = base[so + 1]; out[doo + 2] = base[so + 2];
    }
  return out;
}
function renderBase() {
  const [xa, xb, ya, yb] = viewportFor(BASE.cx, BASE.cy, BASE.ppu, W, H);
  return renderViewport(W, H, xa, xb, ya, yb);
}

// ---- frame construction per sequence ------------------------------------------
// Returns array of N rgb8 Buffers.
function buildSequence(seq) {
  const frames = [];
  if (seq === 'static') {
    const base = renderBase();
    for (let i = 0; i < N; i++) {
      const f = Buffer.from(base);
      // small bright element orbiting near centre (a "creature" in a trail-cam)
      const ang = (i / N) * Math.PI * 2;
      const ox = Math.round(W / 2 + 90 * Math.cos(ang));
      const oy = Math.round(H / 2 + 90 * Math.sin(ang));
      stampDisc(f, W, H, ox, oy, 26, [255, 236, 120]);
      // faint global light flicker (+-2%)
      const gain = 1 + 0.02 * Math.sin(ang);
      if (gain !== 1) for (let k = 0; k < f.length; k++) f[k] = clamp8(f[k] * gain);
      frames.push(f);
    }
  } else if (seq === 'motion') {
    const stripW = W + PAN_TOTAL;
    const strip = mirrorTileStrip(renderBase(), W, H, stripW);
    for (let i = 0; i < N; i++)
      frames.push(crop(strip, stripW, H, Math.round((i / (N - 1)) * PAN_TOTAL)));
  } else if (seq === 'parallax') {
    const maxPan = Math.max(...BANDS.map((b) => b.pan));
    const stripW = W + maxPan;
    const strip = mirrorTileStrip(renderBase(), W, H, stripW);
    for (let i = 0; i < N; i++) {
      const f = Buffer.allocUnsafe(W * H * 3);
      for (const band of BANDS) {
        const off = Math.round((i / (N - 1)) * band.pan);
        for (let y = band.y0; y < band.y1; y++) {
          const src = (y * stripW + off) * 3;
          strip.copy(f, y * W * 3, src, src + W * 3);
        }
      }
      frames.push(f);
    }
  } else if (seq === 'zoom') {
    const rate = Math.pow(ZOOM_TOTAL, 1 / (N - 1));
    for (let i = 0; i < N; i++) {
      const ppu = PPU * Math.pow(rate, i);
      const [xa, xb, ya, yb] = viewportFor(SPICENTER.cx, SPICENTER.cy, ppu, W, H);
      frames.push(renderViewport(W, H, xa, xb, ya, yb));
    }
  }
  return frames;
}
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function stampDisc(buf, w, h, cx, cy, r, col) {
  for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y++)
    for (let x = Math.max(0, cx - r); x < Math.min(w, cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const a = Math.min(1, (r - d) / 6);       // soft edge
      const o = (y * w + x) * 3;
      buf[o] = clamp8(buf[o] * (1 - a) + col[0] * a);
      buf[o + 1] = clamp8(buf[o + 1] * (1 - a) + col[1] * a);
      buf[o + 2] = clamp8(buf[o + 2] * (1 - a) + col[2] * a);
    }
}

// per-sequence per-frame band offsets (for shift-compensation in measure)
function bandOffsets(seq, i) {
  if (seq === 'motion') return [{ y0: 0, y1: H, off: Math.round((i / (N - 1)) * PAN_TOTAL) }];
  if (seq === 'parallax')
    return BANDS.map((b) => ({ y0: b.y0, y1: b.y1, off: Math.round((i / (N - 1)) * b.pan) }));
  return null;
}

// ---- PPM (16-bit, big-endian) writers -----------------------------------------
function ppm16FromRgb8(rgb8) {                 // intra: values 0..255 in 16-bit container
  const px = W * H, hdr = Buffer.from(`P6\n${W} ${H}\n65535\n`, 'ascii');
  const body = Buffer.allocUnsafe(px * 6);
  for (let i = 0; i < px * 3; i++) body.writeUInt16BE(rgb8[i], i * 2);
  return Buffer.concat([hdr, body]);
}
function ppm16Residual(cur, shiftedPrev) {     // residual + 32768 offset, 16-bit
  const px = W * H, hdr = Buffer.from(`P6\n${W} ${H}\n65535\n`, 'ascii');
  const body = Buffer.allocUnsafe(px * 6);
  for (let i = 0; i < px * 3; i++) body.writeUInt16BE((cur[i] - shiftedPrev[i] + 32768) | 0, i * 2);
  return Buffer.concat([hdr, body]);
}
// horizontal shift of prev so shifted[x] = prev[x+off] within a row band; disocclusion -> 0
function shiftBands(prev, offsets) {
  const out = Buffer.alloc(W * H * 3);          // zero-filled (disocclusion)
  for (const b of offsets) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = 0; x < W; x++) {
        const sx = x + b.off;
        if (sx >= 0 && sx < W) {
          const so = (y * W + sx) * 3, doo = (y * W + x) * 3;
          out[doo] = prev[so]; out[doo + 1] = prev[so + 1]; out[doo + 2] = prev[so + 2];
        }
      }
    }
  }
  return out;
}

// ---- cjxl / djxl --------------------------------------------------------------
function encode(ppmBuf, tag, effort = 7, distance = 0) {
  const inp = join(WORK, `${tag}.ppm`), out = join(WORK, `${tag}.jxl`);
  writeFileSync(inp, ppmBuf);
  const t0 = process.hrtime.bigint();
  execFileSync(CJXL, [inp, out, '-e', String(effort), '-d', String(distance), '--quiet'],
    { stdio: 'ignore' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bytes = statSync(out).size;
  rmSync(inp, { force: true });
  return { bytes, encMs: ms, out };
}
function decodeMs(jxlPath, tag) {
  const out = join(WORK, `${tag}.dec.ppm`);
  const t0 = process.hrtime.bigint();
  execFileSync(DJXL, [jxlPath, out, '--quiet'], { stdio: 'ignore' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rmSync(out, { force: true });
  return ms;
}

// ---- minimal PNG encoder (RGB8, built-in zlib, zero external deps) -------------
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crcBuf]);
}
function writePng(path, rgb8, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const stride = w * 3;
  const raw = Buffer.allocUnsafe(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                          // filter: None
    rgb8.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 6 });
  writeFileSync(path, Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]));
}

// ---- commands -----------------------------------------------------------------
function cmdGen() {
  for (const seq of SEQS) {
    const dir = seqDir(seq);
    mkdirSync(dir, { recursive: true });
    console.log(`[gen] ${seq} -> ${dir}`);
    const frames = buildSequence(seq);
    for (let i = 0; i < frames.length; i++)
      writePng(join(dir, `frame_${String(i).padStart(3, '0')}.png`), frames[i], W, H);
    console.log(`[gen] ${seq}: wrote ${frames.length} frames`);
  }
  console.log('[gen] done');
}

function cmdMeasure() {
  mkdirSync(WORK, { recursive: true });
  const results = { config: { W, H, N, MAXIT, effort: 7, distance: 0, cjxl: 'v0.12.0' }, sequences: {} };
  for (const seq of SEQS) {
    console.log(`\n[measure] ${seq}`);
    const frames = buildSequence(seq);
    const r = { intraBytes: 0, deltaNoneBytes: 0, deltaShiftBytes: 0, deltaLayeredBytes: 0,
      intraDecMs: 0, deltaDecMs: 0, perFrame: [] };

    // INTRA: every frame independent
    for (let i = 0; i < N; i++) {
      const e = encode(ppm16FromRgb8(frames[i]), `${seq}_intra_${i}`);
      r.intraBytes += e.bytes;
      r.intraDecMs += decodeMs(e.out, `${seq}_intra_${i}`);
      rmSync(e.out, { force: true });
    }

    // DELTA_NONE: frame0 intra + zero-motion residuals
    {
      const e0 = encode(ppm16FromRgb8(frames[0]), `${seq}_dn_0`);
      r.deltaNoneBytes += e0.bytes; r.deltaDecMs += decodeMs(e0.out, `${seq}_dn_0`);
      rmSync(e0.out, { force: true });
      const zero = { y0: 0, y1: H, off: 0 };
      for (let i = 1; i < N; i++) {
        const sp = shiftBands(frames[i - 1], [zero]);
        const e = encode(ppm16Residual(frames[i], sp), `${seq}_dn_${i}`);
        r.deltaNoneBytes += e.bytes; r.deltaDecMs += decodeMs(e.out, `${seq}_dn_${i}`);
        rmSync(e.out, { force: true });
      }
    }

    // DELTA_SHIFT (single global horizontal shift) — motion + parallax only
    if (seq === 'motion' || seq === 'parallax') {
      const e0 = encode(ppm16FromRgb8(frames[0]), `${seq}_ds_0`);
      r.deltaShiftBytes += e0.bytes;
      for (let i = 1; i < N; i++) {
        // single shift = the 'mid'/global pan speed
        const globalOff = (o) => [{ y0: 0, y1: H, off: o }];
        const offCur = bandOffsets(seq, i), offPrev = bandOffsets(seq, i - 1);
        // pick the mid band (or the only band) as the single global dx
        const pick = (arr) => arr[Math.floor(arr.length / 2)].off;
        const ddx = pick(offCur) - pick(offPrev);
        const sp = shiftBands(frames[i - 1], globalOff(ddx));
        const e = encode(ppm16Residual(frames[i], sp), `${seq}_ds_${i}`);
        r.deltaShiftBytes += e.bytes;
      }
    }

    // DELTA_LAYERED (per-band horizontal shift) — parallax (and motion == same as shift)
    if (seq === 'motion' || seq === 'parallax') {
      const e0 = encode(ppm16FromRgb8(frames[0]), `${seq}_dl_0`);
      r.deltaLayeredBytes += e0.bytes;
      for (let i = 1; i < N; i++) {
        const offCur = bandOffsets(seq, i), offPrev = bandOffsets(seq, i - 1);
        const bands = offCur.map((b, k) => ({ y0: b.y0, y1: b.y1, off: b.off - offPrev[k].off }));
        const sp = shiftBands(frames[i - 1], bands);
        const e = encode(ppm16Residual(frames[i], sp), `${seq}_dl_${i}`);
        r.deltaLayeredBytes += e.bytes;
      }
    }

    r.intraDecMsPerFrame = r.intraDecMs / N;
    r.deltaDecMsPerFrame = r.deltaDecMs / N;
    results.sequences[seq] = r;
    report(seq, r);
  }
  writeFileSync(join(__dir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n[measure] wrote results.json`);
  printSummary(results);
}

function kb(b) { return (b / 1024).toFixed(1); }
function report(seq, r) {
  const base = r.intraBytes;
  const pct = (x) => x ? `${((1 - x / base) * 100).toFixed(1)}% smaller` : '—';
  console.log(`  INTRA        ${kb(r.intraBytes)} KB  (${kb(r.intraBytes / N)} KB/frame)  dec ${r.intraDecMsPerFrame.toFixed(1)} ms/f`);
  console.log(`  DELTA_NONE   ${kb(r.deltaNoneBytes)} KB  ${pct(r.deltaNoneBytes)}   dec ${r.deltaDecMsPerFrame.toFixed(1)} ms/f`);
  if (r.deltaShiftBytes) console.log(`  DELTA_SHIFT  ${kb(r.deltaShiftBytes)} KB  ${pct(r.deltaShiftBytes)}`);
  if (r.deltaLayeredBytes) console.log(`  DELTA_LAYER  ${kb(r.deltaLayeredBytes)} KB  ${pct(r.deltaLayeredBytes)}`);
}
function printSummary(res) {
  console.log('\n================ SUMMARY (lossless, -e7 -d0) ================');
  console.log('seq        intraKB   bestDeltaKB   reduction   winner');
  for (const s of SEQS) {
    const r = res.sequences[s];
    const cands = [['none', r.deltaNoneBytes], ['shift', r.deltaShiftBytes], ['layer', r.deltaLayeredBytes]]
      .filter(([, b]) => b > 0);
    const [win, wb] = cands.reduce((a, b) => (b[1] < a[1] ? b : a));
    const red = ((1 - wb / r.intraBytes) * 100).toFixed(1);
    console.log(`${s.padEnd(10)} ${kb(r.intraBytes).padStart(8)} ${kb(wb).padStart(12)} ${(red + '%').padStart(10)}   ${win}`);
  }
}

const cmd = process.argv[2] || 'all';
if (cmd === 'gen' || cmd === 'all') await cmdGen();
if (cmd === 'measure' || cmd === 'all') cmdMeasure();
