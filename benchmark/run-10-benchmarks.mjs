import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { Worker as NodeWorker } from 'worker_threads';

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('./jxl-worker-shim.mjs', import.meta.url), {
      workerData: {
        url: workerUrl,
        name: options.name ?? '',
      },
    });
    this.#worker.on('message', (data) => {
      this.#onmessage?.({ data });
    });
    this.#worker.on('error', (error) => {
      this.#onerror?.(error);
    });
  }

  postMessage(message, transfer) {
    this.#worker.postMessage(message, transfer);
  }

  terminate() {
    return this.#worker.terminate();
  }

  set onmessage(handler) {
    this.#onmessage = handler;
  }

  get onmessage() {
    return this.#onmessage;
  }

  set onerror(handler) {
    this.#onerror = handler;
  }

  get onerror() {
    return this.#onerror;
  }
}
globalThis.Worker = BrowserLikeWorker;

import initRaw, { process_orf, rgb_to_rgba, downscale_rgba } from './pkg/raw_converter_wasm.js';
import { createEncoder, createDecoder } from '@casabio/jxl-wasm';
import { computePsnrVsFinal, computeSsimVsFinal } from './web/jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal } from './web/jxl-butteraugli.js';
import { createSneyersPreset } from './web/jxl-progressive-best-preset.js';

const results = [];
const runCount = 10;

