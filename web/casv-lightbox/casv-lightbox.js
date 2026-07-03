// casv-lightbox — a CASAVA (.casv) video lightbox for showcasing citizen-science
// video: file-picker, playback (I/P·bbox/tile REPLACE frames via casv-web),
// per-frame metadata, encode options, and export.
//
// Host-agnostic: decode + showcase + export work in a plain browser; native
// encode and save-to-disk light up under Tauri (see casv-platform.js).
//
// Usage:
//   import { CasvLightbox } from './casv-lightbox.js';
//   const lb = new CasvLightbox(document.getElementById('root'));
//   lb.mount();

import { CasvReader, playCasv } from '@casabio/casv-web';
import {
  PRESETS, frameKindLabel, formatRate, fpsOf, timecode,
  suggestExportName, buildEncodeRequest,
} from './casv-lightbox-core.js';
import {
  isTauri, makeBrowserJxlDecoder, pickCasvFile,
  pickImagesToEncode, encodeAndSave, exportCasv,
} from './casv-platform.js';

const PLAY = '▶', PAUSE = '⏸';

export class CasvLightbox {
  constructor(root) {
    this.root = root;
    this.decodeJxl = makeBrowserJxlDecoder();
    this.reader = null;        // CasvReader
    this.frames = [];          // decoded { rgba, width, height }
    this.entries = [];         // per-frame container metadata
    this.rate = null;
    this.header = null;
    this.index = 0;
    this.playing = false;
    this.loop = true;
    this.speed = 1;
    this.rafId = 0;
    this.lastTs = 0;
    this.acc = 0;
    this.loadedBytes = null;   // for export
    this.loadedName = null;
    this.encodeInputs = [];    // picked image paths (Tauri)
    this.el = {};
    this.audioCtx  = null;   // AudioContext
    this.audioBuf  = null;   // AudioBuffer (decoded Ogg/Opus)
    this.audioSrc  = null;   // current AudioBufferSourceNode
    this.gainNode  = null;   // GainNode for volume
  }

  mount() {
    this.root.classList.add('casv-lb');
    this.root.innerHTML = TEMPLATE;
    const $ = (id) => this.root.querySelector(`[data-el="${id}"]`);
    this.el = {
      open: $('open'), export: $('export'), encodeToggle: $('encodeToggle'),
      canvas: $('canvas'), stage: $('stage'), status: $('status'),
      play: $('play'), prev: $('prev'), next: $('next'), first: $('first'), last: $('last'),
      scrub: $('scrub'), counter: $('counter'), tc: $('tc'),
      speed: $('speed'), loop: $('loop'), vol: $('vol'), volRange: $('volRange'),
      meta: $('meta'), kind: $('kind'),
      encodePanel: $('encodePanel'), preset: $('preset'),
      distance: $('distance'), effort: $('effort'), gop: $('gop'),
      skip: $('skip'), tile: $('tile'), thresh: $('thresh'),
      fpsNum: $('fpsNum'), fpsDen: $('fpsDen'),
      pickImages: $('pickImages'), encodeGo: $('encodeGo'), encodeInputs: $('encodeInputs'),
      hostBadge: $('hostBadge'),
    };
    this.ctx = this.el.canvas.getContext('2d');
    this._wire();
    this._applyPreset('balanced');
    this._reflectHost();
    this._setStatus('Open a .casv file to begin.');
    this._renderControls();
    return this;
  }

  _reflectHost() {
    const tauri = isTauri();
    this.el.hostBadge.textContent = tauri ? 'desktop (Tauri): encode + save enabled'
      : 'browser: decode / showcase / export';
    this.el.hostBadge.dataset.host = tauri ? 'tauri' : 'browser';
    // Encoding is native-only; disable the "Encode & Save" action in-browser.
    this.el.encodeGo.disabled = !tauri;
    this.el.pickImages.disabled = !tauri;
    if (!tauri) {
      this.el.encodeGo.title = 'Encoding requires the desktop app (native codec).';
      this.el.pickImages.title = this.el.encodeGo.title;
    }
  }

