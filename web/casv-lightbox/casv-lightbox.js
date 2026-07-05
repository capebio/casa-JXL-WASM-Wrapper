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
  suggestExportName, buildEncodeRequest, classifyDroppedEncodePaths,
  shouldHandleEncodeDrop, speedToSettings, PROXY_PRESET,
} from './casv-lightbox-core.js';
import {
  isTauri, makeBrowserJxlDecoder, prewarmJxl, pickCasvFile,
  pickImagesToEncode, pickVideoToEncode, openDesktopCasvEncoder,
  encodeAndSave, exportCasv, onEncodeProgress,
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
    this.encodeInputs = [];    // picked image/video paths (Tauri)
    this.encodeSourceKind = 'video';
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
      encodePanel: $('encodePanel'), sourceKind: $('sourceKind'), preset: $('preset'),
      presetHelp: $('presetHelp'), sourceHelp: $('sourceHelp'),
      distance: $('distance'), effort: $('effort'), gop: $('gop'),
      skip: $('skip'), tile: $('tile'), thresh: $('thresh'), dim: $('dim'),
      autoFps: $('autoFps'), fpsNum: $('fpsNum'), fpsDen: $('fpsDen'),
      pickImages: $('pickImages'), encodeGo: $('encodeGo'), encodeInputs: $('encodeInputs'),
      encodeProgress: $('encodeProgress'), encodeBar: $('encodeBar'), encodeProgressLabel: $('encodeProgressLabel'),
      hostBadge: $('hostBadge'),
      consoleWrap: $('consoleWrap'), consoleBody: $('consoleBody'),
      consoleToggle: $('consoleToggle'), consoleClear: $('consoleClear'), consoleCopy: $('consoleCopy'),
    };
    this.ctx = this.el.canvas.getContext('2d');
    // Debug console: tee console.*/errors into an in-panel log so encode/decode
    // progress is visible without opening devtools (esp. on the Tauri desktop app).
    this._initConsole();
    this._log(`lightbox mounted · host: ${isTauri() ? 'tauri (desktop)' : 'browser'}`, 'info');
    // Overlap WASM compile/instantiate with the user picking a file, so the
    // first frame decode starts warm instead of paying cold-start.
    prewarmJxl();
    this._wire();
    this._applyPreset('balanced');
    this._setEncodeSource('video');
    this._reflectHost();
    this._setStatus('Encode MP4/MOV/WEBM to create .casv, or open an existing .casv to preview.');
    this._renderControls();
    return this;
  }

  _reflectHost() {
    const tauri = isTauri();
    this.el.hostBadge.textContent = tauri ? 'desktop (Tauri): encode + save enabled'
      : 'browser: decode / showcase / export';
    this.el.hostBadge.dataset.host = tauri ? 'tauri' : 'browser';
    // Encoding is native-only. Keep source picking clickable in-browser so the
    // user gets an explicit desktop-app message instead of a dead grey button.
    this.el.encodeGo.disabled = !tauri;
    this.el.pickImages.disabled = false;
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
      if (open && !isTauri()) {
        this._setStatus('MP4/MOV/WEBM encoding needs the desktop app. This browser page can preview/export .casv only.', 'warn');
      }
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
    if (this.el.encSpeed) this.el.encSpeed.addEventListener('input', () => this._applySpeed(this.el.encSpeed.value));
    if (this.el.proxyBtn) this.el.proxyBtn.addEventListener('click', () => this._applyProxy());
    this.el.sourceKind.addEventListener('change', () => this._setEncodeSource(this.el.sourceKind.value));
    this.el.autoFps.addEventListener('change', () => this._reflectFpsMode());
    this.el.pickImages.addEventListener('click', () => this._onPickEncodeSource());
    this.el.encodeGo.addEventListener('click', () => this._onEncode());
    if (this.el.consoleToggle) this.el.consoleToggle.addEventListener('click', () => this._toggleConsole());
    if (this.el.consoleClear) this.el.consoleClear.addEventListener('click', () => {
      if (this.el.consoleBody) this.el.consoleBody.textContent = '';
    });
    if (this.el.consoleCopy) this.el.consoleCopy.addEventListener('click', () => this._copyConsole());
    this._wireDesktopEvents();
    this._wireDomDropGuard();
    window.addEventListener('casv-open-encode', () => this._openEncodePanel(true));
    if (location.hash === '#encode') setTimeout(() => this._openEncodePanel(true), 0);
    this.root.addEventListener('keydown', (e) => this._onKey(e));
    this.root.tabIndex = 0;
  }

  _openEncodePanel(pickVideo = false) {
    this.el.encodePanel.hidden = false;
    this.el.encodeToggle.setAttribute('aria-expanded', 'true');
    // Don't wipe an already-picked source: _setEncodeSource() clears
    // encodeInputs. On a cold desktop launch the #encode hash AND the
    // casabio-handoff event both call this — the second must not erase the
    // file the first one picked.
    if (this.encodeSourceKind !== 'video') this._setEncodeSource('video');
    this._setStatus('Pick an MP4/MOV/WEBM source in the desktop dialog.');
    // Auto-open the picker once. The reentrancy guard in _onPickEncodeSource
    // collapses the duplicate handoff+hash triggers into a single dialog, and
    // we skip auto-pick entirely once a file is already chosen.
    if (pickVideo && isTauri() && !this.encodeInputs.length) this._onPickEncodeSource();
  }

  _wireDomDropGuard() {
    const namesFromEvent = (event) => {
      const items = Array.from(event.dataTransfer?.items || []);
      const files = Array.from(event.dataTransfer?.files || []);
      return [
        ...items.map((item) => item.kind === 'file' ? item.getAsFile()?.name : '').filter(Boolean),
        ...files.map((file) => file.name).filter(Boolean),
      ];
    };
    const stopFileDrop = (event) => {
      const names = namesFromEvent(event);
      const hasFiles = Array.from(event.dataTransfer?.types || []).includes('Files');
      if (!hasFiles && !shouldHandleEncodeDrop(names)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'drop' && !isTauri()) {
        openDesktopCasvEncoder();
        this._setStatus('Browser blocked local video paths. Opening the desktop app for MP4/MOV/WEBM encode...', 'warn');
      }
    };
    for (const type of ['dragenter', 'dragover', 'drop']) {
      this.root.addEventListener(type, stopFileDrop);
      window.addEventListener(type, stopFileDrop, true);
    }
  }

  _wireDesktopEvents() {
    const listen = (window.__TAURI__ || {}).event?.listen;
    if (!listen) return;
    listen('tauri://drag-drop', (event) => {
      const payload = event.payload || {};
      const paths = Array.isArray(payload) ? payload : payload.paths ?? [];
      this._useDroppedEncodePaths(paths);
    });
    listen('casabio-handoff', (event) => {
      const raw = String(event.payload || '');
      let url = null;
      try { url = new URL(raw); } catch (_) { return; }
      if (url.protocol !== 'raw-converter-tauri:' || url.hostname !== 'casv-encode') return;
      this._openEncodePanel(true);
    });
  }

  _useDroppedEncodePaths(paths) {
    const picked = classifyDroppedEncodePaths(paths, this.encodeSourceKind);
    if (!picked.inputPaths.length) return;
    this.el.encodePanel.hidden = false;
    this.el.encodeToggle.setAttribute('aria-expanded', 'true');
    this._setEncodeSource(picked.sourceKind);
    this.encodeInputs = picked.inputPaths;
    this.el.encodeInputs.textContent = picked.label;
    this._setStatus(picked.sourceKind === 'video'
      ? `Ready to encode ${picked.label}.`
      : `Ready to encode ${picked.inputPaths.length} images.`);
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
    this.index = 0;
    // Audio is decoded off the first-paint critical path (see _decodeAudio).
    this._stopAudio();
    this.audioBuf = null;
    if (this.el.vol) this.el.vol.style.display = 'none';

    let painted = false;
    let i = 0;
    try {
      for await (const f of playCasv(bytes, this.decodeJxl)) {
        // playCasv reuses no buffer by default → each frame is its own copy.
        this.frames.push({ rgba: f.rgba, width: f.width, height: f.height });
        if (!painted) {
          // Paint frame 0 the instant it's ready — don't wait for the whole clip.
          painted = true;
          this._sizeCanvas();
          this._renderMeta();
          this._renderControls();
          this._render(0);
          // Kick audio decode in the background; ready by the time playback starts.
          if (this.reader.audio) this._decodeAudio();
          // Yield once so the browser actually paints frame 0 before we grind
          // through the remaining decodes.
          await new Promise((r) => requestAnimationFrame(() => r()));
        } else if ((++i & 7) === 0) {
          this._renderControls();  // grow scrub range as frames stream in
          this._setStatus(`Playing · buffering ${this.frames.length}/${this.reader.frameCount}…`);
        }
      }
    } catch (e) {
      this._setStatus(`Decode failed at frame ${this.frames.length}: ${e.message}`, 'error');
      if (this.frames.length === 0) return;
    }

    this._renderControls();
    this._setStatus(`Loaded ${this.frames.length} frame${this.frames.length === 1 ? '' : 's'} · `
      + `${this.header.width}×${this.header.height} · ${fpsOf(this.header).toFixed(2)} fps · `
      + formatRate(this.rate), 'ok');
  }

  /**
   * Decode the embedded Ogg/Opus (CSAU) track off the first-paint critical path.
   * Fire-and-forget: sets this.audioBuf when ready so the next _play() has sound.
   */
  async _decodeAudio() {
    if (!this.reader || !this.reader.audio) return;
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
      if (this.el.vol) this.el.vol.style.display = '';
      this._renderControls();
    } catch (e) {
      console.warn('casv-lightbox: audio decode failed:', e);
      this.audioBuf = null;
    }
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
    if (this.el.presetHelp) this.el.presetHelp.textContent = p.hint || '';
    this._curPreset = name;
  }

  /** One-knob quality↔speed: drives the effort + distance inputs from a 0..100
   *  slider (see speedToSettings). Implies the lossy tier. */
  _applySpeed(speed) {
    const s = speedToSettings(speed);
    if (this._curPreset === 'archive') this._curPreset = 'balanced';
    this.el.distance.value = String(s.distance);
    this.el.effort.value = String(s.effort);
    this.el.thresh.value = '';          // blank = auto from distance
    this.el.distance.disabled = false;
    this.el.preset.value = 'balanced';  // reflect a lossy custom state
    if (this.el.encSpeedHelp) {
      this.el.encSpeedHelp.textContent =
        `effort ${s.effort}, distance ${s.distance} — right = faster & lower quality.`;
    }
    if (this.el.presetHelp) this.el.presetHelp.textContent = 'Custom speed (slider).';
  }

  /** Fast low-res proxy for scrubbing / live editing (PROXY_PRESET): 720p via
   *  the `dim` downscale + fastest effort + coarse distance. Lossy. */
  _applyProxy() {
    const p = PROXY_PRESET;
    if (this._curPreset === 'archive') this._curPreset = 'balanced';
    this.el.distance.value = String(p.distance);
    this.el.effort.value = String(p.effort);
    this.el.skip.value = p.skip;
    this.el.tile.value = String(p.tile);
    this.el.distance.disabled = false;
    this.el.preset.value = 'balanced';
    if (this.encodeSourceKind === 'video' && p.dim) this.el.dim.value = p.dim;
    if (this.el.presetHelp) this.el.presetHelp.textContent = p.hint;
  }

  _setEncodeSource(kind) {
    this.encodeSourceKind = kind === 'images' ? 'images' : 'video';
    this.encodeInputs = [];
    this.el.sourceKind.value = this.encodeSourceKind;
    this.el.pickImages.textContent = this.encodeSourceKind === 'video' ? '3 · Pick video...' : '3 · Pick images...';
    this.el.dim.disabled = this.encodeSourceKind !== 'video';
    this.el.autoFps.disabled = this.encodeSourceKind !== 'video';
    if (this.el.sourceHelp) {
      this.el.sourceHelp.textContent = this.encodeSourceKind === 'video'
        ? 'One movie file. Frame rate and size are read from the video.'
        : 'Many still images, encoded in filename order as frames.';
    }
    this.el.encodeInputs.textContent = 'none selected';
    this._reflectFpsMode();
  }

  _reflectFpsMode() {
    const auto = this.encodeSourceKind === 'video' && this.el.autoFps.checked;
    this.el.fpsNum.disabled = auto;
    this.el.fpsDen.disabled = auto;
  }

  async _onPickEncodeSource() {
    if (this._picking) return;   // one OS file dialog at a time — no double pickers
    this._picking = true;
    try {
      const res = this.encodeSourceKind === 'video'
        ? await pickVideoToEncode()
        : await pickImagesToEncode();
      if (!res.native) {
        openDesktopCasvEncoder();
        this._setStatus('Browser cannot pass local video paths to the encoder. Opening the desktop app...', 'warn');
        return;
      }
      // A cancelled dialog returns no paths — keep the previous selection
      // rather than clobbering it back to "none selected".
      if (!res.paths.length) return;
      this.encodeInputs = res.paths;
      if (this.encodeSourceKind === 'video') {
        this.el.encodeInputs.textContent = res.paths[0].split(/[\\/]/).pop();
      } else {
        this.el.encodeInputs.textContent = `${res.paths.length} image${res.paths.length === 1 ? '' : 's'} selected`;
      }
    } catch (e) {
      this._setStatus(`Pick failed: ${e.message}`, 'error');
    } finally {
      this._picking = false;
    }
  }

  async _onEncode() {
    const p = PRESETS[this._curPreset] || PRESETS.balanced;
    let request;
    try {
      request = buildEncodeRequest({
        sourceKind: this.encodeSourceKind,
        inputPaths: this.encodeInputs,
        rate: p.rate,
        distance: this.el.distance.value,
        effort: this.el.effort.value,
        gop: this.el.gop.value,
        skip: this.el.skip.value,
        tile: this.el.tile.value,
        thresh: this.el.thresh.value,
        dim: this.el.dim.value,
        autoFps: this.el.autoFps.checked,
        fpsNum: this.el.fpsNum.value,
        fpsDen: this.el.fpsDen.value,
      });
    } catch (e) {
      this._setStatus(e.message, 'error');
      return;
    }
    this._setStatus(this.encodeSourceKind === 'video'
      ? `Encoding video (${request.rate})...`
      : `Encoding ${request.inputPaths.length} frames (${request.rate})...`);
    this._log(`encode request: ${JSON.stringify(request)}`, 'info');
    // Diagnose why the bar might never advance: progress needs the Tauri event
    // API present AND the desktop app relaying the sidecar's `CASVENC` lines.
    const evApi = typeof window !== 'undefined' && !!(window.__TAURI__?.event?.listen);
    this._log(`encode start · tauri=${isTauri()} · progress-event-api=${evApi}`, evApi ? 'info' : 'warn');
    if (isTauri() && !evApi) {
      this._log('window.__TAURI__.event.listen missing → progress events cannot arrive; '
        + 'bar stays indeterminate until encode returns (relay unwired — see TAURI_WIRING.md).', 'warn');
    }
    this.el.encodeGo.disabled = true;
    this._showEncodeProgress(true, 'Starting…');
    let gotProgress = 0;
    let lastEvt = 'starting', lastEvtAt = Date.now();
    // Subscribe before invoking so no early progress line is missed.
    let unlisten = await onEncodeProgress((p) => {
      gotProgress++;
      lastEvt = `${p.stage} ${p.done}/${p.total}`;
      lastEvtAt = Date.now();
      this._log(`progress: ${lastEvt}`, 'info');
      this._renderEncodeProgress(p);
    });
    this._log('progress listener attached; invoking encode_casv_video…', 'info');
    const t0 = Date.now();
    // Heartbeat: even with no progress events (relay unwired, or a long ffmpeg
    // extract with no sub-progress) show the encode is still alive and where it
    // last was — so a silent stage isn't mistaken for a freeze.
    const heartbeat = setInterval(() => {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      const since = ((Date.now() - lastEvtAt) / 1000).toFixed(0);
      this._log(`…still encoding · elapsed ${el}s · ${gotProgress} events · last: ${lastEvt} (${since}s ago)`, 'debug');
    }, 3000);
    try {
      const res = await encodeAndSave(request);
      const path = res && res.path ? res.path : '(saved)';
      this._log(`encode_casv_video returned in ${Date.now() - t0} ms · ${gotProgress} progress events · path=${path}`, 'info');
      this._setStatus(`Encoded and saved to ${path}.`, 'ok');
    } catch (e) {
      this._log(`encode threw after ${Date.now() - t0} ms (${gotProgress} progress events): ${this._fmt(e)}`, 'error');
      this._setStatus(e.code === 'ENCODE_NATIVE_ONLY'
        ? e.message
        : `Encode failed: ${e.message}`, e.code === 'ENCODE_NATIVE_ONLY' ? 'warn' : 'error');
    } finally {
      clearInterval(heartbeat);
      if (typeof unlisten === 'function') unlisten();
      this._showEncodeProgress(false);
      this.el.encodeGo.disabled = !isTauri();
    }
  }

  /** Show/hide the encode progress bar; optional starting label. */
  _showEncodeProgress(on, label = '') {
    if (!this.el.encodeProgress) return;
    this.el.encodeProgress.hidden = !on;
    if (on) {
      this.el.encodeBar.style.width = '0%';
      this.el.encodeBar.dataset.indeterminate = '1';
      this.el.encodeProgressLabel.textContent = label;
    }
  }

  /** Translate a { stage, done, total } event into the bar + label. */
  _renderEncodeProgress({ stage, done, total }) {
    if (!this.el.encodeProgress || this.el.encodeProgress.hidden) return;
    let frac = null, label = '';
    if (stage === 'extract') {
      label = 'Extracting frames from video…';
    } else if (stage === 'decode') {
      label = `Reading frame ${done} / ${total}`;
      frac = total ? done / total : null;
    } else if (stage === 'encode') {
      if (total && done >= total) { label = `Encoded ${total} frames · saving…`; frac = 1; }
      else if (total && done > 0) { label = `Encoding frame ${done} / ${total}`; frac = done / total; }
      else { label = `Encoding ${total || ''} frame${total === 1 ? '' : 's'}…`; frac = null; }
    } else {
      label = stage || 'Working…';
    }
    this.el.encodeProgressLabel.textContent = label;
    if (frac == null) {
      this.el.encodeBar.dataset.indeterminate = '1';
    } else {
      delete this.el.encodeBar.dataset.indeterminate;
      this.el.encodeBar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    }
  }

  _setStatus(msg, tone = '') {
    this.el.status.textContent = msg;
    this.el.status.dataset.tone = tone;
    this._log(`status: ${msg}`, tone === 'error' ? 'error' : tone === 'warn' ? 'warn' : 'info');
  }

  // ── Debug console ───────────────────────────────────────────────────
  /** Tee console.* and window errors into the in-panel log (once). */
  _initConsole() {
    if (this._consoleInstalled) return;
    this._consoleInstalled = true;
    const orig = {
      log: console.log.bind(console), info: console.info.bind(console),
      warn: console.warn.bind(console), error: console.error.bind(console),
      debug: (console.debug || console.log).bind(console),
    };
    this._origConsole = orig;
    const tee = (level, fn) => (...args) => {
      try { this._log(args.map((a) => this._fmt(a)).join(' '), level); } catch (_) { /* never break console */ }
      fn(...args);
    };
    console.log = tee('info', orig.log);
    console.info = tee('info', orig.info);
    console.warn = tee('warn', orig.warn);
    console.error = tee('error', orig.error);
    console.debug = tee('debug', orig.debug);
    this._onWinError = (e) =>
      this._log(`window.onerror: ${e.message} @ ${e.filename || '?'}:${e.lineno || 0}`, 'error');
    this._onWinRej = (e) => this._log(`unhandledrejection: ${this._fmt(e.reason)}`, 'error');
    window.addEventListener('error', this._onWinError);
    window.addEventListener('unhandledrejection', this._onWinRej);
  }

  /** Restore the console patch (used by unmount, if any). */
  _teardownConsole() {
    if (!this._consoleInstalled) return;
    Object.assign(console, this._origConsole);
    window.removeEventListener('error', this._onWinError);
    window.removeEventListener('unhandledrejection', this._onWinRej);
    this._consoleInstalled = false;
  }

  _fmt(a) {
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }

  /** Append one line to the console panel (timestamped, level-coloured). */
  _log(msg, level = 'info') {
    const body = this.el && this.el.consoleBody;
    if (!body) return;
    const t = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
    // Autoscroll only if already pinned to the bottom (don't yank the user back
    // while they're scrolled up reading).
    const pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    const line = document.createElement('div');
    line.className = 'casv-lb__log-line';
    line.dataset.level = level;
    line.textContent = `${ts}  ${msg}`;
    body.appendChild(line);
    while (body.childElementCount > 800) body.firstElementChild.remove();
    if (pinned) body.scrollTop = body.scrollHeight;
  }

  _toggleConsole() {
    if (!this.el.consoleWrap) return;
    const collapsed = this.el.consoleWrap.dataset.collapsed === '1';
    this.el.consoleWrap.dataset.collapsed = collapsed ? '0' : '1';
    this.el.consoleToggle.textContent = collapsed ? 'Hide' : 'Show';
  }

  async _copyConsole() {
    if (!this.el.consoleBody) return;
    const text = Array.from(this.el.consoleBody.children).map((n) => n.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this._log('console copied to clipboard', 'info');
    } catch (e) {
      this._log(`copy failed: ${this._fmt(e)}`, 'warn');
    }
  }
}

