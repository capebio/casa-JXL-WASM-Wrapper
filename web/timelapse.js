// timelapse.js — RAW Time-Lapse Studio UI (K4).
//
// Turns a sorted sequence of RAW stills into a CASAVA (.casv) time-lapse. The
// browser decodes a preview strip in-page (WASM RAW pipeline, web/pkg) and
// builds the encode request; the full-sequence encode runs the native
// `casv_encode --raw-frames` sidecar on the desktop (Tauri) build.
//
// Why the encode is native-only: each ~20 MP RAW frame needs tens of MB of WASM
// heap to decode, and the CASAVA (libjxl VarDCT / modular) video encoder is a
// native crate (jxl-ffi, not compiled to wasm). Encoding a whole sequence in
// the browser would blow the heap and has no codec anyway — so the browser
// previews + documents the exact CLI, and the desktop app drives the sidecar.
//
// The heavy player packages (casv-web + jxl-*) are imported lazily (only when
// you open something in the embedded player) so the preview/encode UI works as
// a plain page even if those dist bundles are not built.

import {
  isRawName, buildRawEncodeRequest, rawFramesCliString,
  encodeFableTimelapse, suggestTimelapseName,
  filterSelectedAssets, buildSequentialFrames, applyLookToDecodeArgs,
  makeTimelapseCancelToken, buildTimelapseExportRequest,
} from './timelapse-core.js';
import { PRESETS } from './casv-lightbox/casv-lightbox-core.js';

const THUMB_LIMIT = 24;   // eager-decode at most this many thumbnails
const THUMB_EDGE = 200;   // longest edge (px) of a decoded thumbnail

// ── host + native glue (kept local so this page has no hard dep on the player
//    packages; mirrors web/casv-lightbox/casv-platform.js) ───────────────────
function isTauri() {
  return typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}
function tauriInvoke(cmd, args) {
  const t = window.__TAURI__ || {};
  const invoke = t.core?.invoke || t.invoke || t.tauri?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return Promise.reject(new Error('Tauri invoke() unavailable'));
  return invoke(cmd, args);
}
async function onEncodeProgress(cb) {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return () => {};
  try {
    return await listen('casv-encode-progress', (e) => {
      const p = e?.payload || {};
      cb({ stage: String(p.stage || ''), done: Number(p.done) || 0, total: Number(p.total) || 0 });
    });
  } catch (_) { return () => {}; }
}
function pickCasvFile() {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = '.casv,application/octet-stream'; i.style.display = 'none';
    i.addEventListener('change', () => { const f = i.files?.[0] || null; i.remove(); resolve(f); });
    document.body.appendChild(i); i.click();
  });
}
async function pickNativeRawPaths() {
  const dialog = window.__TAURI__?.dialog;
  let paths = null;
  if (dialog?.open) {
    paths = await dialog.open({
      multiple: true,
      filters: [{ name: 'RAW stills', extensions: ['orf', 'ORF', 'dng', 'DNG', 'cr2', 'CR2'] }],
    });
  } else {
    paths = await tauriInvoke('casv_pick_images', {});
  }
  return Array.isArray(paths) ? paths : (paths ? [paths] : []);
}
async function readFileBytes(path) {
  const fs = window.__TAURI__?.fs;
  if (fs?.readFile) {
    const b = await fs.readFile(path);
    return b instanceof Uint8Array ? b : new Uint8Array(b);
  }
  throw new Error('Tauri fs plugin (readFile) unavailable — cannot open ' + path);
}