  _wire() {
    this.el.open.addEventListener('click', () => this._onOpen());
    this.el.export.addEventListener('click', () => this._onExport());
    this.el.encodeToggle.addEventListener('click', () => {
      const open = this.el.encodePanel.hidden;
      this.el.encodePanel.hidden = !open;
      this.el.encodeToggle.setAttribute('aria-expanded', String(open));
    });
    this.el.play.addEventListener('click', () => this._togglePlay());
    this.el.prev.addEventListener('click', () => this._step(-1));
    this.el.next.addEventListener('click', () => this._step(1));
    this.el.first.addEventListener('click', () => this._seek(0));
    this.el.last.addEventListener('click', () => this._seek(this.frames.length - 1));
    this.el.scrub.addEventListener('input', () => this._seek(Number(this.el.scrub.value)));
    this.el.speed.addEventListener('change', () => { this.speed = Number(this.el.speed.value); });
    this.el.loop.addEventListener('change', () => { this.loop = this.el.loop.checked; });
    if (this.el.volRange) {
      this.el.volRange.addEventListener('input', () => {
        if (this.gainNode) this.gainNode.gain.value = Number(this.el.volRange.value);
      });
    }
    this.el.preset.addEventListener('change', () => this._applyPreset(this.el.preset.value));
    this.el.pickImages.addEventListener('click', () => this._onPickImages());
    this.el.encodeGo.addEventListener('click', () => this._onEncode());
    this.root.addEventListener('keydown', (e) => this._onKey(e));
    this.root.tabIndex = 0;
  }

  // ── Loading / decoding ──────────────────────────────────────────────
  async _onOpen() {
    const file = await pickCasvFile();
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.loadBytes(bytes, file.name);
  }

  /** Public: load .casv bytes and decode every frame. */
  async loadBytes(bytes, name) {
    this._pause();
    this.loadedBytes = bytes;
    this.loadedName = name || 'clip.casv';
    this.frames = [];
    this.entries = [];
    try {
      this.reader = CasvReader.parse(bytes);
    } catch (e) {
      this._setStatus(`Not a valid .casv file: ${e.message}`, 'error');
      return;
    }
    this.header = this.reader.header;
    this.rate = this.reader.rate;
    for (let i = 0; i < this.reader.frameCount; i++) this.entries.push(this.reader.entry(i));

    if (this.rate.fable) {
      this._setStatus(
        'This is a FableBraid (lossless) .casv — its braided-rANS codec is native-only; '
        + 'the browser cannot decode it yet. Metadata is shown below.', 'warn');
      this._renderMeta();
      this._renderControls();
      return;
    }

    this._setStatus(`Decoding ${this.reader.frameCount} frames…`);
    try {
      let i = 0;
      for await (const f of playCasv(bytes, this.decodeJxl)) {
        // playCasv reuses no buffer by default → each frame is its own copy.
        this.frames.push({ rgba: f.rgba, width: f.width, height: f.height });
        if ((++i & 7) === 0) this._setStatus(`Decoding… ${i}/${this.reader.frameCount}`);
      }
    } catch (e) {
      this._setStatus(`Decode failed at frame ${this.frames.length}: ${e.message}`, 'error');
      if (this.frames.length === 0) return;
    }
    this.index = 0;

    // Decode embedded Ogg/Opus audio (if CSAU box present).
    this._stopAudio();
    this.audioBuf = null;
    if (this.reader.audio) {
      try {
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        if (this.gainNode) this.gainNode.disconnect();
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.connect(this.audioCtx.destination);
        // decodeAudioData requires a detached ArrayBuffer — .slice() copies it.
        const ab = this.reader.audio.bytes.buffer.slice(
          this.reader.audio.bytes.byteOffset,
          this.reader.audio.bytes.byteOffset + this.reader.audio.bytes.byteLength
        );
        this.audioBuf = await this.audioCtx.decodeAudioData(ab);
      } catch (e) {
        console.warn('casv-lightbox: audio decode failed:', e);
        this.audioBuf = null;
      }
    }
    if (this.el.vol) this.el.vol.style.display = this.audioBuf ? '' : 'none';

    this._sizeCanvas();
    this._renderMeta();
    this._renderControls();
    this._render(0);
    this._setStatus(`Loaded ${this.frames.length} frame${this.frames.length === 1 ? '' : 's'} · `
      + `${this.header.width}×${this.header.height} · ${fpsOf(this.header).toFixed(2)} fps · `
      + formatRate(this.rate), 'ok');
  }

