// WASM-path 4ch-alpha round-trip: does the BROWSER pipeline (jxl-wasm bridge → libjxl-wasm)
// preserve alpha through encode→decode? Native (casabio) is proven; this is the wasm path.
import { Worker as NodeWorker } from 'worker_threads';

class BrowserLikeWorker {
  #worker; #onmessage = null; #onerror = null;
  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('./jxl-worker-shim.mjs', import.meta.url), {
      workerData: { url: workerUrl, name: options.name ?? '' },
    });
    this.#worker.on('message', (data) => this.#onmessage?.({ data }));
    this.#worker.on('error', (error) => this.#onerror?.(error));
  }
  postMessage(m, t) { this.#worker.postMessage(m, t); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(h) { this.#onmessage = h; } get onmessage() { return this.#onmessage; }
  set onerror(h) { this.#onerror = h; } get onerror() { return this.#onerror; }
}
globalThis.Worker = BrowserLikeWorker;

const { createEncoder, createDecoder } = await import('@casabio/jxl-wasm');

const W = 64, H = 64, N = W * H;
// 4ch RGBA with an alpha pattern: ~1/3 of pixels at alpha=100, rest 255.
const rgba = new Uint8Array(N * 4);
for (let i = 0; i < N; i++) {
  rgba[i * 4] = 180; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 40;
  rgba[i * 4 + 3] = (i % 3 === 0) ? 100 : 255;
}
const expectedLow = Math.floor(N / 3);

// --- ENCODE via wasm bridge, hasAlpha:true ---
const encoder = createEncoder({
  format: 'rgba8', width: W, height: H, hasAlpha: true,
  iccProfile: null, exif: null, xmp: null,
  distance: null, quality: 90, effort: 3, progressive: false,
});
const chunks = [];
const chunkTask = (async () => { for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); })();
await encoder.pushPixels(rgba.buffer.slice(0));
await encoder.finish();
await chunkTask;
await encoder.dispose();
const total = chunks.reduce((s, c) => s + c.byteLength, 0);
const jxl = new Uint8Array(total);
{ let o = 0; for (const c of chunks) { jxl.set(c, o); o += c.byteLength; } }
console.log(`encoded ${jxl.byteLength} bytes (wasm, hasAlpha:true)`);

// --- DECODE via wasm bridge, rgba8 ---
const decoder = createDecoder({
  format: 'rgba8', region: null, downsample: 1, progressionTarget: 'final',
  emitEveryPass: false, progressiveDetail: 'passes', preserveIcc: false, preserveMetadata: false,
});
let finalPixels = null;
const evTask = (async () => {
  for await (const ev of decoder.events()) {
    if (ev.type === 'final' || ev.type === 'progress') finalPixels = new Uint8Array(ev.pixels);
  }
})();
await decoder.push(jxl.buffer.slice(0));
await decoder.close();
await evTask;
await decoder.dispose();

if (!finalPixels) { console.log('FAIL: no decoded pixels'); process.exit(1); }
console.log(`decoded ${finalPixels.byteLength} bytes (expected ${N * 4})`);

// --- CHECK alpha preserved ---
let low = 0;
for (let i = 0; i < N; i++) if (finalPixels[i * 4 + 3] < 200) low++;
const ok = finalPixels.byteLength === N * 4 && low > expectedLow * 0.7;
console.log(`low-alpha pixels after round-trip: ${low} (expected ~${expectedLow})`);
console.log(ok
  ? 'PASS: WASM path preserves 4ch alpha through encode->decode'
  : `FAIL: alpha NOT preserved through wasm path (low=${low}, likely flattened to 255)`);
process.exit(ok ? 0 : 1);