// ── WASM RAW decode (web/pkg), for the preview strip ────────────────────────
let _wasmReady;
async function ensureWasm() {
  if (!_wasmReady) _wasmReady = (async () => {
    const mod = await import('./pkg/raw_converter_wasm.js');
    await mod.default();
    // The shipped pkg is the threaded build; rayon speeds each decode when the
    // page is cross-origin-isolated (COOP/COEP). Best-effort; single-thread WASM
    // still decodes correctly if the pool can't start.
    if (typeof mod.initThreadPool === 'function'
        && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      try { await mod.initThreadPool(Math.max(1, navigator.hardwareConcurrency || 4)); } catch (_) { /* fall back to ST */ }
    }
    return mod;
  })();
  return _wasmReady;
}
function pickThumbDecoder(mod, name) {
  switch ((name.toLowerCase().match(/\.([^.]+)$/) || [])[1]) {
    case 'orf': return mod.process_orf_with_flags;
    case 'dng': return mod.process_dng_with_flags;
    case 'cr2': return mod.process_cr2_with_flags;
    default: throw new Error('unsupported RAW: ' + name);
  }
}
const OUT_THUMB = 4; // src/lib.rs output_flags bit: 360 px RGB16 thumb only

/** Decode a RAW to a thumb-sized (360 px) display RGB8 with a neutral look.
 *  OUT_THUMB-only skips the full-res demosaic entirely (streaming half-res
 *  superpixel arm) — roughly an order of magnitude faster and far lower peak
 *  memory than the full 20 MP decode this replaced, which existed only to be
 *  nearest-neighbour-sampled down to a 200 px canvas.
 *  Returned rgb is in SENSOR orientation; drawThumb applies `orientation`. */