  _sizeCanvas() {
    this.el.canvas.width = this.header.width;
    this.el.canvas.height = this.header.height;
  }

  // ── Playback ────────────────────────────────────────────────────────
  _render(i) {
    if (!this.frames.length) return;
    i = Math.max(0, Math.min(this.frames.length - 1, i));
    this.index = i;
    const f = this.frames[i];
    const img = new ImageData(new Uint8ClampedArray(f.rgba.buffer, f.rgba.byteOffset, f.rgba.byteLength), f.width, f.height);
    this.ctx.putImageData(img, 0, 0);
    this.el.scrub.value = String(i);
    this.el.counter.textContent = `${i + 1} / ${this.frames.length}`;
    this.el.tc.textContent = timecode(i, fpsOf(this.header));
    const e = this.entries[i];
    this.el.kind.textContent = frameKindLabel(e);
    this.el.kind.dataset.kind = e && e.isPFrame ? 'p' : 'i';
  }

  _togglePlay() { this.playing ? this._pause() : this._play(); }

  _play() {
    if (!this.frames.length || this.playing) return;
    this.playing = true;
    this.el.play.textContent = PAUSE;
    this.lastTs = 0;
    this.acc = 0;
    const fps = fpsOf(this.header) || 24;
    const step = (ts) => {
      if (!this.playing) return;
      if (this.lastTs) {
        this.acc += (ts - this.lastTs) * this.speed;
        const frameMs = 1000 / fps;
        while (this.acc >= frameMs) {
          this.acc -= frameMs;
          if (this.index + 1 >= this.frames.length) {
            if (this.loop) this._render(0);
            else { this._pause(); return; }
          } else {
            this._render(this.index + 1);
          }
        }
      }
      this.lastTs = ts;
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);

    // Start audio at the position corresponding to the current frame.
    if (this.audioBuf && this.audioCtx && this.gainNode) {
      const offset = Math.max(0, this.index / fps);
      this.audioSrc = this.audioCtx.createBufferSource();
      this.audioSrc.buffer = this.audioBuf;
      this.audioSrc.connect(this.gainNode);
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      this.audioSrc.start(0, offset);
    }
  }

