// web/lightbox/pyramid-lightbox.js
// M3 pyramid lightbox component, wired to the S1->S3->S2 image-store refactor.
//
// Architecture (per CLAUDE.md layer map + image-store-image-handling-handoff):
// - ALL manifest + level-byte acquisition is delegated to `imageStore`
//   (createImageStore, web/pyramid-gallery/image-store.js). The lightbox no
//   longer takes getManifest/getLevelBytes as injected params; it calls
//   imageStore.getManifest(imageId) / imageStore.getLevelBytes(contenthash).
// - 8-bit display path: decode a level via ctx.decode (shared scheduler,
//   sourceKey = contenthash for dedupe/monotonic reuse), FilterEngine colour
//   matrix preview on canvas. The 16-bit (HDR) display toggle decodes rgbaf32
//   and renders through the WebGL float pipeline.
// - Tiled levels (level.tiled): a viewport ROI is decoded with decodePyramidRegion
//   in packed rgba16 and rendered with renderRgba16AdjustedToCanvas (WebGL float
//   adjust -> dither -> 8-bit canvas), so we never decode a whole tiled mip.
// - ROI export: exportRoi(...) decodes the crop region in rgba16, runs the
//   WebGL adjust for export, and encodeRgba16(...) produces a 16-bit JXL via the
//   same ctx.encode path the app uses (web/main.js encodeJxlSession).
// - Monotonic level upgrades reuse the shared shouldUpgrade predicate from the
//   pyramid choose-level helper (same one grid-controller uses).
//
// buildColorMatrix (filter-engine) feeds the WebGL 16-bit render + export so the
// HDR path matches the 8-bit FilterEngine preview matrix.

import {
  createFilterEngine,
  LightboxPreset,
  APPROVED_LIGHTBOX_PRESETS,
  ADJUSTMENT_PARAMS,
  buildColorMatrix,
  clampAdjustments,
} from './filter-engine.js';
import {
  renderRgba16AdjustedToCanvas,
  adjustedRgba16ForExport,
  canUseWebGL16,
} from './webgl-pipeline.js';
import { decodePyramidRegion } from '../pyramid-gallery/pyramid-decode.js';
import { chooseLevelForTarget, shouldUpgrade } from '../../packages/jxl-pyramid/dist/choose-level.js';

/**
 * @param {{
 *   ctx: import('@casabio/jxl-session').JxlContext,
 *   cache?: import('@casabio/jxl-cache').JxlCacheBrowser,
 *   galleryBase?: URL | string,
 *   imageStore: { getManifest(imageId: string): Promise<any>; getLevelBytes(contenthash: string): Promise<Uint8Array>; base?: URL },
 *   rootEl?: HTMLElement,
 *   log?: (...args: any[]) => void,
 * }} deps
 */