async function runOnce(iteration) {
  console.log(`\n=== Run ${iteration}/${runCount} ===`);

  const wasmBytes = readFileSync('./pkg/raw_converter_wasm_bg.wasm');
  await initRaw(wasmBytes);

  const filePath = "C:\\995\\2026-02-20 Gobabeb To Windhoek\\P2200476 Pogonospermum cleomoides.ORF";
  const rawBytes = readFileSync(filePath);

  const result = process_orf(rawBytes, 0.3, 0.1, 0, 0, 0, 0, 0.15, 0.1, 0, 0, NaN, NaN, 0, 0);
  const rgba = rgb_to_rgba(result.take_rgb());
  const sourceWidth = result.width;
  const sourceHeight = result.height;
  result.free();

  const targetLongEdge = 1920;
  const sourceLong = Math.max(sourceWidth, sourceHeight);
  const scale = targetLongEdge / sourceLong;
  const targetWidth = Math.round(sourceWidth * scale);
  const targetHeight = Math.round(sourceHeight * scale);

  let targetRgba = rgba;
  if (downscale_rgba) {
    targetRgba = downscale_rgba(rgba, sourceWidth, sourceHeight, targetWidth, targetHeight);
  }

  const quality = 85;
  const preset = createSneyersPreset({
    width: targetWidth,
    height: targetHeight,
    targetLongEdge: 'full',
    quality,
    hasAlpha: true,
    progressiveDetail: 'passes'
  });

  const encoder = createEncoder({
    ...preset.encode,
    width: targetWidth,
    height: targetHeight,
    quality,
    progressiveDc: 0,
    progressiveAc: 0,
    qProgressiveAc: 0,
    progressiveDetail: 'passes',
    buffering: { strategy: 0 },
    chunked: false,
  });

  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  await encoder.pushPixels(targetRgba.buffer.slice(targetRgba.byteOffset, targetRgba.byteOffset + targetRgba.byteLength));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();

  const views = chunks.map(chunk => chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  const total = views.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const jxlBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of views) {
    jxlBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const decoder = createDecoder({
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: true,
    progressiveDetail: 'passes',
    preserveIcc: false,
    preserveMetadata: false,
  });

  const passes = [];
  const eventTask = (async () => {
    for await (const event of decoder.events()) {
      if (event.type === 'progress' || event.type === 'final') {
        passes.push({
          pass: passes.length + 1,
          isFinal: event.type === 'final',
          pixels: new Uint8Array(event.pixels)
        });
      }
    }
  })();

  await decoder.push(jxlBytes.buffer.slice(jxlBytes.byteOffset, jxlBytes.byteOffset + jxlBytes.byteLength));
  await decoder.close();
  await eventTask;
  await decoder.dispose();

  const finalPixels = targetRgba;

  // Metrics
  let totalPsnrTime = 0;
  for (const p of passes) {
    const start = performance.now();
    computePsnrVsFinal(finalPixels, p.pixels);
    const t = performance.now() - start;
    totalPsnrTime += t;
  }

  let totalSsimTime = 0;
  for (const p of passes) {
    const start = performance.now();
    computeSsimVsFinal(finalPixels, p.pixels, targetWidth, targetHeight);
    const t = performance.now() - start;
    totalSsimTime += t;
  }

  const startPre = performance.now();
  const refXyb = pixelsToXyb(finalPixels, targetWidth * targetHeight);
  const preTime = performance.now() - startPre;

  let totalButtTime = 0;
  for (const p of passes) {
    const start = performance.now();
    computeButteraugliVsFinal(refXyb, p.pixels, targetWidth, targetHeight);
    const t = performance.now() - start;
    totalButtTime += t;
  }

  const grandTotal = totalPsnrTime + totalSsimTime + totalButtTime + preTime;

  results.push({
    run: iteration,
    psnr_ms: totalPsnrTime,
    ssim_ms: totalSsimTime,
    butt_total_ms: totalButtTime + preTime,
    total_ms: grandTotal,
    passes: passes.length,
  });

  console.log(`✓ ${grandTotal.toFixed(2)}ms`);
}

async function main() {
  for (let i = 1; i <= runCount; i++) {
    await runOnce(i);
  }

  // Generate .toon file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) + 'Z';
  const toonContent = generateToonFile(results, timestamp);

  mkdirSync('docs/benchmarks', { recursive: true });
  const filename = `docs/benchmarks/metrics-performance-${timestamp}.toon`;
  writeFileSync(filename, toonContent);

  console.log(`\n✓ Results saved to ${filename}\n`);
  console.log(toonContent);
}

function generateToonFile(results, timestamp) {
  const avgTotal = results.length ? results.reduce((sum, r) => sum + r.total_ms, 0) / results.length : 0;
  const avgPsnr = results.length ? results.reduce((sum, r) => sum + r.psnr_ms, 0) / results.length : 0;
  const avgSsim = results.length ? results.reduce((sum, r) => sum + r.ssim_ms, 0) / results.length : 0;
  const avgButt = results.length ? results.reduce((sum, r) => sum + r.butt_total_ms, 0) / results.length : 0;

  let toon = `TestName: metrics-performance
RunTimestamp: ${timestamp}
Agent: haiku
Metric: psnr,ssim,butteraugli
Source: Pogonospermum cleomoides
Target: 1920x1433
Quality: 85
Effort: 0
Passes: 2
TimeBase: ${timestamp.slice(0, 10)}T${timestamp.slice(11, 13)}:

---
runs[${results.length}]{run|psnr_ms|ssim_ms|butt_ms|total_ms}:
`;

  for (const r of results) {
    toon += `  ${r.run} | ${r.psnr_ms.toFixed(2)} | ${r.ssim_ms.toFixed(2)} | ${(r.butt_total_ms).toFixed(2)} | ${r.total_ms.toFixed(2)}\n`;
  }

  toon += `
# Aggregates
RunCount: ${results.length}
AvgTotal: ${avgTotal.toFixed(2)} ms
AvgPsnr: ${avgPsnr.toFixed(2)} ms
AvgSsim: ${avgSsim.toFixed(2)} ms
AvgButteraugli: ${avgButt.toFixed(2)} ms
`;

  if (results.length > 0) {
    const totals = results.map(r => r.total_ms);
    toon += `MinTotal: ${Math.min(...totals).toFixed(2)} ms
MaxTotal: ${Math.max(...totals).toFixed(2)} ms
StdDev: ${calculateStdDev(totals).toFixed(2)} ms
`;
  }

  return toon;
}

function calculateStdDev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

main().catch(console.error);