  _pause() {
    this._stopAudio();
    this.playing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.el.play) this.el.play.textContent = PLAY;
  }

  _step(d) { this._pause(); this._render(this.index + d); }
  _seek(i) { this._stopAudio(); this._pause(); this._render(i); }

  _stopAudio() {
    if (this.audioSrc) {
      try { this.audioSrc.stop(); } catch (_) {}
      this.audioSrc = null;
    }
  }

  _onKey(e) {
    if (!this.frames.length) return;
    if (e.key === ' ') { e.preventDefault(); this._togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this._step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this._step(1); }
    else if (e.key === 'Home') { this._seek(0); }
    else if (e.key === 'End') { this._seek(this.frames.length - 1); }
  }

  _renderControls() {
    const has = this.frames.length > 0;
    for (const k of ['play', 'prev', 'next', 'first', 'last', 'scrub']) {
      if (this.el[k]) this.el[k].disabled = !has;
    }
    this.el.export.disabled = !this.loadedBytes;
    if (this.el.scrub) this.el.scrub.max = String(Math.max(0, this.frames.length - 1));
    if (this.el.vol) this.el.vol.style.display = this.audioBuf ? '' : 'none';
  }

  _renderMeta() {
    const h = this.header, r = this.rate;
    const kinds = this.entries.reduce((m, e) => {
      const k = frameKindLabel(e); m[k] = (m[k] || 0) + 1; return m;
    }, {});
    const kindStr = Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(', ');
    this.el.meta.innerHTML = '';
    const rows = [
      ['Dimensions', `${h.width} × ${h.height}`],
      ['Frames', String(h.frameCount)],
      ['Frame rate', `${fpsOf(h).toFixed(3)} fps (${h.fpsNum}/${h.fpsDen})`],
      ['Rate / tier', formatRate(r)],
      ['Frame kinds', kindStr || '—'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      this.el.meta.append(dt, dd);
    }
  }

  // ── Export ──────────────────────────────────────────────────────────
  async _onExport() {
    if (!this.loadedBytes) return;
    try {
      const name = suggestExportName(this.loadedName);
      const res = await exportCasv(this.loadedBytes, name);
      this._setStatus(res.method === 'download'
        ? `Exported ${name} (download).`
        : `Saved to ${res.path}.`, 'ok');
    } catch (e) {
      this._setStatus(`Export failed: ${e.message}`, 'error');
    }
  }

  // ── Encode (Tauri) ──────────────────────────────────────────────────
  _applyPreset(name) {
    const p = PRESETS[name] || PRESETS.balanced;
    this.el.preset.value = name in PRESETS ? name : 'balanced';
    this.el.distance.value = String(p.distance);
    this.el.effort.value = String(p.effort);
    this.el.skip.value = p.skip;
    this.el.tile.value = String(p.tile);
    this.el.distance.disabled = p.rate === 'lossless';
    this.el.thresh.placeholder = 'auto';
    this._curPreset = name;
  }

  async _onPickImages() {
    try {
      const res = await pickImagesToEncode();
      if (!res.native) {
        this._setStatus('Image picking for encode is a desktop-app feature.', 'warn');
        return;
      }
      this.encodeInputs = res.paths;
      this.el.encodeInputs.textContent = res.paths.length
        ? `${res.paths.length} image${res.paths.length === 1 ? '' : 's'} selected`
        : 'none selected';
    } catch (e) {
      this._setStatus(`Pick failed: ${e.message}`, 'error');
    }
  }

  async _onEncode() {
    const p = PRESETS[this._curPreset] || PRESETS.balanced;
    let request;
    try {
      request = buildEncodeRequest({
        inputPaths: this.encodeInputs,
        rate: p.rate,
        distance: this.el.distance.value,
        effort: this.el.effort.value,
        gop: this.el.gop.value,
        skip: this.el.skip.value,
        tile: this.el.tile.value,
        thresh: this.el.thresh.value,
        fpsNum: this.el.fpsNum.value,
        fpsDen: this.el.fpsDen.value,
      });
    } catch (e) {
      this._setStatus(e.message, 'error');
      return;
    }
    this._setStatus(`Encoding ${request.inputPaths.length} frames (${request.rate})…`);
    try {
      const res = await encodeAndSave(request);
      const path = res && res.path ? res.path : '(saved)';
      this._setStatus(`Encoded and saved to ${path}.`, 'ok');
    } catch (e) {
      this._setStatus(e.code === 'ENCODE_NATIVE_ONLY'
        ? e.message
        : `Encode failed: ${e.message}`, e.code === 'ENCODE_NATIVE_ONLY' ? 'warn' : 'error');
    }
  }

  _setStatus(msg, tone = '') {
    this.el.status.textContent = msg;
    this.el.status.dataset.tone = tone;
  }
}

