/**
 * web/tools/pixel-peep.js — pixel-peep quality compare mode
 *
 * Finding 47 (P4 T8): extracted from main.js to break it out of the static
 * parse graph.  Loaded lazily via makeLazyModule on first button click.
 *
 * Call `initPixelPeep(deps)` once.  It wires the peep button, sets up state,
 * and returns a handle that main.js uses to forward keyboard/click events.
 *
 * The handle exposes:
 *   isActive()         — returns pixelPeepActive (read by event handlers)
 *   exitPixelPeep()    — keyboard Esc / lightbox close click
 *   peepNavPhoto(d)    — ←/→ arrow keys
 *   peepCycleQuality(d)— ↑/↓ arrow keys
 *   updatePeepBadges() — called by zoom handler in main.js
 *
 * deps (all from main.js module scope; no circular static import):
 *   invoke               — Tauri invoke (or undefined)
 *   IS_TAURI             — boolean
 *   pushStat             — (line: string) => void
 *   currentOptions       — () => { quality, lossless, look }
 *   lookToSnake          — (look) => string
 *   lightbox             — HTMLElement
 *   lightboxCanvas       — HTMLCanvasElement
 *   lbSourceBanner       — HTMLElement | null
 *   lbToggleJpegBtn      — HTMLElement | null
 *   lbLoadingBadge       — HTMLElement | null
 *   lbPreviewBadge       — HTMLElement | null
 *   getLightboxIndex     — () => number   (returns lightboxIndex from main.js)
 *   clearLightboxIndex   — () => void     (sets lightboxIndex = -1 in main.js)
 *   cards                — Card[]         (shared array reference)
 *   getLbZoom            — () => number
 *   resetLbViewport      — () => void  — resets zoom/pan/rotation to 1/0/0/0 + applyLbTransform
 *   applyLbTransform     — () => void
 *   captureCleanAndApplyLens — (imageData: ImageData) => void
 *   decodeJxlViaSession  — (url, cb, priority?, options?) => void
 *   AssetStore           — AssetStore class (from packages/asset-store)
 *   onActiveChange       — (active: boolean) => void  — called when pixelPeepActive changes
 */
