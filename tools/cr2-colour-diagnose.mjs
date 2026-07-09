#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';

import initRaw, { process_cr2_with_flags, downscale_rgb } from '../web/pkg/raw_converter_wasm.js';

await initRaw({ module_or_path: readFileSync(new URL('../web/pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });

const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX = 2;
const OUT_THUMB = 4;
const DEFAULT_FILES = [
  String.raw`C:\Foo\raw-converter\tests\ADH 1234.CR2`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1248.CR2`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1455.CR2`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1490.CR2`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1514.CR2`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1559.CR2`,
  String.raw`C:\Foo\raw-converter\tests\ADH 1570.CR2`,
  String.raw`C:\Foo\raw-converter\tests\_MG_1744.CR2`,
  String.raw`C:\Foo\raw-converter\tests\_MG_1747.CR2`,
  String.raw`C:\Foo\raw-converter\tests\_MG_1749.CR2`,
  String.raw`C:\Foo\raw-converter\tests\_MG_1750.CR2`,
];

const args = process.argv.slice(2);
const writePng = args.includes('--write-png');
const files = args.filter((a) => a !== '--write-png');
const inputs = files.length ? files : DEFAULT_FILES;

function extractJpegs(bytes) {
  const starts = [];
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) starts.push(i);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const limit = i + 1 < starts.length ? starts[i + 1] : bytes.length;
    for (let end = limit - 2; end > start; end--) {
      if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) {
        out.push(bytes.slice(start, end + 2));
        break;
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

function stats(rgb) {
  const n = rgb.length / 3;
  let r = 0, g = 0, b = 0, l = 0, l2 = 0, sat = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const R = rgb[i], G = rgb[i + 1], B = rgb[i + 2];
    r += R; g += G; b += B;
    const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    l += y; l2 += y * y;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    if (mx > 0) sat += (mx - mn) / mx;
  }
  r /= n; g /= n; b /= n; l /= n; sat /= n;
  return {
    r, g, b, luma: l,
    rg: r / Math.max(g, 1e-6),
    bg: b / Math.max(g, 1e-6),
    sat,
    contrast: Math.sqrt(Math.max(0, l2 / n - l * l)),
  };
}

function meanAbsDiff(a, b) {
  if (a.length !== b.length) return NaN;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

function lumaDelta(a, b) {
  return Math.abs(stats(a).luma - stats(b).luma);
}

function fmt(s) {
  return `RGB ${s.r.toFixed(1)} ${s.g.toFixed(1)} ${s.b.toFixed(1)} ` +
    `L ${s.luma.toFixed(1)} R/G ${s.rg.toFixed(3)} B/G ${s.bg.toFixed(3)} sat ${s.sat.toFixed(3)} ctr ${s.contrast.toFixed(1)}`;
}

async function referenceAt(bytes, w, h) {
  for (const jpeg of extractJpegs(bytes)) {
    try {
      const { data } = await sharp(jpeg).rotate().resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      // CR2 raw image data is also LJPEG; keep looking for the 8-bit embedded preview.
    }
  }
  return null;
}

if (writePng) mkdirSync('cr2-colour-debug', { recursive: true });

for (const file of inputs) {
  if (!existsSync(file)) {
    console.log(`${file}: missing`);
    continue;
  }
  const bytes = new Uint8Array(readFileSync(file));
  const result = process_cr2_with_flags(
    bytes,
    OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0,
  );
  try {
    const wbR = result.wb_r_used;
    const wbB = result.wb_b_used;
    const matrix = Array.from(result.color_matrix_used());
    const renderer = result.take_lightbox_renderer();
    const lb = renderer.render(wbR, wbB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const rgb = result.take_rgb();
    const fullAtLb = downscale_rgb(rgb, result.width, result.height, result.lb_w, result.lb_h);
    const ref = await referenceAt(bytes, result.lb_w, result.lb_h);
    let bestEv = null;
    if (ref) {
      for (const ev of [-2, -1, 0, 1, 2, 3, 4]) {
        const trial = renderer.render(wbR, wbB, ev, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        const delta = lumaDelta(trial, ref);
        if (!bestEv || delta < bestEv.delta) bestEv = { ev, delta, stats: stats(trial) };
      }
    }
    renderer.free();
    const name = basename(file);
    console.log(`\n${name}`);
    console.log(`  meta: ${result.make} ${result.model} ${result.width}x${result.height} lb=${result.lb_w}x${result.lb_h} black=${result.black_used} white=${result.white_used} wb=${wbR.toFixed(3)}/${wbB.toFixed(3)} matrixFromFile=${result.color_matrix_from_mn}`);
    console.log(`  matrix: ${matrix.map((v) => v.toFixed(4)).join(' ')}`);
    console.log(`  full->lb: ${fmt(stats(fullAtLb))}`);
    console.log(`  lightbox: ${fmt(stats(lb))} mad_vs_full ${meanAbsDiff(lb, fullAtLb).toFixed(2)}`);
    if (ref) console.log(`  embedjpg: ${fmt(stats(ref))} mad_lb_vs_ref ${meanAbsDiff(lb, ref).toFixed(2)}`);
    if (bestEv) console.log(`  bestEV: ${bestEv.ev >= 0 ? '+' : ''}${bestEv.ev} -> ${fmt(bestEv.stats)} luma_delta ${bestEv.delta.toFixed(1)}`);
    if (writePng) {
      const stem = name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '_');
      await sharp(lb, { raw: { width: result.lb_w, height: result.lb_h, channels: 3 } }).png().toFile(join('cr2-colour-debug', `${stem}_lightbox.png`));
      await sharp(fullAtLb, { raw: { width: result.lb_w, height: result.lb_h, channels: 3 } }).png().toFile(join('cr2-colour-debug', `${stem}_full.png`));
      if (ref) await sharp(ref, { raw: { width: result.lb_w, height: result.lb_h, channels: 3 } }).png().toFile(join('cr2-colour-debug', `${stem}_embedded.jpg.png`));
    }
  } catch (e) {
    console.log(`${file}: ERROR ${e?.stack || e}`);
  } finally {
    result.free();
  }
}