const TEMPLATE = `
<div class="casv-lb__bar">
  <button data-el="open" class="casv-lb__btn casv-lb__btn--primary">Open .casv…</button>
  <button data-el="export" class="casv-lb__btn" disabled>Export .casv</button>
  <button data-el="encodeToggle" class="casv-lb__btn" aria-expanded="false">Encode…</button>
  <span class="casv-lb__host" data-el="hostBadge"></span>
</div>

<div class="casv-lb__stage" data-el="stage">
  <canvas data-el="canvas" class="casv-lb__canvas" width="16" height="9"></canvas>
</div>

<div class="casv-lb__transport">
  <button data-el="first" class="casv-lb__t" title="First (Home)" disabled>⏮</button>
  <button data-el="prev" class="casv-lb__t" title="Prev (←)" disabled>◀</button>
  <button data-el="play" class="casv-lb__t casv-lb__t--play" title="Play/Pause (Space)" disabled>▶</button>
  <button data-el="next" class="casv-lb__t" title="Next (→)" disabled>▶▶</button>
  <button data-el="last" class="casv-lb__t" title="Last (End)" disabled>⏭</button>
  <input data-el="scrub" class="casv-lb__scrub" type="range" min="0" max="0" value="0" step="1" disabled>
  <span class="casv-lb__counter" data-el="counter">0 / 0</span>
  <span class="casv-lb__tc" data-el="tc">—</span>
  <span class="casv-lb__kind" data-el="kind" data-kind="i">—</span>
  <label class="casv-lb__speed">Speed
    <select data-el="speed">
      <option value="0.25">0.25×</option><option value="0.5">0.5×</option>
      <option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option>
    </select>
  </label>
  <label class="casv-lb__loop"><input data-el="loop" type="checkbox" checked> Loop</label>
  <label class="casv-lb__vol" style="display:none" data-el="vol">Vol
    <input data-el="volRange" type="range" min="0" max="1" step="0.05" value="1">
  </label>
</div>

<div class="casv-lb__status" data-el="status"></div>

<dl class="casv-lb__meta" data-el="meta"></dl>

<div class="casv-lb__encode" data-el="encodePanel" hidden>
  <h3>Encode a .casv <small>(native / desktop)</small></h3>
  <div class="casv-lb__grid">
    <label>Preset
      <select data-el="preset">
        <option value="realtime">Realtime (d2 · e1)</option>
        <option value="balanced" selected>Balanced (d1 · e3)</option>
        <option value="quality">Quality (d0.5 · e4)</option>
        <option value="archive">Lossless archive</option>
      </select>
    </label>
    <label>Distance <input data-el="distance" type="number" step="0.1" min="0.1" max="15" value="1.0"></label>
    <label>Effort <input data-el="effort" type="number" step="1" min="1" max="10" value="3"></label>
    <label>GOP <input data-el="gop" type="number" step="1" min="1" max="600" value="24"></label>
    <label>Skip
      <select data-el="skip">
        <option value="none">none</option>
        <option value="bbox">bbox</option>
        <option value="tile" selected>tile</option>
      </select>
    </label>
    <label>Tile <input data-el="tile" type="number" step="8" min="8" max="512" value="64"></label>
    <label>Threshold <input data-el="thresh" type="number" step="1" min="0" max="255" placeholder="auto"></label>
    <label>FPS num <input data-el="fpsNum" type="number" step="1" min="1" value="24"></label>
    <label>FPS den <input data-el="fpsDen" type="number" step="1" min="1" value="1"></label>
  </div>
  <div class="casv-lb__encode-actions">
    <button data-el="pickImages" class="casv-lb__btn">Pick images…</button>
    <span class="casv-lb__inputs" data-el="encodeInputs">none selected</span>
    <button data-el="encodeGo" class="casv-lb__btn casv-lb__btn--primary">Encode &amp; Save</button>
  </div>
</div>
`;