export function initPixelPeep({
    invoke,
    IS_TAURI,
    pushStat,
    currentOptions,
    lookToSnake,
    lightbox,
    lightboxCanvas,
    lbSourceBanner,
    lbToggleJpegBtn,
    lbLoadingBadge,
    lbPreviewBadge,
    getLightboxIndex,
    clearLightboxIndex,
    cards,
    getLbZoom,
    resetLbViewport,
    applyLbTransform,
    captureCleanAndApplyLens,
    decodeJxlViaSession,
    AssetStore,
    onActiveChange,
}) {
    // ============================================================================
    // Pixel-peep quality compare mode
    // ----------------------------------------------------------------------------
    // Pick N photos.  Queue encodes globally in priority order — q=80 for every
    // photo first (so all show up viewable fastest), then q=75/85, then 70/90/95.
    // Each photo: decode all available qualities; paint the current peepQuality
    // or fallback to nearest-decoded quality so something is always on screen.
    // Lightbox opens at 100% pixels (no fit-to-screen).  Up/Down cycle quality;
    // Left/Right switch photo preserving zoom+pan (tripod compare).  Esc exits.
    // ============================================================================
    // Full ladder: q=50..95 in steps of 5, then lossless JXL (bit-exact for RGB,
    // i.e. visually identical to uncompressed source — just much smaller bytes).
    const PEEP_QUALITIES = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 'lossless'];
    // Encode order: sweet-spot + anchors first so the most informative variants
    // are viewable early.  Tauri semaphore drains the rest in submission order.
    const PEEP_PRIORITY  = [80, 95, 'lossless', 70, 90, 60, 85, 50, 75, 65, 55];
    const PEEP_INITIAL_Q = 80;
    const fmtPeepQ = (q) => typeof q === 'number' ? `q=${q}` : q;
    const PEEP_EFFORT = 3;
    const PEEP_ENCODER_THREADS = 4;
    const PEEP_CONCURRENCY = 3;

    let pixelPeepActive = false;
    let peepPaths = [];
    let peepIdx = 0;
    let peepQuality = PEEP_INITIAL_Q;
    // peepCache: Map<photoIdx, { jxlBytes:{q:Uint8Array}, decoded:{q:{rgba,w,h}}, encodeMs:{q:number}, sizeBytes:{q:number}, doneCount:number }>
    const peepCache = new Map();

    // Bounded LRU over decoded full-res RGBA variants. Without this, the peep cache
    // accumulates one RGBA buffer per (photo × quality) it ever decodes — N photos
    // × up to 11 qualities, each potentially tens of MB — and never frees them, so
    // a long peep session over a folder grows memory without bound. We keep the
    // small jxlBytes/sizeBytes/encodeMs metadata (cheap) but cap the count of heavy
    // decoded RGBA buffers, evicting the least-recently-used. Cap ≈ 2 full quality
    // ladders so the current photo plus a neighbour stay hot; evicted variants are
    // transparently re-decoded from the retained jxlBytes on demand.
    const PEEP_DECODED_LRU_MAX = 24;
    const peepLruKey = (idx, q) => `${idx}:${q}`;
    // S3: govern the decoded-RGBA LRU through AssetStore instead of a bespoke Map.
    // One "unit" per decoded variant (size = 1) + a 24-unit budget reproduces the
    // exact count-capped, insertion-ordered LRU (oldest = victim; touch = promote);
    // the onEvict hook frees the evicted RGBA from its owning peepCache entry so it
    // can be GC'd (transparently re-decoded from the retained jxlBytes on demand).
    // Switching `maxBytes` to a real byte budget later is a one-line change.
    const peepDecodedStore = new AssetStore({
        name: 'peep-decoded',
        maxBytes: PEEP_DECODED_LRU_MAX,
        onEvict: (key) => {
            const sep = key.lastIndexOf(':');
            const oIdx = Number(key.slice(0, sep));
            const oQ = key.slice(sep + 1);
            // PEEP_QUALITIES are numbers except 'lossless'; restore the number type
            // so the delete hits the same key the decoded variant was stored under.
            const qKey = oQ === 'lossless' ? oQ : Number(oQ);
            const oEntry = peepCache.get(oIdx);
            if (oEntry?.decoded) delete oEntry.decoded[qKey];
        },
    });

    // Record a freshly-decoded variant as most-recently-used; the store evicts the
    // LRU victim past the cap (freeing it via onEvict above).
    function peepLruRecord(idx, q) {
        peepDecodedStore.set(peepLruKey(idx, q), true, 1);
    }

    // Mark an already-decoded variant as recently used (e.g. on paint/nav) without
    // inserting one that was never decoded (get() promotes if present, else no-op).
    function peepLruTouch(idx, q) {
        peepDecodedStore.get(peepLruKey(idx, q));
    }

    async function runPixelPeep() {
        if (!IS_TAURI) { pushStat('[peep] tauri-only'); return; }
        let paths;
        try { paths = await invoke('pick_files'); }
        catch (err) { pushStat(`[peep] pick_files failed: ${err}`); return; }
        if (!paths?.length) { pushStat('[peep] cancelled'); return; }

        pixelPeepActive = true;
        onActiveChange?.(true);
        peepPaths = paths;
        peepIdx = 0;
        peepQuality = PEEP_INITIAL_Q;
        peepCache.clear();
        peepDecodedStore.clear();
        // Seed cache entries so .then() callbacks can locate their photo idx.
        for (let i = 0; i < paths.length; i++) {
            peepCache.set(i, { jxlBytes: {}, decoded: {}, encodeMs: {}, sizeBytes: {}, doneCount: 0 });
        }

        await invoke('set_concurrency', { n: PEEP_CONCURRENCY });
        pushStat(`[peep] ${paths.length} photos  ladder=${PEEP_QUALITIES.join('/')}  e=${PEEP_EFFORT} Falcon`);
        pushStat(`[peep] queue order: ${PEEP_PRIORITY.join(' → ')}  (all photos per step)`);
        pushStat(`[peep] note: 'raw' aliases 'lossless' decode (lossless JXL is bit-exact); size shown as uncompressed RGB bytes`);
        pushStat('[peep] keys: ↑/↓ quality · ←/→ photo · Esc exit · wheel zoom · drag pan');

        openPeepLightbox();
        queuePeepEncodes();
    }

    function openPeepLightbox() {
        // Fresh canvas — pixel-peep starts blank until first decode arrives.
        lightboxCanvas.width = 1;
        lightboxCanvas.height = 1;
        // Reset zoom/pan/rotation to 100% pixels (not fit-to-screen).
        // resetLbViewport() sets lbZoom=1/lbPanX=0/lbPanY=0/lbRotation=0 in
        // main.js and calls applyLbTransform() — same as the original inline code.
        resetLbViewport();
        if (lbPreviewBadge) lbPreviewBadge.hidden = true;
        if (lbLoadingBadge) lbLoadingBadge.hidden = false;
        lightbox.hidden = false;
        lightbox.classList.add('peep-mode');
        // Clear stale lightbox state from any prior normal-mode open.
        clearLightboxIndex();
        // lightboxInfo is .lightbox-info inside lightbox (defined in main.js).
        const lightboxInfo = lightbox.querySelector('.lightbox-info');
        if (lightboxInfo) lightboxInfo.innerHTML = '';
        // Source indicators repurposed: show current peep quality, not RAW/JXL/JPEG.
        if (lbSourceBanner) {
            lbSourceBanner.hidden = false;
            lbSourceBanner.setAttribute('data-source', 'peep');
            lbSourceBanner.textContent = fmtPeepQ(peepQuality);
        }
        if (lbToggleJpegBtn) {
            lbToggleJpegBtn.disabled = true;
        }
        updatePeepBadges();
        pushStat(`[peep] open: lightbox.hidden=${lightbox.hidden} canvas=${lightboxCanvas.width}x${lightboxCanvas.height} zoom=${getLbZoom()}`);
    }

    function _fmtMB(bytes) {
        if (bytes == null) return '—';
        const mb = bytes / (1024 * 1024);
        return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
    }

    // Persistent HUD: current quality + compressed JXL bytes + uncompressed RGB
    // bytes (raw reference) + zoom %.  Replaces the old centred fade label.
    function updatePeepBadges() {
        if (!lbSourceBanner) return;
        const entry = peepCache.get(peepIdx);
        const compBytes = entry?.sizeBytes?.[peepQuality];
        // Raw RGB bytes from any decoded variant for this photo — dims are the
        // same for every quality.
        let rawBytes = null;
        if (entry?.decoded) {
            for (const k in entry.decoded) {
                const d = entry.decoded[k];
                if (d?.w && d?.h) { rawBytes = d.w * d.h * 3; break; }
            }
        }
        const compStr = compBytes != null ? _fmtMB(compBytes) : 'loading';
        const rawStr  = rawBytes  != null ? _fmtMB(rawBytes)  : '—';
        const zoomStr = `${Math.round(getLbZoom() * 100)}%`;
        const photoStr = peepPaths.length > 1 ? `  ${peepIdx + 1}/${peepPaths.length}` : '';
        lbSourceBanner.textContent =
            `${fmtPeepQ(peepQuality)}   ${compStr} / raw ${rawStr}   ${zoomStr}${photoStr}`;
        if (lbToggleJpegBtn) lbToggleJpegBtn.textContent = fmtPeepQ(peepQuality);
    }

    // Fire all N×6 encodes in priority order.  Tauri's set_concurrency semaphore
    // queues excess work — order of submission decides what completes first.
    function queuePeepEncodes() {
        for (const q of PEEP_PRIORITY) {
            for (let idx = 0; idx < peepPaths.length; idx++) {
                kickPeepEncode(idx, q);
            }
        }
    }

    function kickPeepEncode(idx, q) {
        const path = peepPaths[idx];
        const baseOpts = currentOptions();
        const isLossless = q === 'lossless';
        const t0 = performance.now();
        invoke('process_file', {
            path,
            options: {
                // Tauri side accepts quality even when lossless=true; libjxl ignores it.
                quality: isLossless ? 100 : q,
                effort: PEEP_EFFORT,
                lossless: isLossless,
                look: lookToSnake(baseOpts.look),
                user_rotation: 0,
                wb_r: null,
                wb_b: null,
                encoder_threads: PEEP_ENCODER_THREADS,
            },
        }).then((result) => {
            if (!pixelPeepActive || !peepCache.has(idx)) return;
            const e = peepCache.get(idx);
            const bytes = new Uint8Array(result.jxl);
            e.jxlBytes[q] = bytes;
            e.encodeMs[q] = performance.now() - t0;
            e.sizeBytes[q] = bytes.byteLength;
            e.doneCount++;
            pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} ready  ${(e.encodeMs[q]/1000).toFixed(2)}s  ${(bytes.byteLength/1024).toFixed(0)} KB`);
            decodePeepQuality(idx, q);
            if (idx === peepIdx) updatePeepBadges();
        }).catch((err) => {
            if (!peepCache.has(idx)) return;
            const e = peepCache.get(idx);
            e.encodeMs[q] = -1;
            e.doneCount++;
            pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} FAILED: ${err}`);
        });
    }

    function decodePeepQuality(idx, q) {
        const entry = peepCache.get(idx);
        if (!entry || !entry.jxlBytes[q] || entry.decoded[q]) return;
        const blob = new Blob([entry.jxlBytes[q]], { type: 'image/jxl' });
        const url = URL.createObjectURL(blob);
        decodeJxlViaSession(url, (msg) => {
            URL.revokeObjectURL(url);
            if (!pixelPeepActive) return;
            if (!peepCache.has(idx)) return;
            if (msg.type === 'decode_error') {
                pushStat(`[peep]   photo ${idx+1} q=${q} decode error: ${msg.error}`);
                return;
            }
            const e = peepCache.get(idx);
            e.decoded[q] = { rgba: msg.rgba, w: msg.w, h: msg.h };
            peepLruRecord(idx, q);
            pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} decoded  ${msg.w}×${msg.h}`);
            if (idx === peepIdx) { paintPeepCurrent(); updatePeepBadges(); }
        });
    }

    // Walk outward from peepQuality to find the nearest decoded variant.
    function pickNearestDecoded(entry, want) {
        if (entry.decoded[want]) return { dec: entry.decoded[want], q: want, fallback: false };
        const idx = PEEP_QUALITIES.indexOf(want);
        for (let d = 1; d < PEEP_QUALITIES.length; d++) {
            const lo = idx - d, hi = idx + d;
            if (hi < PEEP_QUALITIES.length) {
                const q = PEEP_QUALITIES[hi];
                if (entry.decoded[q]) return { dec: entry.decoded[q], q, fallback: true };
            }
            if (lo >= 0) {
                const q = PEEP_QUALITIES[lo];
                if (entry.decoded[q]) return { dec: entry.decoded[q], q, fallback: true };
            }
        }
        return null;
    }

    function paintPeepCurrent() {
        const entry = peepCache.get(peepIdx);
        if (!entry) { if (lbLoadingBadge) lbLoadingBadge.hidden = false; return; }
        const pick = pickNearestDecoded(entry, peepQuality);
        if (!pick) {
            if (entry.jxlBytes[peepQuality]) decodePeepQuality(peepIdx, peepQuality);
            if (lbLoadingBadge) lbLoadingBadge.hidden = false;
            return;
        }
        const { dec, q: paintedQ, fallback } = pick;
        // Painting this variant makes it most-recently-used so navigation back and
        // forth across photos doesn't evict what's currently on screen.
        peepLruTouch(peepIdx, paintedQ);
        try {
            lightboxCanvas.width = dec.w;
            lightboxCanvas.height = dec.h;
            const ctx = lightboxCanvas.getContext('2d');
            // Force fresh ImageData even if rgba is plain Uint8Array (not Clamped).
            const rgba = dec.rgba instanceof Uint8ClampedArray
                ? dec.rgba
                : new Uint8ClampedArray(dec.rgba.buffer, dec.rgba.byteOffset, dec.rgba.byteLength);
            ctx.putImageData(new ImageData(rgba, dec.w, dec.h), 0, 0);
            if (lightboxCanvas.width > 0) {
                captureCleanAndApplyLens(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
            pushStat(`[peep] painted photo ${peepIdx+1} ${fmtPeepQ(paintedQ)}  ${dec.w}×${dec.h}`);
        } catch (err) {
            pushStat(`[peep] PAINT FAILED photo ${peepIdx+1} ${fmtPeepQ(paintedQ)}: ${err?.message || err}`);
            console.error('paintPeepCurrent error', err, dec);
            return;
        }
        if (lbLoadingBadge) lbLoadingBadge.hidden = !fallback;
        applyLbTransform();
        updatePeepBadges();
    }

    function peepNavPhoto(delta) {
        const n = peepPaths.length;
        if (n <= 1) return;
        peepIdx = (peepIdx + delta + n) % n;
        paintPeepCurrent();
        updatePeepBadges();
    }

    function peepCycleQuality(delta) {
        const i = PEEP_QUALITIES.indexOf(peepQuality);
        const ni = (i + delta + PEEP_QUALITIES.length) % PEEP_QUALITIES.length;
        peepQuality = PEEP_QUALITIES[ni];
        const entry = peepCache.get(peepIdx);
        if (entry && !entry.decoded[peepQuality] && entry.jxlBytes[peepQuality]) {
            decodePeepQuality(peepIdx, peepQuality);
        }
        paintPeepCurrent();
        updatePeepBadges();
    }

    function exitPixelPeep() {
        pixelPeepActive = false;
        onActiveChange?.(false);
        peepCache.clear();
        peepDecodedStore.clear();
        peepPaths = [];
        lightbox.hidden = true;
        lightbox.classList.remove('peep-mode');
        if (lbLoadingBadge) lbLoadingBadge.hidden = true;
        pushStat('[peep] exited');
    }

    // Wire the button.
    const peepBtn = document.getElementById('run-pixel-peep');
    if (peepBtn) {
        peepBtn.addEventListener('click', () => {
            peepBtn.disabled = true;
            runPixelPeep().catch(e => pushStat(`[peep] ${e?.message || e}`))
                          .finally(() => { peepBtn.disabled = false; });
        });
    }

    // Return the handle that main.js uses to forward events into this module.
    return {
        /** Whether pixel-peep mode is currently active (read by main.js event handlers). */
        isActive: () => pixelPeepActive,
        exitPixelPeep,
        peepNavPhoto,
        peepCycleQuality,
        updatePeepBadges,
    };
}
