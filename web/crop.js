// Crop tool + focal-subject editor.
//
// Two sub-modes share the same overlay layer over the lightbox viewport:
//
//   frame    — single primary crop rectangle. Edits card._crop = {x,y,w,h,ratio}.
//              Coordinates are normalised [0..1] relative to the oriented
//              full-res image so they survive rotation and resolution changes.
//
//   subjects — many small rectangles, each tracked in card._subjects = [...].
//              Drawing a new drag creates a subject; clicking an existing box
//              selects it for editing. Editor panel lists them with label /
//              note / status fields.
//
// State lives on each card object (_crop, _subjects). Sidecar persistence is
// handled in panels.js (extends buildSidecarData / applySidecar).  This file
// owns the in-lightbox UX and the sibling-card lifecycle in the grid.

(() => {
    'use strict';

    // ---------- DOM refs ----------
    const lightbox          = document.getElementById('lightbox');
    const viewport          = lightbox?.querySelector('.lightbox-viewport');
    const cropBtn           = lightbox?.querySelector('.lb-crop-btn');
    const aspectSelect      = document.getElementById('lb-aspect-select');
    const modeToggle        = document.getElementById('lb-crop-mode-toggle');
    const applyBtn          = document.getElementById('lb-crop-apply');
    const cancelBtn         = document.getElementById('lb-crop-cancel');
    const layer             = document.getElementById('lb-crop-layer');
    const dim               = document.getElementById('lb-crop-dim');
    const rect              = document.getElementById('lb-crop-rect');
    const subjectsOverlay   = document.getElementById('lb-subjects-overlay');
    const subjectsPanel     = document.getElementById('lb-subjects-panel');
    const subjectsList      = document.getElementById('lb-subjects-list');
    const subjectsClose     = document.getElementById('lb-subjects-close');

    if (!viewport || !cropBtn) return; // graceful no-op if elements missing

    // ---------- module state ----------
    // mode: 'off' (display-only) | 'frame' (editing crop) | 'subjects' (editing subjects)
    let mode = 'off';
    // Temporary editing state for frame mode — committed to card._crop on Apply.
    let pendingCrop = null;
    // Temporary subject list for subjects mode (clone of card._subjects).
    let pendingSubjects = [];
    // Active drag operation: { type, subjectId?, startX, startY, origin } etc.
    let drag = null;
    // Currently selected subject id (for editing).
    let selectedSubjectId = null;

    const ASPECT_VALUES = {
        'free':     null,
        'original': null,         // resolved at edit-time from canvas dims
        '1:1':      1.0,
        '3:2':      3 / 2,
        '4:3':      4 / 3,
        '16:9':     16 / 9,
        '5:4':      5 / 4,
    };

    // ---------- geometry helpers ----------
    /**
     * Compute a non-destructive straighten + largest-rect crop.
     * Returns a crop descriptor suitable for storage in card._crop / sidecar.
     *
     * The returned rect (x,y,w,h) is in *original unrotated image* normalized [0..1] space.
     * When the lightbox renders, it will:
     *   1. Rotate the source pixels by `angle` around center
     *   2. Then take the rect (which after rotation becomes axis-aligned of the requested aspect)
     *
     * This satisfies the user's request: "crops the largest horizontally rectangular section
     * out of a skew/diagonal one" while keeping the original image uncropped.
     */
    function computeStraightenCrop(srcW, srcH, angleDeg, targetRatioKey) {
        if (!srcW || !srcH) return null;
        const angle = (angleDeg || 0) * Math.PI / 180;
        const c = Math.cos(angle);
        const s = Math.sin(angle);

        // Rotated corners of the source image (centered at origin for math, then shifted back)
        const hw = srcW / 2, hh = srcH / 2;
        const corners = [
            [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]
        ].map(([x, y]) => [c * x - s * y, s * x + c * y]);

        // Axis-aligned bounding box after rotation
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of corners) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const rotW = maxX - minX;
        const rotH = maxY - minY;

        // Desired output aspect (width/height)
        let desiredRatio = ASPECT_VALUES[targetRatioKey];
        if (targetRatioKey === 'original' || !desiredRatio) {
            desiredRatio = srcW / srcH;
        } else if (targetRatioKey === 'free') {
            desiredRatio = rotW / rotH; // just fit the rotated bounds
        }

        // Largest rect of desiredRatio that fits inside the rotated bounds (centered)
        let outW = rotW;
        let outH = rotW / desiredRatio;
        if (outH > rotH) {
            outH = rotH;
            outW = rotH * desiredRatio;
        }

        // Convert back to original image coordinates (inverse rotation + shift)
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        // The centered rect in rotated space
        const halfW = outW / 2, halfH = outH / 2;
        const rectCornersRot = [
            [cx - halfW, cy - halfH],
            [cx + halfW, cy - halfH],
            [cx + halfW, cy + halfH],
            [cx - halfW, cy + halfH]
        ];

        // Inverse-rotate the four corners back to original space
        const ca = Math.cos(-angle), sa = Math.sin(-angle);
        const origPts = rectCornersRot.map(([x, y]) => {
            const rx = x - cx, ry = y - cy; // relative to rotated center
            const ox = ca * rx - sa * ry;
            const oy = sa * rx + ca * ry;
            return [ox + hw, oy + hh]; // back to original [0..W, 0..H]
        });

        // Axis-aligned bounding rect in original pixels (this is what we store)
        let oMinX = Infinity, oMaxX = -Infinity, oMinY = Infinity, oMaxY = -Infinity;
        for (const [x, y] of origPts) {
            if (x < oMinX) oMinX = x;
            if (x > oMaxX) oMaxX = x;
            if (y < oMinY) oMinY = y;
            if (y > oMaxY) oMaxY = y;
        }

        const cropW = Math.max(1, oMaxX - oMinX);
        const cropH = Math.max(1, oMaxY - oMinY);
        const nx = oMinX / srcW;
        const ny = oMinY / srcH;
        const nw = cropW / srcW;
        const nh = cropH / srcH;

        return {
            x: Math.max(0, Math.min(1, nx)),
            y: Math.max(0, Math.min(1, ny)),
            w: Math.max(0.001, Math.min(1 - nx, nw)),
            h: Math.max(0.001, Math.min(1 - ny, nh)),
            ratio: targetRatioKey || 'free',
            angle: angleDeg || 0,
            inOriginalSpace: true
        };
    }

    window.computeStraightenCrop = computeStraightenCrop; // exposed for debugging / future tools

    // Map a canvas client-pixel to normalised image coords [0..1].
    // Uses the canvas's getBoundingClientRect so it respects all the CSS
    // transforms (zoom, pan, rotation) applied by main.js.
    function clientToImageNorm(clientX, clientY) {
        const canvas = document.getElementById('lightbox-canvas');
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        // Rotation: undo the lbRotation so coords land in unrotated image space.
        // For now lbRotation operates on the whole canvas, so the bounding rect
        // already accounts for it. Treating rect as the displayed image bounds
        // is sufficient for the common 0/180 case; 90/270 also works because
        // both x and y get rotated symmetrically through getBoundingClientRect.
        const nx = (clientX - r.left) / r.width;
        const ny = (clientY - r.top)  / r.height;
        return { nx: clamp01(nx), ny: clamp01(ny) };
    }

    // Inverse: normalised image coord → viewport-relative pixel for overlay placement.
    function imageNormToViewport(nx, ny) {
        const canvas = document.getElementById('lightbox-canvas');
        if (!canvas) return { x: 0, y: 0 };
        const cr = canvas.getBoundingClientRect();
        const vr = viewport.getBoundingClientRect();
        return {
            x: (cr.left - vr.left) + nx * cr.width,
            y: (cr.top  - vr.top)  + ny * cr.height,
        };
    }

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    function normalisedBoxFromCorners(a, b) {
        const x = Math.min(a.nx, b.nx);
        const y = Math.min(a.ny, b.ny);
        const w = Math.abs(b.nx - a.nx);
        const h = Math.abs(b.ny - a.ny);
        return { x: clamp01(x), y: clamp01(y),
                 w: Math.max(0.001, Math.min(1 - x, w)),
                 h: Math.max(0.001, Math.min(1 - y, h)) };
    }

    // Apply an aspect-ratio constraint to a box being drawn from start→end.
    // ratio = target W / H in image-pixel space (so we need to translate the
    // normalised dims through the image aspect ratio to get a true visual square).
    function constrainAspect(start, end, ratio) {
        if (!ratio) return normalisedBoxFromCorners(start, end);
        // Convert ratio (pixel W/H) into normalised-space (nw/nh) using the
        // current image aspect: if image is fw×fh, then nw/nh = ratio * fh/fw.
        const canvas = document.getElementById('lightbox-canvas');
        const fw = canvas?.width || 1;
        const fh = canvas?.height || 1;
        const normRatio = ratio * (fh / fw);
        // Take the larger of the two extents and conform the other.
        const dx = end.nx - start.nx;
        const dy = end.ny - start.ny;
        let nw = Math.abs(dx);
        let nh = Math.abs(dy);
        if (nw / nh > normRatio) nh = nw / normRatio;
        else                     nw = nh * normRatio;
        const x = dx >= 0 ? start.nx : start.nx - nw;
        const y = dy >= 0 ? start.ny : start.ny - nh;
        return {
            x: clamp01(x), y: clamp01(y),
            w: Math.min(1 - clamp01(x), nw),
            h: Math.min(1 - clamp01(y), nh),
        };
    }

    function currentAspect() {
        const v = aspectSelect.value;
        if (v === 'original') {
            const canvas = document.getElementById('lightbox-canvas');
            if (canvas && canvas.width && canvas.height) {
                return canvas.width / canvas.height;
            }
            return null;
        }
        return ASPECT_VALUES[v];
    }

    // ---------- mode entry / exit ----------
    function enterMode(newMode) {
        const card = window.lightboxCard?.();
        if (!card) return;
        mode = newMode;
        cropBtn.setAttribute('data-active', '1');
        applyBtn.hidden  = false;
        cancelBtn.hidden = false;
        aspectSelect.hidden = (newMode !== 'frame');
        modeToggle.hidden = false;
        modeToggle.textContent = (newMode === 'frame') ? 'Frame' : 'Subjects';
        layer.hidden = false;
        layer.setAttribute('data-mode', newMode);
        // Pause the canvas pan handlers while editing — let crop layer steal events.
        viewport.classList.remove('has-crop');

        // Finding 41: snapshot the committed state BEFORE seeding pending UI state.
        // applyCropEdit / cancelCropEdit will atomically commit or restore it.
        if (window._assetStateStore && typeof window._getCardAssetId === 'function') {
            const assetId = window._getCardAssetId(card);
            if (assetId) window._assetStateStore.beginCropEdit(assetId);
        }

        if (newMode === 'frame') {
            // Finding 41: seed pendingCrop from committed crop; do NOT write card._crop.
            pendingCrop = card._crop
                ? { ...card._crop }
                : { x: 0.05, y: 0.05, w: 0.9, h: 0.9, ratio: aspectSelect.value || 'free',
                    angle: 0, inOriginalSpace: true };
            aspectSelect.value = pendingCrop.ratio || 'free';
            subjectsPanel.hidden = true;
            renderRect();
            subjectsOverlay.innerHTML = '';
        } else {
            pendingSubjects = (card._subjects || []).map(s => ({ ...s }));
            selectedSubjectId = pendingSubjects[0]?.id || null;
            subjectsPanel.hidden = false;
            rect.hidden = true;
            renderSubjectsOverlay();
            renderSubjectsList();
        }
    }

    function exitMode(save) {
        const card = window.lightboxCard?.();
        if (mode !== 'off' && card) {
            if (save) {
                if (mode === 'frame') {
                    pendingCrop.ratio = aspectSelect.value || 'free';
                    // Finding 41: Apply atomically via the store; do NOT write card._crop directly.
                    if (window._assetStateStore && typeof window._getCardAssetId === 'function') {
                        const assetId = window._getCardAssetId(card);
                        if (assetId) {
                            window._assetStateStore.applyCropEdit(assetId, pendingCrop, pendingSubjects);
                            // Sync back to card DOM proxies from the committed store state.
                            const asState = window._assetStateStore.getOrCreate(assetId);
                            card._crop = asState.edit.crop;
                            card._subjects = asState.edit.subjects;
                        } else {
                            card._crop = pendingCrop;
                        }
                    } else {
                        card._crop = pendingCrop;
                    }
                } else if (mode === 'subjects') {
                    // Finding 41: Apply subjects atomically.
                    if (window._assetStateStore && typeof window._getCardAssetId === 'function') {
                        const assetId = window._getCardAssetId(card);
                        if (assetId) {
                            window._assetStateStore.applyCropEdit(assetId, pendingCrop, pendingSubjects);
                            const asState = window._assetStateStore.getOrCreate(assetId);
                            card._crop = asState.edit.crop;
                            card._subjects = asState.edit.subjects;
                        } else {
                            card._subjects = pendingSubjects;
                        }
                    } else {
                        card._subjects = pendingSubjects;
                    }
                }
                // Save sidecar + sync sibling cards.
                triggerSidecarSave(card);
                rebuildSubjectCards(card);
            } else {
                // Finding 41: Cancel — restore snapshot via the store.
                if (window._assetStateStore && typeof window._getCardAssetId === 'function') {
                    const assetId = window._getCardAssetId(card);
                    if (assetId) {
                        window._assetStateStore.cancelCropEdit(assetId);
                        // Sync restored state back to card DOM proxies.
                        const asState = window._assetStateStore.getOrCreate(assetId);
                        card._crop = asState.edit.crop;
                        card._subjects = asState.edit.subjects;
                    }
                }
            }
        }
        mode = 'off';
        pendingCrop = null;
        pendingSubjects = [];
        selectedSubjectId = null;
        drag = null;
        cropBtn.removeAttribute('data-active');
        applyBtn.hidden  = true;
        cancelBtn.hidden = true;
        aspectSelect.hidden = true;
        modeToggle.hidden = true;
        layer.hidden = true;
        layer.removeAttribute('data-mode');
        subjectsPanel.hidden = true;
        subjectsOverlay.innerHTML = '';
        // Re-apply display crop if one is set.
        applyDisplayCrop(card);
    }

    function triggerSidecarSave(card) {
        const filename = card?._tauriPath || card?._file?.name;
        if (filename && typeof window.saveSidecar === 'function') {
            // Finding 46: pass the card explicitly so saveSidecar reads from the
            // correct per-asset state, not the ambient lightboxCard() global.
            // Surface persist failures instead of silently swallowing them — a
            // failed save after Apply would otherwise be invisible to the user.
            window.saveSidecar(filename, card).catch((err) => {
                console.error('[crop] sidecar save failed for', filename, err);
            });
        }
    }

    // ---------- frame mode rendering ----------
    function renderRect() {
        if (!pendingCrop) return;
        const tl = imageNormToViewport(pendingCrop.x, pendingCrop.y);
        const br = imageNormToViewport(pendingCrop.x + pendingCrop.w,
                                        pendingCrop.y + pendingCrop.h);
        rect.style.left   = tl.x + 'px';
        rect.style.top    = tl.y + 'px';
        rect.style.width  = (br.x - tl.x) + 'px';
        rect.style.height = (br.y - tl.y) + 'px';
        rect.hidden = false;
        // Outside-the-rect dimming handled by 9999px box-shadow in CSS.
    }

    // ---------- subjects rendering ----------
    function renderSubjectsOverlay() {
        subjectsOverlay.innerHTML = '';
        for (const s of pendingSubjects) {
            const tl = imageNormToViewport(s.x, s.y);
            const br = imageNormToViewport(s.x + s.w, s.y + s.h);
            const box = document.createElement('div');
            box.className = 'lb-subject-box';
            box.dataset.subjectId = s.id;
            if (s.id === selectedSubjectId) box.dataset.selected = '1';
            box.style.left   = tl.x + 'px';
            box.style.top    = tl.y + 'px';
            box.style.width  = (br.x - tl.x) + 'px';
            box.style.height = (br.y - tl.y) + 'px';
            if (s.label) {
                const lab = document.createElement('div');
                lab.className = 'lb-subject-label';
                lab.textContent = s.label;
                box.appendChild(lab);
            }
            box.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                selectedSubjectId = s.id;
                renderSubjectsOverlay();
                renderSubjectsList();
            });
            subjectsOverlay.appendChild(box);
        }
    }

    function renderSubjectsList() {
        subjectsList.innerHTML = '';
        pendingSubjects.forEach((s, i) => {
            const row = document.createElement('div');
            row.className = 'lb-subject-row';
            row.dataset.subjectId = s.id;
            if (s.id === selectedSubjectId) row.dataset.selected = '1';

            const head = document.createElement('div');
            head.className = 'lb-subject-actions';
            const num = document.createElement('span');
            num.className = 'lb-subject-num';
            num.textContent = `#${i + 1}  ${(s.w * 100).toFixed(0)}% × ${(s.h * 100).toFixed(0)}%`;
            head.appendChild(num);
            const del = document.createElement('button');
            del.className = 'lb-subject-del';
            del.textContent = 'Delete';
            del.addEventListener('click', () => {
                pendingSubjects = pendingSubjects.filter(x => x.id !== s.id);
                if (selectedSubjectId === s.id) selectedSubjectId = pendingSubjects[0]?.id || null;
                renderSubjectsOverlay();
                renderSubjectsList();
            });
            head.appendChild(del);
            row.appendChild(head);

            const labelIn = document.createElement('input');
            labelIn.type = 'text';
            labelIn.placeholder = 'Label (e.g. Rabbit)';
            labelIn.value = s.label || '';
            labelIn.addEventListener('input', () => {
                s.label = labelIn.value;
                renderSubjectsOverlay();
            });
            row.appendChild(labelIn);

            const noteIn = document.createElement('textarea');
            noteIn.placeholder = 'Note / context';
            noteIn.rows = 2;
            noteIn.value = s.note || '';
            noteIn.addEventListener('input', () => { s.note = noteIn.value; });
            row.appendChild(noteIn);

            const statusSel = document.createElement('select');
            for (const opt of ['unknown', 'tentative', 'confirmed']) {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = opt[0].toUpperCase() + opt.slice(1);
                if (s.status === opt) o.selected = true;
                statusSel.appendChild(o);
            }
            statusSel.addEventListener('change', () => { s.status = statusSel.value; });
            row.appendChild(statusSel);

            row.addEventListener('mousedown', () => {
                selectedSubjectId = s.id;
                renderSubjectsOverlay();
                renderSubjectsList();
            });
            subjectsList.appendChild(row);
        });
    }

    // ---------- mouse interaction (frame + subjects) ----------
    layer.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('lb-crop-h')) {
            // Edge/corner resize of frame rectangle.
            if (mode !== 'frame' || !pendingCrop) return;
            drag = { type: 'resize-frame', handle: e.target.dataset.h,
                     start: { ...pendingCrop } };
            e.preventDefault(); e.stopPropagation();
            return;
        }
        if (e.target === rect && mode === 'frame') {
            // Drag entire frame rectangle.
            const ni = clientToImageNorm(e.clientX, e.clientY);
            if (!ni) return;
            drag = { type: 'move-frame',
                     offset: { dx: ni.nx - pendingCrop.x, dy: ni.ny - pendingCrop.y } };
            e.preventDefault(); e.stopPropagation();
            return;
        }
        if (e.target.classList.contains('lb-subject-box')) {
            // Drag existing subject box.
            if (mode !== 'subjects') return;
            const subj = pendingSubjects.find(s => s.id === e.target.dataset.subjectId);
            if (!subj) return;
            const ni = clientToImageNorm(e.clientX, e.clientY);
            if (!ni) return;
            selectedSubjectId = subj.id;
            renderSubjectsList();
            drag = { type: 'move-subject', subjectId: subj.id,
                     offset: { dx: ni.nx - subj.x, dy: ni.ny - subj.y } };
            e.preventDefault(); e.stopPropagation();
            return;
        }
        // Empty space: start a fresh drag (new rectangle in frame mode, new
        // subject in subjects mode).
        const ni = clientToImageNorm(e.clientX, e.clientY);
        if (!ni) return;
        if (mode === 'frame') {
            drag = { type: 'draw-frame', start: ni };
        } else if (mode === 'subjects') {
            drag = { type: 'draw-subject', start: ni };
        } else {
            return;
        }
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const ni = clientToImageNorm(e.clientX, e.clientY);
        if (!ni) return;
        if (drag.type === 'draw-frame') {
            const ratio = currentAspect();
            pendingCrop = ratio
                ? { ...constrainAspect(drag.start, ni, ratio), ratio: aspectSelect.value }
                : { ...normalisedBoxFromCorners(drag.start, ni), ratio: aspectSelect.value };
            renderRect();
        } else if (drag.type === 'move-frame') {
            const nw = pendingCrop.w; const nh = pendingCrop.h;
            pendingCrop.x = clamp01(ni.nx - drag.offset.dx);
            pendingCrop.y = clamp01(ni.ny - drag.offset.dy);
            if (pendingCrop.x + nw > 1) pendingCrop.x = 1 - nw;
            if (pendingCrop.y + nh > 1) pendingCrop.y = 1 - nh;
            renderRect();
        } else if (drag.type === 'resize-frame') {
            const orig = drag.start;
            const h = drag.handle;
            let x = orig.x, y = orig.y, w = orig.w, hh = orig.h;
            if (h.includes('w')) { const r = x + w; x = clamp01(ni.nx); w = r - x; }
            if (h.includes('e')) { w = clamp01(ni.nx) - x; }
            if (h.includes('n')) { const b = y + hh; y = clamp01(ni.ny); hh = b - y; }
            if (h.includes('s')) { hh = clamp01(ni.ny) - y; }
            if (w > 0.001 && hh > 0.001) {
                pendingCrop = { x, y, w, h: hh, ratio: aspectSelect.value };
                // Re-apply aspect ratio constraint if active and the drag was
                // on a corner (edge resizes allow free aspect change).
                const ratio = currentAspect();
                if (ratio && (h === 'nw' || h === 'ne' || h === 'sw' || h === 'se')) {
                    pendingCrop = { ...constrainAspect({ nx: orig.x, ny: orig.y },
                                                       { nx: x + w, ny: y + hh }, ratio),
                                    ratio: aspectSelect.value };
                }
                renderRect();
            }
        } else if (drag.type === 'draw-subject') {
            const box = normalisedBoxFromCorners(drag.start, ni);
            drag.preview = box;
            // Live-render an ephemeral box.
            let prev = subjectsOverlay.querySelector('.lb-subject-box[data-preview]');
            if (!prev) {
                prev = document.createElement('div');
                prev.className = 'lb-subject-box';
                prev.dataset.preview = '1';
                subjectsOverlay.appendChild(prev);
            }
            const tl = imageNormToViewport(box.x, box.y);
            const br = imageNormToViewport(box.x + box.w, box.y + box.h);
            prev.style.left = tl.x + 'px'; prev.style.top = tl.y + 'px';
            prev.style.width = (br.x - tl.x) + 'px';
            prev.style.height = (br.y - tl.y) + 'px';
        } else if (drag.type === 'move-subject') {
            const s = pendingSubjects.find(x => x.id === drag.subjectId);
            if (!s) return;
            s.x = clamp01(ni.nx - drag.offset.dx);
            s.y = clamp01(ni.ny - drag.offset.dy);
            if (s.x + s.w > 1) s.x = 1 - s.w;
            if (s.y + s.h > 1) s.y = 1 - s.h;
            renderSubjectsOverlay();
        }
    });

    window.addEventListener('mouseup', () => {
        if (!drag) return;
        if (drag.type === 'draw-subject' && drag.preview && drag.preview.w > 0.01 && drag.preview.h > 0.01) {
            const id = 's-' + Math.random().toString(36).slice(2, 8);
            pendingSubjects.push({ id, ...drag.preview, label: '', note: '', status: 'unknown' });
            selectedSubjectId = id;
            renderSubjectsOverlay();
            renderSubjectsList();
        } else {
            // Strip the preview-only box if any.
            const prev = subjectsOverlay.querySelector('.lb-subject-box[data-preview]');
            if (prev) prev.remove();
        }
        drag = null;
    });

    // ---------- toolbar wiring ----------
    cropBtn.addEventListener('click', () => {
        if (mode === 'off') enterMode('frame');
        else                exitMode(true);
    });
    aspectSelect.addEventListener('change', () => {
        if (mode === 'frame' && pendingCrop) {
            // Re-conform existing crop to the new ratio (anchor at top-left).
            const ratio = currentAspect();
            if (ratio) {
                pendingCrop = { ...constrainAspect(
                    { nx: pendingCrop.x, ny: pendingCrop.y },
                    { nx: pendingCrop.x + pendingCrop.w, ny: pendingCrop.y + pendingCrop.h },
                    ratio), ratio: aspectSelect.value };
                renderRect();
            } else {
                pendingCrop.ratio = aspectSelect.value;
            }
        }
    });
    modeToggle.addEventListener('click', () => {
        // Finding 41: when switching modes, carry the pending state into the new mode's
        // pending variables — do NOT write card._crop / card._subjects here (that would
        // be a pre-Apply commit of uncommitted edits). The snapshot taken in enterMode
        // / beginCropEdit covers the committed state; the pending state is local only.
        const _pendingCropBeforeSwitch    = pendingCrop    ? { ...pendingCrop }    : null;
        const _pendingSubjectsBeforeSwitch = pendingSubjects.map(s => ({ ...s }));
        const nextMode = mode === 'frame' ? 'subjects' : 'frame';
        enterMode(nextMode);
        // After enterMode seeds its pending state from the committed card values,
        // restore the pending-only edits the user had in the outgoing mode so they
        // are not lost when toggling back. enterMode() already did beginCropEdit()
        // for the snapshot, so no second snapshot is needed.
        if (nextMode === 'subjects' && _pendingSubjectsBeforeSwitch.length) {
            pendingSubjects = _pendingSubjectsBeforeSwitch;
            renderSubjectsOverlay();
            renderSubjectsList();
        }
        if (nextMode === 'frame' && _pendingCropBeforeSwitch) {
            pendingCrop = _pendingCropBeforeSwitch;
            aspectSelect.value = pendingCrop.ratio || 'free';
            renderRect();
        }
    });
    applyBtn .addEventListener('click', () => exitMode(true));
    cancelBtn.addEventListener('click', () => exitMode(false));
    subjectsClose.addEventListener('click', () => exitMode(true));

    document.addEventListener('keydown', (e) => {
        if (mode === 'off') {
            if (!lightbox.hidden && e.key === 'c' && !(e.ctrlKey || e.metaKey || e.altKey)
                && document.activeElement?.tagName !== 'INPUT'
                && document.activeElement?.tagName !== 'TEXTAREA') {
                enterMode('frame');
                e.preventDefault();
            }
            return;
        }
        if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
        if (e.key === 'Escape') { exitMode(false); e.preventDefault(); }
        else if (e.key === 'Enter') { exitMode(true); e.preventDefault(); }
    });

    // ---------- display-time crop clipping ----------
    // When a crop is set and we are NOT editing, mask the canvas via CSS
    // clip-path so the user sees only the framed region.  Called from main.js
    // whenever the canvas is repainted (cropApplyToCard) and on mode exit.
    function applyDisplayCrop(card) {
        if (!card || !card._crop || mode !== 'off') {
            viewport.classList.remove('has-crop');
            const canvas = document.getElementById('lightbox-canvas');
            if (canvas) canvas.style.removeProperty('--cx');
            return;
        }
        const c = card._crop;
        viewport.classList.add('has-crop');
        const canvas = document.getElementById('lightbox-canvas');
        if (canvas) {
            canvas.style.setProperty('--cx', (c.x * 100) + '%');
            canvas.style.setProperty('--cy', (c.y * 100) + '%');
            canvas.style.setProperty('--cw', (c.w * 100) + '%');
            canvas.style.setProperty('--ch', (c.h * 100) + '%');
        }
    }
    window.cropApplyToCard = applyDisplayCrop;

    // ---------- sibling cards (focal subject thumbnails in the grid) ----------
    //
    // For each subject we insert a special `.thumb.subject-card` immediately
    // after the parent card. Thumbnail pixels are rendered from the parent's
    // cached full-res JXL bitmap (so we wait for JXL to be ready), cropped to
    // the subject bounds and downsampled to 360 long-edge.
    //
    // The card is intentionally lightweight — no RAW pipeline state, just a
    // canvas, a label, and click handler that opens the parent in the lightbox
    // with the subject auto-selected (so the lightbox can zoom-to-subject).

    // Populate _crop and _subjects on a card from a sidecar blob — works
    // outside the lightbox-active path so subject siblings can appear in the
    // grid the moment a folder is scanned, not only after the user opens the
    // file in the lightbox.
    // Clamp a normalised box so that x,y ∈ [0,1], w,h ≥ 0.001, and the box
    // stays on-image: x+w ≤ 1 and y+h ≤ 1. Width/height take precedence over
    // origin (origin is pulled back if the box would overflow the right/bottom).
    function clampNormBox(x, y, w, h) {
        const cx = clamp01(x);
        const cy = clamp01(y);
        const cw = Math.max(0.001, Math.min(1 - cx, w));
        const ch = Math.max(0.001, Math.min(1 - cy, h));
        return { x: cx, y: cy, w: cw, h: ch };
    }

    function applyCropAndSubjectsToCard(card, sidecar) {
        if (!card || !sidecar) return;
        // Finding 40: route through assetStateStore when available so the edit is
        // keyed on the stable assetId. Fall back to direct write for cards that
        // don't yet have an assetId (e.g. very early in startup).
        if (window._assetStateStore && typeof window._getCardAssetId === 'function') {
            const assetId = window._getCardAssetId(card);
            if (assetId) {
                window._assetStateStore.applySidecarEdit(assetId, sidecar);
                const asState = window._assetStateStore.getOrCreate(assetId);
                card._crop     = asState.edit.crop;
                card._subjects = asState.edit.subjects;
                rebuildSubjectCards(card);
                return;
            }
        }
        // Fallback direct-write path (store unavailable or card lacks assetId).
        if (sidecar.crop && typeof sidecar.crop === 'object'
            && Number.isFinite(sidecar.crop.x) && Number.isFinite(sidecar.crop.y)
            && Number.isFinite(sidecar.crop.w) && Number.isFinite(sidecar.crop.h)) {
            const b = clampNormBox(sidecar.crop.x, sidecar.crop.y, sidecar.crop.w, sidecar.crop.h);
            card._crop = {
                x: b.x, y: b.y, w: b.w, h: b.h,
                ratio: typeof sidecar.crop.ratio === 'string' ? sidecar.crop.ratio : 'free',
                // Finding 41: preserve angle + inOriginalSpace in direct-write path too.
                angle: typeof sidecar.crop.angle === 'number' ? sidecar.crop.angle : 0,
                inOriginalSpace: typeof sidecar.crop.inOriginalSpace === 'boolean' ? sidecar.crop.inOriginalSpace : true,
            };
        }
        if (Array.isArray(sidecar.subjects)) {
            card._subjects = sidecar.subjects
                .filter(s => s && Number.isFinite(s.x) && Number.isFinite(s.y)
                          && Number.isFinite(s.w) && Number.isFinite(s.h))
                .map(s => {
                    const b = clampNormBox(s.x, s.y, s.w, s.h);
                    return {
                        id: s.id || ('s-' + Math.random().toString(36).slice(2, 8)),
                        x: b.x, y: b.y, w: b.w, h: b.h,
                        label: typeof s.label === 'string' ? s.label : '',
                        note:  typeof s.note  === 'string' ? s.note  : '',
                        status: ['unknown','tentative','confirmed'].includes(s.status) ? s.status : 'unknown',
                    };
                });
        }
        rebuildSubjectCards(card);
    }
    window.applyCropAndSubjectsToCard = applyCropAndSubjectsToCard;

    function rebuildSubjectCards(parentCard) {
        if (!parentCard) return;
        // Remove any existing subject siblings belonging to this parent.
        const grid = document.getElementById('grid');
        if (!grid) return;
        const old = grid.querySelectorAll(`.thumb.subject-card[data-parent="${parentCard.dataset.cardId || ''}"]`);
        old.forEach(n => n.remove());
        if (!parentCard._subjects?.length) return;
        // Tag parent with an ID we can reference.
        if (!parentCard.dataset.cardId) {
            parentCard.dataset.cardId = 'c-' + Math.random().toString(36).slice(2, 8);
        }
        let after = parentCard;
        parentCard._subjects.forEach((s, idx) => {
            const card = makeSubjectCard(parentCard, s, idx);
            after.parentNode.insertBefore(card, after.nextSibling);
            after = card;
        });
        // Trigger paint pass. Surface decode/paint failures rather than
        // silently swallowing them (a swallowed reject leaves a blank thumb
        // indistinguishable from a real error).
        renderSubjectThumb(parentCard).catch((err) => {
            console.error('[crop] renderSubjectThumb failed', err);
        });
    }
    window.rebuildSubjectCards = rebuildSubjectCards;

    function makeSubjectCard(parent, subject, idx) {
        const card = document.createElement('div');
        card.className = 'thumb subject-card';
        card.dataset.parent = parent.dataset.cardId;
        card.dataset.subjectId = subject.id;
        card.dataset.subjectLabel = subject.label || `Subject ${idx + 1}`;
        card._parentCard = parent;
        card._subjectId  = subject.id;
        card._subjectBounds = { x: subject.x, y: subject.y, w: subject.w, h: subject.h };

        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 270;
        card.appendChild(canvas);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = subject.label || `Subject ${idx + 1}`;
        meta.appendChild(name);
        const sz = document.createElement('span');
        sz.className = 'size';
        sz.textContent = `${(subject.w * 100).toFixed(0)}% × ${(subject.h * 100).toFixed(0)}%`;
        meta.appendChild(sz);
        card.appendChild(meta);

        card.addEventListener('click', () => {
            // Find parent in cards[], open lightbox with subject auto-focused.
            const allCards = (typeof window.allCards === 'function') ? window.allCards() : [];
            const parentIdx = allCards.indexOf(parent);
            if (parentIdx >= 0 && typeof window.openLightboxAtSubject === 'function') {
                window.openLightboxAtSubject(parent, subject.id);
            }
        });
        return card;
    }

    // Render thumbnails for all subjects of a parent, using its cached JXL bitmap.
    async function renderSubjectThumb(parentCard) {
        if (!parentCard?._subjects?.length) return;
        // Need JXL pixels. Decoded once full-res into parentCard._jxlDecoded?
        // If not yet, kick the decode and wait — we promised "wait for JXL".
        if (!parentCard._jxlDecoded && parentCard._blobUrl
            && typeof window.decodeFullJxlFor === 'function') {
            await window.decodeFullJxlFor(parentCard);
            // The decode is unabortable; by the time it resolves the parent card
            // may have been torn down (lightbox exit) or its subject siblings
            // rebuilt. Bail rather than paint into stale/detached nodes.
            if (!parentCard.isConnected) return;
        }
        const jd = parentCard._jxlDecoded;
        if (!jd) return; // JXL not available — bail silently
        const { rgba, w, h } = jd;
        // Build a temporary source canvas with the full JXL pixels.
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = w; srcCanvas.height = h;
        srcCanvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);

        const siblings = document.querySelectorAll(
            `.thumb.subject-card[data-parent="${parentCard.dataset.cardId}"]`);
        siblings.forEach(card => {
            const b = card._subjectBounds;
            if (!b) return;
            const sx = Math.round(b.x * w);
            const sy = Math.round(b.y * h);
            const sw = Math.max(1, Math.round(b.w * w));
            const sh = Math.max(1, Math.round(b.h * h));
            const LONG = 360;
            const long = Math.max(sw, sh);
            const dw = long > LONG ? Math.max(1, Math.round(sw * LONG / long)) : sw;
            const dh = long > LONG ? Math.max(1, Math.round(sh * LONG / long)) : sh;
            const dst = card.querySelector('canvas');
            dst.width = dw; dst.height = dh;
            const ctx = dst.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, dw, dh);
        });
    }
    window.renderSubjectThumb = renderSubjectThumb;

    // Repaint dim/rect on viewport resize or canvas transform changes.
    const ro = new ResizeObserver(() => {
        if (mode === 'frame' && pendingCrop) renderRect();
        else if (mode === 'subjects') renderSubjectsOverlay();
    });
    if (viewport) ro.observe(viewport);
})();