async function decodeRawThumb(bytes, name) {
  const mod = await ensureWasm();
  const fn = pickThumbDecoder(mod, name);
  // Positional look args (see src/lib.rs / web/worker.js RAW_NEUTRAL). WB NaN =
  // use each file's metadata white balance (constant for a locked time-lapse).
  const r = fn(bytes, OUT_THUMB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  let w, h, orientation, wbR, wbB, renderer;
  try {
    w = r.thumb_w; h = r.thumb_h; orientation = r.orientation;
    wbR = r.wb_r_used; wbB = r.wb_b_used;
    renderer = r.take_thumb_renderer();
  } finally { r.free(); }
  try {
    const rgb = renderer.render_look({
      wbR, wbB, exposureEv: 0, contrast: 0, highlights: 0, shadows: 0,
      whites: 0, blacks: 0, saturation: 0, vibrance: 0, temp: 0, tint: 0,
      texture: 0, clarity: 0,
    });
    return { rgb, w, h, orientation };
  } finally { renderer.free(); }
}
/** Nearest-neighbour downsample straight into a small canvas (no full-size
 *  intermediate canvas), applying the EXIF orientation (1..8) while sampling.
 *  `w`/`h` are the sensor-orientation dims of `rgb`. */
function drawThumb(canvas, rgb, w, h, orientation = 1) {
  const ori = (orientation >= 1 && orientation <= 8) ? orientation : 1;
  const swap = ori >= 5;
  const fx = ori === 2 || ori === 3 || ori === 7 || ori === 8;
  const fy = ori === 3 || ori === 4 || ori === 6 || ori === 7;
  const dispW = swap ? h : w, dispH = swap ? w : h;
  const scale = Math.min(1, THUMB_EDGE / Math.max(dispW, dispH));
  const tw = Math.max(1, Math.round(dispW * scale));
  const th = Math.max(1, Math.round(dispH * scale));
  canvas.width = tw; canvas.height = th;
  const img = new ImageData(tw, th);
  const d = img.data;
  for (let y = 0; y < th; y++) {
    const dy = Math.min(dispH - 1, (y / scale) | 0);
    for (let x = 0; x < tw; x++) {
      const dx = Math.min(dispW - 1, (x / scale) | 0);
      let sx = swap ? dy : dx, sy = swap ? dx : dy;
      if (fx) sx = w - 1 - sx;
      if (fy) sy = h - 1 - sy;
      const si = (sy * w + sx) * 3;
      const di = (y * tw + x) * 4;
      d[di] = rgb[si]; d[di + 1] = rgb[si + 1]; d[di + 2] = rgb[si + 2]; d[di + 3] = 255;
    }
  }
  canvas.getContext('2d').putImageData(img, 0, 0);
}

const basename = (p) => String(p || '').split(/[\\/]/).pop() || String(p || '');
const COLL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class TimelapseStudio {
  constructor() {
    this.items = [];       // { name, path|null, file|null, selected, look }
    this.lb = null;        // embedded CasvLightbox (lazy)
    this.lastOutput = null;
    this.el = {};
    this._cancelToken = null; // active cancel token for in-progress encodes
  }

  mount(doc = document) {
    const $ = (id) => doc.getElementById(id);
    this.el = {
      hostBadge: $('hostBadge'), fileInput: $('fileInput'), pickNative: $('pickNative'),
      clearFiles: $('clearFiles'), fileCount: $('fileCount'), strip: $('strip'),
      fps: $('fps'), fpsVal: $('fpsVal'), preset: $('preset'), dim: $('dim'), gop: $('gop'),
      presetHint: $('presetHint'), encodeGo: $('encodeGo'), encodeStatus: $('encodeStatus'),
      progressWrap: $('progressWrap'), bar: $('bar'), progressLabel: $('progressLabel'),
      nativeNote: $('nativeNote'), cli: $('cli'),
      loadIntoPlayer: $('loadIntoPlayer'), player: $('player'),
    };

    const tauri = isTauri();
    this.el.hostBadge.textContent = tauri ? 'tauri (desktop)' : 'browser';
    if (tauri) this.el.pickNative.hidden = false;

    this.el.fileInput.addEventListener('change', (e) => this._addFiles([...(e.target.files || [])]));
    this.el.pickNative.addEventListener('click', () => this._addNative());
    this.el.clearFiles.addEventListener('click', () => this._clear());
    this.el.fps.addEventListener('input', () => { this.el.fpsVal.textContent = this.el.fps.value; this._refresh(); });
    for (const k of ['preset', 'dim', 'gop']) this.el[k].addEventListener('change', () => this._refresh());
    this.el.encodeGo.addEventListener('click', () => this._encode());
    this.el.loadIntoPlayer.addEventListener('click', () => this._loadIntoPlayer());

    this._refresh();
  }

  // ── options ────────────────────────────────────────────────────────────────
  _form() {
    const p = PRESETS[this.el.preset.value] || PRESETS.balanced;
    return {
      rate: p.rate, distance: p.distance, effort: p.effort, skip: p.skip, tile: p.tile,
      gop: Number(this.el.gop.value) || 24,
      fpsNum: Number(this.el.fps.value) || 24, fpsDen: 1,
      dim: this.el.dim.value,
    };
  }

  // ── files ────────────────────────────────────────────────────────────────
  _addFiles(files) {
    for (const f of files) {
      if (!isRawName(f.name)) continue;
      // All newly-added files are selected by default; look is empty (neutral).
      this.items.push({ name: f.name, path: null, file: f, selected: true, look: {} });
    }
    this._sortItems();
    this._refresh();
    this._renderStrip();
  }
  async _addNative() {
    try {
      const paths = await pickNativeRawPaths();
      for (const p of paths) {
        if (!isRawName(p)) continue;
        this.items.push({ name: basename(p), path: p, file: null, selected: true, look: {} });
      }
      this._sortItems();
      this._refresh();
      this._renderStrip();
    } catch (e) {
      this._status('Native picker failed: ' + (e?.message || e));
    }
  }
  _clear() {
    this.items = [];
    this.el.fileInput.value = '';
    this._refresh();
    this._renderStrip();
  }
  _sortItems() {
    // Sort by basename, numeric-aware, matching the Rust source order.
    this.items.sort((a, b) => COLL.compare(a.name, b.name));
    // De-dupe by path (native) or name (browser).
    const seen = new Set();
    this.items = this.items.filter((it) => {
      const k = it.path || it.name;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  // ── strip render + lazy thumbnail decode ───────────────────────────────────
  _renderStrip() {
    const strip = this.el.strip;
    strip.innerHTML = '';
    this.items.forEach((it, i) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const eager = i < THUMB_LIMIT;
      tile.innerHTML =
        `<div class="ph">${eager ? 'decoding…' : 'preview capped'}</div>` +
        `<div class="nm" title="${it.name}">${it.name}</div>`;
      strip.appendChild(tile);
      it._tile = tile;
    });
    this._decodeQueue(this.items.filter((_, i) => i < THUMB_LIMIT));
  }
  async _decodeQueue(items) {
    for (const it of items) {
      try {
        const bytes = await this._itemBytes(it);
        if (!bytes) throw new Error('no bytes (native preview needs the Tauri fs plugin)');
        const { rgb, w, h, orientation } = await decodeRawThumb(bytes, it.name);
        const canvas = document.createElement('canvas');
        drawThumb(canvas, rgb, w, h, orientation);
        const ph = it._tile?.querySelector('.ph');
        if (ph) ph.replaceWith(canvas);
      } catch (e) {
        const ph = it._tile?.querySelector('.ph');
        if (ph) { ph.textContent = 'no preview'; ph.classList.add('warn'); }
        console.warn('[timelapse] thumbnail decode failed for', it.name, e);
      }
      await new Promise((r) => setTimeout(r, 0)); // yield so the strip paints progressively
    }
  }
  async _itemBytes(it) {
    if (it.file) return new Uint8Array(await it.file.arrayBuffer());
    if (it.path) return await readFileBytes(it.path); // Tauri fs plugin
    return null;
  }

  // ── refresh derived UI ─────────────────────────────────────────────────────
  _refresh() {
    const n = this.items.length;
    const hasPaths = n > 0 && this.items.every((it) => it.path);
    this.el.fileCount.textContent = n
      ? `${n} file${n === 1 ? '' : 's'} · sorted` : 'no files selected';
    this.el.clearFiles.disabled = n === 0;

    const p = PRESETS[this.el.preset.value] || PRESETS.balanced;
    this.el.presetHint.textContent = p.hint || '';

    // CLI preview (uses names when absolute paths aren't available, e.g. browser).
    try {
      const inputPaths = this.items.map((it) => it.path || it.name);
      if (inputPaths.length) {
        const req = buildRawEncodeRequest({ inputPaths, ...this._form() });
        this.el.cli.textContent = rawFramesCliString(req, req.outputName);
      } else {
        this.el.cli.textContent =
          'casv_encode --raw-frames <out.casv> <fps> 1 <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim> <file...>';
      }
    } catch (_) { /* NO_INPUT etc. — leave the template */ }

    // Encode button + note. Browser: in-page FableBraid **lossless** encode (no
    // sidecar) → downloads the .casv. Tauri: the native casv_encode sidecar (all tiers).
    const tauri = isTauri();
    this.el.encodeGo.disabled = tauri ? !hasPaths : (n === 0);
    if (!tauri) {
      this.el.nativeNote.innerHTML = n === 0
        ? 'Add RAW files to encode.'
        : 'Browser mode encodes a <b>lossless FableBraid</b> time-lapse in-page (no sidecar) ' +
          'and downloads the <code>.casv</code>. The lossy libjxl tiers (rate / effort / ' +
          'distance) are native-only — open the desktop app or run the command above for those.';
    } else if (n === 0) {
      this.el.nativeNote.textContent = 'Add RAW files to encode.';
    } else if (!hasPaths) {
      this.el.nativeNote.innerHTML =
        'Use <b>Add RAW files (native picker)</b> so the encoder gets absolute paths ' +
        '(files added via the in-page picker have no filesystem path the sidecar can read).';
    } else {
      this.el.nativeNote.textContent = '';
    }
  }

  _status(msg) { this.el.encodeStatus.textContent = msg || ''; }

  // ── encode (Tauri sidecar) ─────────────────────────────────────────────────
  async _encode() {
    if (!isTauri()) { return this._encodeInBrowser(); }
    // Tauri path: respect the selected scope — only selected items with paths.
    const selectedItems = filterSelectedAssets(
      this.items.map((it) => ({ ...it, selected: it.selected !== false })),
    );
    const paths = selectedItems.map((it) => it.path).filter(Boolean);
    if (!paths.length || paths.length !== selectedItems.length) {
      this._status('Add files via the native picker so the sidecar gets absolute paths.');
      return;
    }
    let req;
    try { req = buildRawEncodeRequest({ inputPaths: paths, ...this._form() }); }
    catch (e) { this._status(e.message); return; }

    this.el.encodeGo.disabled = true;
    this._progress({ stage: 'starting', done: 0, total: 0 });
    this.el.progressWrap.hidden = false;
    let unlisten = () => {};
    try {
      unlisten = await onEncodeProgress((p) => this._progress(p));
      // The desktop app registers `encode_casv_timelapse(request)`; it must spawn
      //   casv_encode <rawFramesSidecarArgs(request, outPath)>
      // (choosing outPath via a save dialog seeded with request.outputName) and
      // relay CASVENC stderr lines as `casv-encode-progress` events — the same
      // plumbing as the existing `encode_casv_video` command (TAURI_WIRING.md).
      const outPath = await tauriInvoke('encode_casv_timelapse', { request: req });
      this.lastOutput = outPath;
      this._status('Encoded → ' + outPath);
      this._progress({ stage: 'done', done: 1, total: 1 });
      await this._openOutput(outPath);
    } catch (e) {
      this._status('Encode failed: ' + (e?.message || e));
      this.el.nativeNote.innerHTML =
        'The desktop app must register an <code>encode_casv_timelapse</code> command ' +
        'that spawns the sidecar with the argv shown above ' +
        '(<code>rawFramesSidecarArgs</code>). See <code>web/casv-lightbox/TAURI_WIRING.md</code>.';
      this.el.progressWrap.hidden = true;
    } finally {
      try { unlisten && unlisten(); } catch (_) { /* ignore */ }
      this.el.encodeGo.disabled = false;
    }
  }
  // ── encode (in-browser, no sidecar): FableBraid lossless → download .casv ────
  //
  // Uses the selected-asset scope (filterSelectedAssets), sequential reads
  // (buildSequentialFrames), a memory budget, cancellation, and per-asset
  // look edits (applyLookToDecodeArgs) — all wired from timelapse-core.js.
  async _encodeInBrowser() {
    // Respect the selected scope: only encode selected assets.
    const selectedItems = filterSelectedAssets(
      this.items.map((it) => ({ ...it, selected: it.selected !== false })),
    );
    if (!selectedItems.length) { this._status('Add RAW files to encode (or select some).'); return; }
    const form = this._form();
    this.el.encodeGo.disabled = true;
    this.el.progressWrap.hidden = false;
    this._progress({ stage: 'decoding', done: 0, total: selectedItems.length });

    // Create a fresh cancel token; expose cancel to the stop button (future).
    const tok = makeTimelapseCancelToken();
    this._cancelToken = tok;

    try {
      const mod = await ensureWasm();
      if (typeof mod.FableVideoEncoder !== 'function') {
        throw new Error('this web/pkg has no FableVideoEncoder — rebuild with build-parallel-wasm.ps1');
      }

      // Memory budget: ~80 MB per 20 MP frame; we allow 2 frames in-flight.
      const BUDGET_BYTES = 160 * 1024 * 1024;

      // Sequential decode: one frame at a time via the core generator.
      const readBytes = (card) => this._itemBytes(card);
      let encResult = null;
      let encodedCount = 0;
      const fpsNum = form.fpsNum;
      const fpsDen = form.fpsDen;
      const gop = form.gop;

      // Stream: decode one frame, push it to the encoder, drop the RGB — the
      // pattern timelapse-core.js encodeFableTimelapse already uses. Buffering
      // every decoded frame first held N×~60 MB (a 100-frame 20 MP timelapse
      // ≈ 6 GB → guaranteed tab crash); streaming peaks at ~1 frame.
      // The generator yields one { assetId, name, bytes, look } at a time.
      let enc = null;
      try {
        for await (const frame of buildSequentialFrames(selectedItems, readBytes, {
          isCancelled: tok.isCancelled,
          maxBytesInFlight: BUDGET_BYTES,
        })) {
          if (tok.isCancelled()) break;
          // Apply per-asset look edits via the look → decode-args mapping.
          const lookArgs = applyLookToDecodeArgs(frame.look || {});
          // For FableBraid (lossless), we decode with the per-asset look then push
          // to the encoder, passing the look args so edits are baked into the
          // lossless frame. (Thumbnails use the cheaper OUT_THUMB decodeRawThumb.)
          const fn = (() => {
            switch ((frame.name.toLowerCase().match(/\.([^.]+)$/) || [])[1]) {
              case 'orf': return mod.process_orf;
              case 'dng': return mod.process_dng;
              case 'cr2': return mod.process_cr2;
              default: throw new Error('unsupported RAW: ' + frame.name);
            }
          })();
          const r = fn(frame.bytes, ...lookArgs);
          // Read width/height BEFORE freeing: the WASM getters dereference the
          // ProcessResult pointer, so touching r.width/r.height after r.free()
          // reads freed memory and throws. Mirror decodeRawNeutralRgb: read all
          // fields inside the try, then free.
          let w, h, rgb;
          try { w = r.width; h = r.height; rgb = r.take_rgb(); } finally { r.free(); }
          // Dims are known at the first frame; encoder push order is identical
          // to the old buffer-then-encode loop, so the .casv bytes are unchanged.
          if (!enc) enc = new mod.FableVideoEncoder(w, h, fpsNum, fpsDen, gop);
          enc.push_rgb8(rgb); // rgb is never retained
          encodedCount++;
          this._progress({ stage: 'encoding', done: encodedCount, total: selectedItems.length });
        }

        if (tok.isCancelled()) {
          this._status('Encode cancelled.');
          this.el.progressWrap.hidden = true;
          return;
        }

        if (!encodedCount) throw new Error('no frames could be read');

        encResult = enc.finish();
        enc = null;
      } finally {
        if (enc) { try { enc.free(); } catch (_) {} }
      }

      const name = suggestTimelapseName(selectedItems.map((it) => it.name));
      this._downloadCasv(encResult, name);
      this.lastOutput = name;
      const mb = (encResult.length / 1e6).toFixed(1);
      this._status(`Encoded ${encodedCount} frames → ${name} (${mb} MB, lossless FableBraid)`);
      this._progress({ stage: 'done', done: encodedCount, total: encodedCount });
      // Best-effort preview in the embedded player.
      try {
        const lb = await this._ensurePlayer();
        await lb.loadBytes(encResult, name);
      } catch (e) { console.warn('[timelapse] player preview failed:', e); }
    } catch (e) {
      this._status('In-browser encode failed: ' + (e?.message || e));
      this.el.progressWrap.hidden = true;
    } finally {
      this.el.encodeGo.disabled = false;
      if (this._cancelToken === tok) this._cancelToken = null;
    }
  }

  /** Trigger a browser download of the encoded .casv bytes. */
  _downloadCasv(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'timelapse.casv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _progress({ stage, done, total }) {
    const bar = this.el.bar;
    const fill = bar.querySelector('i');
    if (total > 0) {
      bar.classList.remove('indet');
      fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
      this.el.progressLabel.textContent = `${stage} · ${done} / ${total}`;
    } else {
      bar.classList.add('indet');
      this.el.progressLabel.textContent = `${stage}${done ? ' · ' + done : ''}…`;
    }
  }

  // ── embedded player ────────────────────────────────────────────────────────
  async _ensurePlayer() {
    if (this.lb) return this.lb;
    const { CasvLightbox } = await import('./casv-lightbox/casv-lightbox.js');
    this.lb = new CasvLightbox(this.el.player);
    this.lb.mount();
    return this.lb;
  }
  async _loadIntoPlayer() {
    const f = await pickCasvFile();
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const lb = await this._ensurePlayer();
      await lb.loadBytes(bytes, f.name);
    } catch (e) {
      this._status('Player load failed: ' + (e?.message || e));
    }
  }
  async _openOutput(path) {
    try {
      const bytes = await readFileBytes(path);
      const lb = await this._ensurePlayer();
      await lb.loadBytes(bytes, basename(path));
    } catch (e) {
      // Not fatal: the file is on disk; the user can still open it manually.
      console.warn('[timelapse] auto-open in player failed:', e);
    }
  }
}
