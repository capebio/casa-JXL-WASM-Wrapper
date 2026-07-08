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
function pickDecoder(mod, name) {
  switch ((name.toLowerCase().match(/\.([^.]+)$/) || [])[1]) {
    case 'orf': return mod.process_orf;
    case 'dng': return mod.process_dng;
    case 'cr2': return mod.process_cr2;
    default: throw new Error('unsupported RAW: ' + name);
  }
}
/** Decode a RAW to oriented full-res RGB8 with a neutral look. */
async function decodeRawRgb(bytes, name) {
  const mod = await ensureWasm();
  const fn = pickDecoder(mod, name);
  // Positional look args (see src/lib.rs / web/worker.js RAW_NEUTRAL). WB NaN =
  // use each file's metadata white balance (constant for a locked time-lapse).
  const r = fn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  try {
    return { rgb: r.rgb(), w: r.width, h: r.height };
  } finally { r.free(); }
}
/** Nearest-neighbour downsample straight into a small canvas (no full-size
 *  intermediate canvas for a 20 MP frame). */
function drawThumb(canvas, rgb, w, h) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  canvas.width = tw; canvas.height = th;
  const img = new ImageData(tw, th);
  const d = img.data;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, (y / scale) | 0);
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, (x / scale) | 0);
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
    this.items = [];       // { name, path|null, file|null }
    this.lb = null;        // embedded CasvLightbox (lazy)
    this.lastOutput = null;
    this.el = {};
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
      this.items.push({ name: f.name, path: null, file: f });
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
        this.items.push({ name: basename(p), path: p, file: null });
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
        const { rgb, w, h } = await decodeRawRgb(bytes, it.name);
        const canvas = document.createElement('canvas');
        drawThumb(canvas, rgb, w, h);
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
    const paths = this.items.map((it) => it.path).filter(Boolean);
    if (!paths.length || paths.length !== this.items.length) {
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
  async _encodeInBrowser() {
    const items = this.items.slice();
    if (!items.length) { this._status('Add RAW files to encode.'); return; }
    const form = this._form();
    this.el.encodeGo.disabled = true;
    this.el.progressWrap.hidden = false;
    this._progress({ stage: 'decoding', done: 0, total: items.length });
    try {
      const mod = await ensureWasm();
      if (typeof mod.FableVideoEncoder !== 'function') {
        throw new Error('this web/pkg has no FableVideoEncoder — rebuild with build-parallel-wasm.ps1');
      }
      // Gather frame bytes (in-page File or, on desktop, a filesystem path).
      const frames = [];
      for (const it of items) {
        const bytes = await this._itemBytes(it);
        if (!bytes) throw new Error(`no bytes for ${it.name}`);
        frames.push({ bytes, name: it.name });
      }
      const casv = encodeFableTimelapse(
        mod, frames,
        { fpsNum: form.fpsNum, fpsDen: form.fpsDen, gop: form.gop },
        (done, total) => this._progress({ stage: 'encoding', done, total }),
      );
      const name = suggestTimelapseName(items.map((it) => it.name));
      this._downloadCasv(casv, name);
      this.lastOutput = name;
      const mb = (casv.length / 1e6).toFixed(1);
      this._status(`Encoded ${frames.length} frames → ${name} (${mb} MB, lossless FableBraid)`);
      this._progress({ stage: 'done', done: frames.length, total: frames.length });
      // Best-effort preview in the embedded player.
      try {
        const lb = await this._ensurePlayer();
        await lb.loadBytes(casv, name);
      } catch (e) { console.warn('[timelapse] player preview failed:', e); }
    } catch (e) {
      this._status('In-browser encode failed: ' + (e?.message || e));
      this.el.progressWrap.hidden = true;
    } finally {
      this.el.encodeGo.disabled = false;
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