const TEMPLATE = `
<div class="casv-lb__bar">
  <button data-el="encodeToggle" class="casv-lb__btn casv-lb__btn--primary" aria-expanded="false">Encode MP4/MOV/WEBM...</button>
  <button data-el="open" class="casv-lb__btn">Open .casv...</button>
  <button data-el="export" class="casv-lb__btn" disabled>Export .casv</button>
  <span class="casv-lb__host" data-el="hostBadge"></span>
</div>
<p class="casv-lb__barhint">
  <b>Encode</b> turns a video or image sequence into a <code>.casv</code> (desktop app). &nbsp;
  <b>Open</b> plays an existing <code>.casv</code>. &nbsp;
  <b>Export</b> saves the loaded clip back out.
</p>

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

<div class="casv-lb__console" data-el="consoleWrap" data-collapsed="0">
  <div class="casv-lb__console-bar">
    <span class="casv-lb__console-title">Console</span>
    <button data-el="consoleCopy" class="casv-lb__console-btn" title="Copy log">Copy</button>
    <button data-el="consoleClear" class="casv-lb__console-btn" title="Clear log">Clear</button>
    <button data-el="consoleToggle" class="casv-lb__console-btn" title="Show/hide log">Hide</button>
  </div>
  <div class="casv-lb__console-body" data-el="consoleBody" role="log" aria-live="polite"></div>
</div>

<dl class="casv-lb__meta" data-el="meta"></dl>

<div class="casv-lb__encode" data-el="encodePanel" hidden>
  <h3>Encode MP4/MOV/WEBM to .casv <small>(native / desktop)</small></h3>
  <p class="casv-lb__steps">1. Choose a source &nbsp;→&nbsp; 2. Pick a quality preset &nbsp;→&nbsp; 3. Pick the file &nbsp;→&nbsp; 4. Encode &amp; Save</p>

  <label class="casv-lb__field">1 · What are you encoding?
    <select data-el="sourceKind">
      <option value="video" selected>Video file — MP4 / MOV / WEBM / MKV</option>
      <option value="images">Image sequence — PNG / JPEG / TIFF / EXR / JXL</option>
    </select>
    <span class="casv-lb__help" data-el="sourceHelp"></span>
  </label>

  <label class="casv-lb__field">2 · Quality preset
    <select data-el="preset">
      <option value="realtime">Realtime — fastest, biggest (d2 · e1)</option>
      <option value="balanced" selected>Balanced — recommended (d1 · e3)</option>
      <option value="quality">Quality — slower, sharper (d0.5 · e4)</option>
      <option value="archive">Lossless archive — every pixel kept</option>
    </select>
    <span class="casv-lb__help" data-el="presetHelp"></span>
  </label>

  <label class="casv-lb__field">2b · Encode speed <small>quality ←→ speed</small>
    <input data-el="encSpeed" type="range" min="0" max="100" step="5" value="50">
    <span class="casv-lb__help" data-el="encSpeedHelp">One knob over effort + distance. Right = faster encode, lower quality.</span>
  </label>

  <div class="casv-lb__encode-actions">
    <button data-el="proxyBtn" class="casv-lb__btn" type="button" title="Fast 720p proxy for scrubbing / live editing — re-encode full-res for the final file">&#9889; Preview proxy — 720p, fastest</button>
  </div>

  <details class="casv-lb__adv">
    <summary>Advanced options <span class="casv-lb__advhint">(set by the preset — override only if you know what they do)</span></summary>

    <h4 class="casv-lb__grouph">Quality</h4>
    <div class="casv-lb__grid">
      <label>Distance <small>butteraugli · lower = better</small><input data-el="distance" type="number" step="0.1" min="0.1" max="15" value="1.0"></label>
      <label>Effort <small>1 fast … 10 slow</small><input data-el="effort" type="number" step="1" min="1" max="10" value="3"></label>
    </div>

    <h4 class="casv-lb__grouph">Motion &amp; size</h4>
    <div class="casv-lb__grid">
      <label>GOP <small>keyframe every N frames</small><input data-el="gop" type="number" step="1" min="1" max="600" value="24"></label>
      <label>Skip <small>reuse static regions</small>
        <select data-el="skip">
          <option value="none">none — every frame full</option>
          <option value="bbox">bbox — changed box only</option>
          <option value="tile" selected>tile — changed tiles only</option>
        </select>
      </label>
      <label>Tile <small>pixels</small><input data-el="tile" type="number" step="8" min="8" max="512" value="32"></label>
      <label>Threshold <small>blank = auto</small><input data-el="thresh" type="number" step="1" min="0" max="255" placeholder="auto"></label>
      <label>Max size <small>downscale cap</small>
        <select data-el="dim">
          <option value="exact" selected>Exact — keep source size</option>
          <option value="2160">2160 max</option>
          <option value="1440">1440 max</option>
          <option value="1080">1080 max</option>
          <option value="720">720 max</option>
          <option value="512">512 max</option>
        </select>
      </label>
    </div>

    <h4 class="casv-lb__grouph">Frame rate <small>video only</small></h4>
    <div class="casv-lb__grid">
      <label class="casv-lb__check"><input data-el="autoFps" type="checkbox" checked> Match source FPS</label>
      <label>FPS numerator <input data-el="fpsNum" type="number" step="1" min="1" value="24"></label>
      <label>FPS denominator <input data-el="fpsDen" type="number" step="1" min="1" value="1"></label>
    </div>
  </details>

  <div class="casv-lb__encode-actions">
    <button data-el="pickImages" class="casv-lb__btn">3 · Pick video...</button>
    <span class="casv-lb__inputs" data-el="encodeInputs">none selected</span>
    <button data-el="encodeGo" class="casv-lb__btn casv-lb__btn--primary">4 · Encode &amp; Save</button>
  </div>
  <div class="casv-lb__progress" data-el="encodeProgress" hidden>
    <div class="casv-lb__progress-track"><div class="casv-lb__progress-fill" data-el="encodeBar" data-indeterminate="1"></div></div>
    <span class="casv-lb__progress-label" data-el="encodeProgressLabel">Starting…</span>
  </div>
</div>
`;