export function createPyramidLightbox(deps) {
  const {
    ctx,                 // jxl context from createBrowserContext
    cache,               // jxl-cache (optional; level bytes come via imageStore)
    galleryBase,         // gallery base URL (carried for parity / logging)
    imageStore,          // S1: centralized manifest + level acquisition
    rootEl,              // host element (optional; modal is appended to body)
    log = console.log,   // optional
  } = deps;

  if (!ctx || !imageStore || typeof imageStore.getManifest !== 'function' || typeof imageStore.getLevelBytes !== 'function') {
    throw new Error('pyramid-lightbox requires ctx and an imageStore with getManifest/getLevelBytes');
  }
  // Delegate manifest/level acquisition to the store (no injected getManifest/getLevelBytes params).
  const getManifest = (imageId) => imageStore.getManifest(imageId);
  const getLevelBytes = (contenthash) => imageStore.getLevelBytes(contenthash);

  let eng = null;
  let modal = null;
  let canvas = null;
  let histC = null;
  let itemsList = [];
  let currentIdx = 0;
  let item = null;

  const VIEW_W = 600;
  const VIEW_H = 400;

  let zoom = 1.0;
  let panX = 0;
  let panY = 0;
  let levelInfo = null;      // {contenthash, w, h, size, bitsPerSample}
  let levelPixels = null;    // Uint8Clamped (8-bit) or Float32Array (rgbaf32)
  let levelRaw16 = null;     // packed rgba16 Uint8Array for tiled/HDR levels (export source)
  let offscreen = null;      // adjusted level canvas
  let isPanning = false;
  let lastMouse = {x:0, y:0};
  let crossfade = 0;
  let is16bitMode = false;
  let selectMode = false;    // crop-region selection mode
  let cropRect = null;       // selected region in image-space coords { x, y, w, h }
  let cropStart = null;      // drag start point in image-space { x, y } (cleared on mouseup)

  // Current adjustments mirror (for buildColorMatrix on the 16-bit / export path).
  const adjustments = Object.fromEntries(ADJUSTMENT_PARAMS.map((k) => [k, 0]));

  // LRU (monotonic) for 8-bit decoded levels.
  const LRU = new Map();
  const LRU_MAX = 8;
  function lruGet(ch) {
    const h = LRU.get(ch);
    if (h) { h.lastUsed = performance.now(); return h; }
    return null;
  }
  function lruSet(ch, pixels, w, h, sz) {
    if (LRU.has(ch)) LRU.delete(ch);
    LRU.set(ch, {pixels, w, h, lastUsed: performance.now(), size: sz});
    if (LRU.size > LRU_MAX) {
      let oldK = null, oldT = Infinity;
      for (const [k,v] of LRU) if (v.lastUsed < oldT) { oldT = v.lastUsed; oldK = k; }
      if (oldK) LRU.delete(oldK);
    }
  }

  // Internal helper: smallest level whose long edge >= target display size,
  // restricted to the candidate set (bit-depth filtered). Wraps the shared
  // chooseLevelForTarget (which throws on empty / takes a single target arg).
  function pickLevelForTarget(cands, target) {
    if (!cands || cands.length === 0) return null;
    try {
      return chooseLevelForTarget(cands, Math.max(1, Math.round(target)));
    } catch {
      return cands[0] || null;
    }
  }

  // Internal helper: pack a decoded final frame's rgba8 pixels into a tight
  // Uint8ClampedArray for canvas / LRU use.
  function packFramePixels(frame) {
    const px = frame.pixels;
    if (px instanceof Uint8ClampedArray) return px;
    if (px instanceof Uint8Array) return new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
    return new Uint8ClampedArray(px);
  }

  function ensureDOM() {
    if (modal) return;
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:none;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:#111;color:#ddd;padding:8px;border-radius:4px;max-width:96vw;max-height:96vh;overflow:auto;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;font:12px monospace;">
          <button id="plb-close">Close</button>
          <button id="plb-prev">‹</button>
          <span id="plb-title"></span>
          <span id="plb-level"></span>
          <span id="plb-zoom" data-zoom-pct="100" style="margin-left:auto;">100%</span>
          <button id="plb-zoom-out">-</button>
          <button id="plb-zoom-in">+</button>
          <button id="plb-reset-zoom">1:1</button>
          <button id="plb-next">›</button>
          <label style="margin-left:12px;font-size:10px;opacity:0.7;" title="16-bit (M3): decode 16-bit level / ROI -> WebGL float texture + shader colour-matrix (buildColorMatrix) + tone -> Floyd-Steinberg dither -> 8-bit display. Source 16-bit data untouched.">
            <input id="plb-16bit" type="checkbox"> 16-bit (M3)
          </label>
          <button id="plb-select-region" title="Toggle crop-region selection mode (drag to draw)">Select Region</button>
          <button id="plb-export-roi" title="Export selected region (or current viewport) as 16-bit JXL">Export ROI</button>
        </div>
        <canvas id="plb-canvas" width="${VIEW_W}" height="${VIEW_H}" style="border:1px solid #333;image-rendering:pixelated;cursor:grab;"></canvas>
        <canvas id="plb-hist" width="256" height="70" style="border:1px solid #333;display:block;margin-top:4px;"></canvas>
        <div id="plb-presets" style="display:flex;flex-wrap:wrap;gap:2px;margin:4px 0;"></div>
        <div id="plb-sliders"></div>
        <div style="margin-top:4px;">
          <button id="plb-upgrade">Upgrade level (ladder)</button>
          <button id="plb-reset">Reset adjustments</button>
        </div>
      </div>`;

    (rootEl || document.body).appendChild(modal);

    canvas = modal.querySelector('#plb-canvas');
    histC = modal.querySelector('#plb-hist');

    modal.querySelector('#plb-close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };

    // zoom
    modal.querySelector('#plb-zoom-in').onclick = () => changeZoom(1.25);
    modal.querySelector('#plb-zoom-out').onclick = () => changeZoom(0.8);
    modal.querySelector('#plb-reset-zoom').onclick = () => { zoom=1; panX=0; panY=0; redraw(); updateReadouts(); };

    // nav
    const prev = modal.querySelector('#plb-prev');
    const next = modal.querySelector('#plb-next');
    if (prev) prev.onclick = () => navigate(-1);
    if (next) next.onclick = () => navigate(1);

    // 16-bit (M3) toggle
    const sixteen = modal.querySelector('#plb-16bit');
    if (sixteen) {
      sixteen.disabled = false;
      sixteen.onchange = () => {
        is16bitMode = sixteen.checked;
        reloadCurrentLevelForMode().catch(e => console.error('16bit reload', e));
      };
    }

    // export selected region (or current viewport) as a 16-bit JXL
    const exp = modal.querySelector('#plb-export-roi');
    if (exp) exp.onclick = () => { void exportRoi(); };

    // select-region toggle: switches between pan and crop-selection modes
    const selBtn = modal.querySelector('#plb-select-region');
    if (selBtn) selBtn.onclick = () => {
      selectMode = !selectMode;
      selBtn.textContent = selectMode ? 'Cancel Select' : 'Select Region';
      if (canvas) canvas.style.cursor = selectMode ? 'crosshair' : 'grab';
      if (!selectMode) { cropRect = null; cropStart = null; redraw(); }
    };

    // pan / crop-select mouse handlers
    const cvs = canvas;
    cvs.addEventListener('mousedown', (e) => {
      if (selectMode) {
        // start crop-rect drag in image-space
        const {cx, cy} = canvasXY(e);
        cropStart = canvasToImage(cx, cy);
        cropRect = null;
        cvs.style.cursor = 'crosshair';
      } else {
        isPanning = true;
        lastMouse = {x: e.clientX, y: e.clientY};
        cvs.style.cursor = 'grabbing';
      }
    });
    window.addEventListener('mouseup', () => {
      if (selectMode) {
        cropStart = null; // drag complete; cropRect is the finalized selection
        redraw();
      } else {
        isPanning = false;
        if (cvs) cvs.style.cursor = selectMode ? 'crosshair' : 'grab';
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!modal || modal.style.display === 'none') return;
      if (selectMode && cropStart) {
        // update live crop rect as user drags
        const {cx, cy} = canvasXY(e);
        const p = canvasToImage(cx, cy);
        if (p && levelInfo) {
          const lw = levelInfo.w || VIEW_W, lh = levelInfo.h || VIEW_H;
          const x = Math.min(cropStart.x, p.x), y = Math.min(cropStart.y, p.y);
          cropRect = {
            x: Math.round(Math.max(0, x)),
            y: Math.round(Math.max(0, y)),
            w: Math.round(Math.min(lw, Math.abs(p.x - cropStart.x))),
            h: Math.round(Math.min(lh, Math.abs(p.y - cropStart.y))),
          };
        }
        redraw();
        return;
      }
      if (!isPanning) return;
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      panX += dx / zoom;
      panY += dy / zoom;
      lastMouse = {x: e.clientX, y: e.clientY};
      clampPan();
      redraw();
    });
    cvs.addEventListener('dblclick', () => changeZoom(1.5));
    cvs.addEventListener('wheel', (e) => { e.preventDefault(); changeZoom(e.deltaY < 0 ? 1.15 : 1/1.15); }, {passive:false});

    // presets
    const pdiv = modal.querySelector('#plb-presets');
    for (const p of APPROVED_LIGHTBOX_PRESETS) {
      const b = document.createElement('button');
      b.textContent = p; b.style.fontSize = '10px';
      b.onclick = () => setPreset(p);
      pdiv.appendChild(b);
    }

    // sliders
    const sdiv = modal.querySelector('#plb-sliders');
    for (const k of ADJUSTMENT_PARAMS) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;font:11px monospace;';
      row.innerHTML = `<label style="width:70px;">${k}</label><input type="range" min="-100" max="100" step="1" value="0"><span style="width:30px;text-align:right;">0</span>`;
      const inp = row.querySelector('input');
      const val = row.querySelector('span');
      inp.oninput = () => { val.textContent = inp.value; setAdjustment(k, +inp.value); };
      sdiv.appendChild(row);
    }

    modal.querySelector('#plb-reset').onclick = () => {
      eng.reset();
      for (const k of ADJUSTMENT_PARAMS) adjustments[k] = 0;
      sdiv.querySelectorAll('input').forEach(i => { i.value=0; i.nextElementSibling.textContent='0'; });
      reapplyAndRedraw();
    };
    modal.querySelector('#plb-upgrade').onclick = upgradeLevel;

    // keyboard (global while open)
    document.addEventListener('keydown', (e) => {
      if (!modal || modal.style.display === 'none') return;
      if (e.key === 'Escape') close();
      if (e.key === '+' || e.key === '=') changeZoom(1.2);
      if (e.key === '-') changeZoom(1/1.2);
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
      if (zoom > 1) {
        if (e.key === 'ArrowUp') { panY += 20 / zoom; redraw(); }
        if (e.key === 'ArrowDown') { panY -= 20 / zoom; redraw(); }
      }
    });
  }

  function updateReadouts() {
    if (!modal) return;
    const z = modal.querySelector('#plb-zoom');
    if (z) {
      const pct = Math.round(zoom * 100);
      z.textContent = pct + '%';
      z.setAttribute('data-zoom-pct', String(pct)); // live zoom readout attribute
    }
    const l = modal.querySelector('#plb-level');
    if (l && levelInfo) {
      const s = levelInfo.size || Math.max(levelInfo.w || 0, levelInfo.h || 0);
      l.textContent = `L${s}`;
    }
    const t = modal.querySelector('#plb-title');
    if (t) t.textContent = `${(item?.id || '').slice(0,12)} (${currentIdx+1}/${itemsList.length})`;
  }

  // Pick candidate levels for the current display size, restricted to the
  // active bit-depth mode, and (if it would be a monotonic upgrade) load it.
  async function reloadCurrentLevelForMode() {
    if (!item || !levelInfo) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const needed = Math.max(VIEW_W, VIEW_H) * zoom * dpr;
    const cands = candidateLevels();
    const targetLevel = pickLevelForTarget(cands, needed) || cands[0] || levelInfo;
    if (targetLevel) await loadLevel(targetLevel);
  }

  function candidateLevels() {
    let cands = item?.levels || [];
    if (is16bitMode) {
      const has16 = cands.some(l => l.bitsPerSample === 16);
      if (has16) cands = cands.filter(l => l.bitsPerSample === 16 || !l.bitsPerSample);
    } else {
      cands = cands.filter(l => (l.bitsPerSample || 8) === 8);
    }
    if (cands.length === 0) cands = item?.levels || [];
    return cands;
  }

  function clampPan() {
    if (!levelInfo || zoom <= 0) return;
    const imgW = (levelInfo.w || VIEW_W) * zoom;
    const imgH = (levelInfo.h || VIEW_H) * zoom;
    const slack = 80;
    const maxX = Math.max(0, (imgW - VIEW_W)/2 + slack);
    const maxY = Math.max(0, (imgH - VIEW_H)/2 + slack);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  function changeZoom(f) {
    const old = zoom;
    zoom = Math.max(0.1, Math.min(8, zoom * f));
    const cx = VIEW_W/2, cy = VIEW_H/2;
    panX = (panX - cx) * (zoom / old) + cx;
    panY = (panY - cy) * (zoom / old) + cy;
    clampPan();
    updateReadouts();
    redraw();
    maybeAutoUpgrade();
  }

  function maybeAutoUpgrade() {
    if (!item?.levels || !levelInfo) return;
    const needed = Math.max(VIEW_W, VIEW_H) * zoom * ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const cands = candidateLevels();
    const up = pickLevelForTarget(cands, needed);
    // Monotonic: only upgrade to a strictly larger level (shared predicate).
    if (up && up.contenthash !== levelInfo.contenthash && shouldUpgrade(levelInfo, up)) {
      loadLevel(up).catch(()=>{});
    }
  }

  // Viewport region (in level pixel space) currently visible, for tiled ROI decode + export.
  function viewportRegion() {
    if (!levelInfo) return { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
    const lw = levelInfo.w || VIEW_W;
    const lh = levelInfo.h || VIEW_H;
    // Map canvas (0..VIEW) back through pan/zoom to level pixel coords.
    const x0 = Math.max(0, Math.floor((-panX) / zoom + lw / 2 - (VIEW_W / 2) / zoom));
    const y0 = Math.max(0, Math.floor((-panY) / zoom + lh / 2 - (VIEW_H / 2) / zoom));
    const w = Math.min(lw - x0, Math.ceil(VIEW_W / zoom));
    const h = Math.min(lh - y0, Math.ceil(VIEW_H / zoom));
    return { x: x0, y: y0, w: Math.max(1, w), h: Math.max(1, h) };
  }

  async function loadLevel(level) {
    if (!level || !item) return;
    const use16 = is16bitMode;
    log?.(`plb load ${level.size || level.w} ch=${level.contenthash.slice(0,8)} ${use16 ? '16bit' : '8bit'}${level.tiled ? ' tiled' : ''}`);

    const entry = level;
    const bytes = await getLevelBytes(entry.contenthash);
    if (!ctx) throw new Error('no ctx for decode');

    // --- Tiled level: decode only the visible ROI and render it. The bit depth
    // follows the active mode toggle (rgba16 packed bytes drive the WebGL HDR
    // pipeline; rgba8 is the fast preview). Avoids decoding the whole tiled mip. ---
    if (level.tiled) {
      const region = clampRegionToLevel(viewportRegion(), entry);
      const { pixels, width, height } = await decodePyramidRegion(bytes, {
        // rgba16 packed bytes feed renderRgba16AdjustedToCanvas / export.
        format: use16 ? 'rgba16' : 'rgba8',
        region,
      });
      const bits = use16 ? 16 : 8;
      levelRaw16 = use16 ? pixels : null;
      levelPixels = use16 ? pixels : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      levelInfo = {
        contenthash: entry.contenthash,
        w: width,
        h: height,
        size: entry.size || Math.max(entry.w, entry.h),
        bitsPerSample: bits,
        tiled: true,
        region,
      };
      offscreen = document.createElement('canvas');
      offscreen.width = width;
      offscreen.height = height;
      reapplyToOffscreen();
      startCrossfade();
      redraw();
      updateReadouts();
      return;
    }

    // --- Non-tiled: full level decode through the shared scheduler context. ---
    // 8-bit display uses rgba8; the 16-bit HDR display toggle uses rgbaf32 so the
    // WebGL float pipeline gets linear floats. (Tiled ROI export uses rgba16; see above.)
    const format = use16 ? 'rgbaf32' : 'rgba8';
    const session = ctx.decode({
      format,
      sourceKey: entry.contenthash,   // scheduler dedupe / monotonic
      priority: 'visible',
      emitEveryPass: false,
      progressionTarget: 'final'
    });
    await session.push(bytes);
    await session.close();

    let last = null;
    for await (const f of session.frames()) if (f?.pixels) last = f;
    if (!last) return;

    let raw;
    let bits = 8;
    if (use16) {
      raw = last.pixels; // Float32Array 0-1 from rgbaf32
      bits = 16;
    } else {
      raw = packFramePixels(last);
    }
    levelPixels = raw;
    levelRaw16 = null;
    levelInfo = {
      contenthash: entry.contenthash,
      w: last.info?.width || entry.w,
      h: last.info?.height || entry.h,
      size: entry.size || Math.max(entry.w, entry.h),
      bitsPerSample: bits
    };

    offscreen = document.createElement('canvas');
    offscreen.width = levelInfo.w;
    offscreen.height = levelInfo.h;
    reapplyToOffscreen();
    startCrossfade();
    redraw();
    updateReadouts();

    if (!use16) {
      lruSet(entry.contenthash, raw, levelInfo.w, levelInfo.h, levelInfo.size);
    }
  }

  function clampRegionToLevel(region, entry) {
    const lw = entry.w || region.w;
    const lh = entry.h || region.h;
    const x = Math.max(0, Math.min(region.x, Math.max(0, lw - 1)));
    const y = Math.max(0, Math.min(region.y, Math.max(0, lh - 1)));
    return {
      x, y,
      w: Math.max(1, Math.min(region.w, lw - x)),
      h: Math.max(1, Math.min(region.h, lh - y)),
    };
  }

  // Convert a canvas-relative mouse event position to image-space coordinates.
  // Matches the viewportRegion() convention: canvas center (VIEW_W/2, VIEW_H/2) maps to
  // image center (lw/2, lh/2) when panX=panY=0.
  function canvasXY(e) {
    if (!canvas) return {cx: 0, cy: 0};
    const r = canvas.getBoundingClientRect();
    return {cx: e.clientX - r.left, cy: e.clientY - r.top};
  }
  function canvasToImage(cx, cy) {
    if (!levelInfo) return null;
    const lw = levelInfo.w || VIEW_W, lh = levelInfo.h || VIEW_H;
    const ix = lw / 2 + (cx - VIEW_W / 2 - panX) / zoom;
    const iy = lh / 2 + (cy - VIEW_H / 2 - panY) / zoom;
    return {
      x: Math.max(0, Math.min(lw - 1, ix)),
      y: Math.max(0, Math.min(lh - 1, iy)),
    };
  }

  function startCrossfade() {
    crossfade = 1.0;
    const st = performance.now();
    const d = 180;
    const step = () => {
      const t = Math.min(1, (performance.now() - st) / d);
      crossfade = 1 - t;
      redraw();
      if (crossfade > 0.01) requestAnimationFrame(step);
      else { crossfade = 0; redraw(); }
    };
    requestAnimationFrame(step);
  }

  // Build the FilterEngine matrix preview onto the offscreen canvas.
  // 16-bit (rgbaf32 / packed rgba16) -> WebGL float adjust + dither.
  // 8-bit -> FilterEngine.applyToImageData colour matrix.
  function reapplyToOffscreen() {
    if (!offscreen || !levelPixels || !eng) return;

    if (levelInfo && levelInfo.bitsPerSample === 16) {
      // 16-bit HDR path: render via WebGL float pipeline using buildColorMatrix.
      const preset = eng.getPreset();
      const adj = clampAdjustments(adjustments);
      if (levelRaw16 && canUseWebGL16()) {
        // packed rgba16 bytes -> WebGL adjust (matrix from buildColorMatrix) -> dither -> canvas
        renderRgba16AdjustedToCanvas(levelRaw16, levelInfo.w, levelInfo.h, offscreen, preset, adj);
        return;
      }
      // rgbaf32 (or no-webgl) fallback: pack floats to rgba16, then WebGL/CPU adjust.
      const f = levelPixels; // Float32Array 0..1
      const packed = new Uint16Array(levelInfo.w * levelInfo.h * 4);
      for (let i = 0; i < packed.length; i++) {
        packed[i] = Math.min(65535, Math.max(0, Math.round((f[i] ?? 0) * 65535)));
      }
      renderRgba16AdjustedToCanvas(
        new Uint8Array(packed.buffer), levelInfo.w, levelInfo.h, offscreen, preset, adj);
      return;
    }

    // 8-bit colour-matrix preview (FilterEngine). buildColorMatrix gives the same
    // preset/adjustment matrix used by the HDR path, keeping the two consistent.
    const src = new ImageData(new Uint8ClampedArray(levelPixels), offscreen.width, offscreen.height);
    const adj = eng.applyToImageData(src);
    offscreen.getContext('2d').putImageData(adj, 0, 0);
  }

  function reapplyAndRedraw() {
    reapplyToOffscreen();
    redraw();
  }

  function redraw() {
    if (!canvas || !eng || !histC) return;

    const c2 = canvas.getContext('2d', {alpha: true});
    if (!c2) return;
    c2.fillStyle = '#111';
    c2.fillRect(0, 0, VIEW_W, VIEW_H);

    if (offscreen && levelPixels) {
      c2.save();
      c2.translate(panX, panY);
      c2.scale(zoom, zoom);
      if (crossfade > 0) c2.globalAlpha = 1 - crossfade;
      c2.drawImage(offscreen, 0, 0);
      c2.restore();
    }

    // Crop-region overlay: draw dashed rect in canvas space.
    // Uses the same coordinate system as viewportRegion() / canvasToImage():
    //   canvasX = (imgX - lw/2) * zoom + VIEW_W/2 + panX
    if (cropRect && levelInfo) {
      const lw = levelInfo.w || VIEW_W, lh = levelInfo.h || VIEW_H;
      const ccx = (cropRect.x - lw / 2) * zoom + VIEW_W / 2 + panX;
      const ccy = (cropRect.y - lh / 2) * zoom + VIEW_H / 2 + panY;
      c2.save();
      c2.setLineDash([5, 3]);
      c2.strokeStyle = 'rgba(255,220,0,0.9)';
      c2.lineWidth = 1.5;
      c2.strokeRect(ccx, ccy, cropRect.w * zoom, cropRect.h * zoom);
      c2.setLineDash([]);
      c2.restore();
    }

    // visible-screen histogram (readback)
    const h2 = histC.getContext('2d');
    h2.fillStyle = '#111'; h2.fillRect(0,0,256,70);
    try {
      const vid = c2.getImageData(0, 0, VIEW_W, VIEW_H);
      const hst = eng.computeHistogram(vid.data);
      const mv = Math.max(1, ...hst.l);
      h2.strokeStyle = '#0f0'; h2.beginPath();
      for (let x=0; x<256; x++) {
        const y = (hst.l[x] / mv) * 68;
        if (x===0) h2.moveTo(x, 69-y); else h2.lineTo(x, 69-y);
      }
      h2.stroke();
    } catch (e) {
      if (offscreen) {
        const o2 = offscreen.getContext('2d');
        const id = o2.getImageData(0,0,offscreen.width, offscreen.height);
        const hst = eng.computeHistogram(id.data);
        const mv = Math.max(1, ...hst.l);
        h2.strokeStyle = '#0f0'; h2.beginPath();
        for (let x=0; x<256; x++) {
          const y = (hst.l[x] / mv) * 68;
          if (x===0) h2.moveTo(x, 69-y); else h2.lineTo(x, 69-y);
        }
        h2.stroke();
      }
    }

    updateReadouts();
  }

  async function upgradeLevel() {
    if (!item?.levels?.length || !levelInfo) return;
    const need = Math.max(VIEW_W, VIEW_H) * zoom * ((typeof window !== 'undefined' && window.devicePixelRatio) || 1) * 1.1;
    const up = pickLevelForTarget(candidateLevels(), need);
    if (up && up.contenthash !== levelInfo.contenthash && shouldUpgrade(levelInfo, up)) {
      await loadLevel(up);
    }
  }

  function navigate(d) {
    if (!itemsList.length) return;
    const ni = (currentIdx + d + itemsList.length) % itemsList.length;
    if (ni === currentIdx) return;
    levelPixels = null; offscreen = null; levelInfo = null; levelRaw16 = null;
    cropRect = null; cropStart = null;
    open(itemsList, ni);
  }

  async function prefetchNeighbors(list, cidx) {
    if (!list || !ctx) return;
    [-1,1].forEach(dd => {
      const ni = (cidx + dd + list.length) % list.length;
      const niItem = list[ni];
      if (!niItem || ni === cidx) return;
      (async () => {
        let lv = niItem.l0 ? {contenthash: niItem.l0.contenthash, w:niItem.l0.w, h:niItem.l0.h, size: Math.max(niItem.l0.w,niItem.l0.h)} : (niItem.levels && niItem.levels[0]);
        if (!lv || lv.tiled || lruGet(lv.contenthash)) return;
        try {
          const b = await getLevelBytes(lv.contenthash);
          const s = ctx.decode({format:'rgba8', sourceKey:lv.contenthash, priority:'near', emitEveryPass:false, progressionTarget:'final'});
          await s.push(b); await s.close();
          let last = null;
          for await (const f of s.frames()) if (f?.pixels) last = f;
          if (last) {
            const px = packFramePixels(last);
            lruSet(lv.contenthash, px, last.info?.width||lv.w, last.info?.height||lv.h, lv.size||Math.max(lv.w,lv.h));
          }
        } catch(e){}
      })();
    });
  }

  function updateTitle() {
    if (!modal) return;
    const t = modal.querySelector('#plb-title');
    const l = modal.querySelector('#plb-level');
    if (t) t.textContent = `${(item?.id || '').slice(0,12)} (${currentIdx+1}/${itemsList.length})`;
    if (l && levelInfo) {
      const s = levelInfo.size || Math.max(levelInfo.w||0, levelInfo.h||0);
      l.textContent = `L${s}`;
    }
  }

  // Normalize what the gallery hands us. The gallery calls:
  //   open(imageId, { contenthash, w, h, tiled })   (S2 image-store shape)
  // We also still accept open(itemsArray, startIdx) and open(itemObj).
  function normalizeOpenArgs(a, b) {
    if (typeof a === 'string') {
      const l0 = (b && typeof b === 'object') ? b : null;
      const it = { id: a, levels: [] };
      if (l0 && l0.contenthash) {
        it.l0 = { contenthash: l0.contenthash, w: l0.w, h: l0.h, size: Math.max(l0.w || 0, l0.h || 0), tiled: !!l0.tiled };
      }
      return { items: [it], startIdx: 0 };
    }
    if (Array.isArray(a)) return { items: a, startIdx: b | 0 };
    return { items: [a], startIdx: 0 };
  }

  async function open(a, b = 0) {
    ensureDOM();
    const { items, startIdx } = normalizeOpenArgs(a, b);
    itemsList = items;
    currentIdx = startIdx | 0;
    item = itemsList[currentIdx];
    if (!item) return;

    eng = createFilterEngine(LightboxPreset.NONE);
    for (const k of ADJUSTMENT_PARAMS) adjustments[k] = 0;
    zoom = 1; panX = 0; panY = 0; crossfade = 0;
    levelPixels = null; offscreen = null; levelInfo = null; levelRaw16 = null;
    cropRect = null; cropStart = null;

    modal.style.display = 'flex';
    // The modal is appended INTO rootEl (the host, e.g. #pyramid-lightbox), which
    // ships with the `hidden` attribute. Revealing only the inner modal leaves the
    // hidden host at display:none, so un-hide the host too. close() re-hides it.
    if (rootEl) rootEl.removeAttribute('hidden');
    updateTitle();
    const sixteen = modal ? modal.querySelector('#plb-16bit') : null;
    if (sixteen) sixteen.checked = is16bitMode;

    // Acquire the full manifest (levels) via the image store.
    if ((!item.levels || item.levels.length < 2) && item.id) {
      try {
        const m = await getManifest(item.id);
        // Manifest levels carry w/h/contenthash/bitsPerSample/tiled.
        item.levels = (m.levels || item.levels || []).map(l => ({
          ...l,
          size: l.size ?? Math.max(l.w || 0, l.h || 0),
        }));
      } catch (e) { /* manifest may be absent in tests/dev */ }
    }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const tgt = Math.max(VIEW_W, VIEW_H) * dpr;

    let init = null;
    if (item.levels?.length) {
      init = pickLevelForTarget(candidateLevels(), tgt) || item.levels[0];
    } else if (item.l0) {
      init = {contenthash: item.l0.contenthash, w: item.l0.w, h: item.l0.h, size: item.l0.size || Math.max(item.l0.w, item.l0.h), tiled: item.l0.tiled};
    }

    let seeded = false;

    // LRU first (8-bit decoded levels only).
    if (init && !init.tiled && !is16bitMode) {
      const hit = lruGet(init.contenthash);
      if (hit) {
        levelPixels = new Uint8ClampedArray(hit.pixels);
        levelInfo = {contenthash: init.contenthash, w: hit.w, h: hit.h, size: hit.size, bitsPerSample: 8};
        offscreen = document.createElement('canvas');
        offscreen.width = hit.w; offscreen.height = hit.h;
        reapplyToOffscreen();
        seeded = true;
      }
    }

    if (init && !seeded) {
      await loadLevel(init);
    } else if (!seeded) {
      levelPixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
      levelInfo = {w: VIEW_W, h: VIEW_H, size: Math.max(VIEW_W, VIEW_H), contenthash: 'fallback', bitsPerSample: 8};
      offscreen = document.createElement('canvas');
      offscreen.width = VIEW_W; offscreen.height = VIEW_H;
      reapplyToOffscreen();
    }

    redraw();
    updateTitle();

    // prefetch neighbors (dual priority)
    prefetchNeighbors(itemsList, currentIdx);
  }

  function close() {
    if (modal) modal.style.display = 'none';
    if (rootEl) rootEl.setAttribute('hidden', '');
    // keep LRU and last state for monotonicity on re-open
  }

  // --- Public preset / adjustment API used by pyramid-gallery.js + buildSliders ---

  function setPreset(name) {
    if (!eng) eng = createFilterEngine(LightboxPreset.NONE);
    eng.setPreset(name);
    reapplyAndRedraw();
  }

  function setAdjustment(key, value) {
    if (!eng) eng = createFilterEngine(LightboxPreset.NONE);
    if (ADJUSTMENT_PARAMS.includes(key)) {
      adjustments[key] = value;
      eng.setParam(key, value);
    }
    reapplyAndRedraw();
  }

  // --- ROI export: decode the current viewport ROI as rgba16, run the WebGL
  // adjust for export, and encode a 16-bit JXL via the shared ctx.encode path. ---

  /**
   * Encode packed rgba16 pixels to a 16-bit JXL through the shared encode session
   * (same path as web/main.js encodeJxlSession). Returns the encoded Uint8Array.
   * @param {Uint16Array} rgba16  packed RGBA, 4 channels, 16-bit
   * @param {number} width
   * @param {number} height
   * @param {{ quality?: number; effort?: number; lossless?: boolean }} [opts]
   */
  async function encodeRgba16(rgba16, width, height, opts = {}) {
    const lossless = !!opts.lossless;
    const session = ctx.encode({
      format: 'rgba16',
      width,
      height,
      hasAlpha: true,
      distance: lossless ? 0 : null,
      quality: lossless ? null : (opts.quality ?? 90),
      effort: opts.effort ?? 7,
      priority: 'visible',
    });
    const buf = rgba16.buffer.byteLength === rgba16.byteLength
      ? rgba16.buffer
      : rgba16.buffer.slice(rgba16.byteOffset, rgba16.byteOffset + rgba16.byteLength);
    await session.pushPixels(buf);
    await session.finish();
    const parts = [];
    for await (const chunk of session.chunks()) {
      parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    const total = parts.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  /**
   * Export the current viewport ROI as a 16-bit JXL. Decodes the ROI fresh from
   * the level bytes in rgba16 (tiled or whole, via decodePyramidRegion), applies
   * the active preset/adjustments through the WebGL float export path
   * (adjustedRgba16ForExport), and encodes via encodeRgba16.
   * @returns {Promise<{ bytes: Uint8Array, width: number, height: number } | null>}
   */
  async function exportRoi() {
    if (!item || !levelInfo || !levelInfo.contenthash || levelInfo.contenthash === 'fallback') return null;
    // Use the drawn crop rect when set; fall back to the current viewport.
    const rawRegion = (cropRect && cropRect.w > 0 && cropRect.h > 0) ? cropRect : viewportRegion();
    const region = clampRegionToLevel(rawRegion, levelInfo);
    const srcBytes = await getLevelBytes(levelInfo.contenthash);

    // rgba16 ROI decode (region-only; never the whole frame).
    const { pixels, width, height } = await decodePyramidRegion(srcBytes, {
      format: 'rgba16',
      region,
    });

    // Apply current preset + adjustments in WebGL float space -> packed rgba16.
    const preset = eng ? eng.getPreset() : LightboxPreset.NONE;
    const adj = clampAdjustments(adjustments);
    // buildColorMatrix here documents the exact matrix the export path applies.
    void buildColorMatrix(preset, adj);
    const adjusted = adjustedRgba16ForExport(pixels, width, height, preset, adj);

    const bytes = await encodeRgba16(adjusted, width, height, { quality: 95 });
    log?.(`plb exportRoi ${width}x${height} -> ${bytes.byteLength} bytes`);

    // Download the encoded JXL.
    const blob = new Blob([bytes], {type: 'image/jxl'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = item?.id ? String(item.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) : 'image';
    a.download = `${name}-roi-${region.x}x${region.y}+${region.w}x${region.h}.jxl`;
    a.click();
    URL.revokeObjectURL(url);

    return { bytes, width, height };
  }

  // expose API (gallery uses open/close/setPreset/setAdjustment; exportRoi/encodeRgba16 for ROI export)
  return {
    open,
    close,
    setPreset,
    setAdjustment,
    exportRoi,
    encodeRgba16,
    _internal: { /* for debug only */ },
  };
}
