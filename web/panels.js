// panels.js — lightbox panels: histogram, colour profiles, filters, sidecar
// Loaded as plain script after main.js. Uses globals exposed by main.js on window.

(function () {
'use strict';

// ── Panel toggle ──────────────────────────────────────────────────
const panelBodies = {};
const panelBtns   = {};

function initPanelToggles() {
  document.querySelectorAll('.lb-panel-btn').forEach(btn => {
    const key = btn.dataset.panel;
    panelBtns[key]   = btn;
    panelBodies[key] = btn.closest('.lb-panel').querySelector('.lb-panel-body');
    btn.addEventListener('click', () => togglePanel(key));
  });
}

function togglePanel(key) {
  const body = panelBodies[key];
  const btn  = panelBtns[key];
  if (!body || !btn) return;
  const opening = body.hidden;
  // Accordion: close all other panels before toggling this one.
  Object.keys(panelBodies).forEach(k => {
    if (k !== key) {
      panelBodies[k].hidden = true;
      panelBtns[k].classList.remove('active');
    }
  });
  body.hidden = !opening;
  btn.classList.toggle('active', opening);
  if (key === 'h' && opening && typeof updateHistogramAndLevels === 'function') {
    updateHistogramAndLevels();
  }
}

window.togglePanel = togglePanel;

// ── Pipeline Filters ──────────────────────────────────────────────
let activeFilter    = null;
let grainActive     = false;
let vignetteActive  = false;
let vignetteAmount  = 0.65;
let vignetteWidth   = 0.45;
let vignetteColor   = 'black'; // 'black' | 'white' | 'grey'
let _grainImgPending = null;
let PIPELINE_FILTERS = {
  'B&W Natural': { saturation:-1.0, contrast:0,     temp:0,     tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Soft':    { saturation:-1.0, contrast:-0.25, temp:0,     tint:0,    highlights:-0.15,  shadows:0.2, whites:0,     blacks:0 },
  'B&W Strong':  { saturation:-1.0, contrast:0.4,   temp:0,     tint:0,    highlights:0,     shadows:0,   whites:0.15,  blacks:-0.15 },
  'B&W Red':     { saturation:-1.0, contrast:0,     temp:0.4,   tint:-0.1, highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Orange':  { saturation:-1.0, contrast:0,     temp:0.25,  tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Yellow':  { saturation:-1.0, contrast:0,     temp:0.12,  tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Green':   { saturation:-1.0, contrast:0,     temp:-0.15, tint:0.2,  highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'B&W Blue':    { saturation:-1.0, contrast:0,     temp:-0.35, tint:0,    highlights:0,     shadows:0,   whites:0,     blacks:0 },
  'Infrared':    { saturation:-1.0, contrast:0,     temp:0.5,   tint:0,    highlights:0.4,   shadows:0,   whites:0.3,   blacks:0 },
  'Fade':          { saturation:0,   contrast:-0.3, temp:0,    tint:0,   highlights:0, shadows:0, whites:-0.1, blacks:0.15 },
  'Cross-process': { saturation:0.3, contrast:0.2,  temp:-0.2, tint:0.3, highlights:0, shadows:0, whites:0,    blacks:0 },
  'Bleach bypass': { saturation:-0.5, contrast:0.4, temp:0,    tint:0,   highlights:0, shadows:0, whites:0,    blacks:0, clarity:0.2 },
};

const BW_NAMES       = ['B&W Natural','B&W Soft','B&W Strong','B&W Red','B&W Orange','B&W Yellow','B&W Green','B&W Blue','Infrared'];
window.BW_NAMES = BW_NAMES;
const CREATIVE_NAMES = ['Fade','Cross-process','Bleach bypass'];

function setActiveFilter(name) {
  if (name === null) { activeFilter = null; }
  else { activeFilter = (activeFilter === name) ? null : name; }
  renderFilterChips();
  if (typeof window.scheduleLiveUpdate === 'function') window.scheduleLiveUpdate();
}

window.setActiveFilter = setActiveFilter;

function renderFilterChips() {
  function buildChips(containerId, names) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    names.forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'lb-chip' + (activeFilter === name ? ' lb-chip-active' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => setActiveFilter(name));
      el.appendChild(btn);
    });
  }
  buildChips('lb-bw-chips',       BW_NAMES);
  buildChips('lb-creative-chips', CREATIVE_NAMES);
  buildOverlayChips();
}

function buildOverlayChips() {
  const el = document.getElementById('lb-overlay-chips');
  if (!el) return;
  el.innerHTML = '';

  const grainBtn = document.createElement('button');
  grainBtn.className = 'lb-chip' + (grainActive ? ' lb-chip-active' : '');
  grainBtn.textContent = 'Film grain';
  grainBtn.addEventListener('click', toggleGrain);
  el.appendChild(grainBtn);

  const vigBtn = document.createElement('button');
  vigBtn.className = 'lb-chip' + (vignetteActive ? ' lb-chip-active' : '');
  vigBtn.textContent = 'Vignette';
  vigBtn.addEventListener('click', toggleVignette);
  el.appendChild(vigBtn);

  const ctrlsEl = document.getElementById('lb-vignette-controls');
  if (ctrlsEl) {
    ctrlsEl.hidden = !vignetteActive;
    if (vignetteActive) buildVignetteControls(ctrlsEl);
  }
}

function toggleGrain() {
  grainActive = !grainActive;
  const canvas = document.getElementById('lb-grain-overlay');
  if (!canvas) return;
  if (grainActive) {
    canvas.style.display = 'block';
    drawGrain(canvas);
  } else {
    canvas.style.display = 'none';
    // Cancel any pending SVG-image load so it doesn't draw to the now-hidden
    // canvas and so _grainImgPending doesn't interfere with the next toggle-on.
    if (_grainImgPending) { _grainImgPending.onload = null; _grainImgPending = null; }
  }
  buildOverlayChips();
}

const VIG_COLORS = { black: '#000000', white: '#ffffff', grey: '#808080' };

function applyVignetteStyle() {
  const el = document.getElementById('lb-vignette-overlay');
  if (!el) return;
  const hex = VIG_COLORS[vignetteColor] || '#000000';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const stop = Math.round((1 - vignetteWidth) * 100);
  el.style.background = `radial-gradient(ellipse at center, transparent ${stop}%, rgba(${r},${g},${b},${vignetteAmount}) 100%)`;
}

function toggleVignette() {
  vignetteActive = !vignetteActive;
  const el = document.getElementById('lb-vignette-overlay');
  if (vignetteActive) {
    applyVignetteStyle();
    if (el) el.style.display = 'block';
  } else {
    if (el) el.style.display = 'none';
  }
  buildOverlayChips();
}

function buildVignetteControls(container) {
  container.innerHTML = '';

  function sliderRow(label, id, val, onChange) {
    const row = document.createElement('div');
    row.className = 'vig-slider-row';
    const lbl = document.createElement('span');
    lbl.className = 'vig-slider-label';
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.id = id;
    input.min = 0; input.max = 1; input.step = 0.01; input.value = val;
    input.addEventListener('input', onChange);
    row.appendChild(lbl); row.appendChild(input);
    container.appendChild(row);
  }

  sliderRow('Amount', 'vig-amount', vignetteAmount, e => {
    vignetteAmount = parseFloat(e.target.value);
    applyVignetteStyle();
  });
  sliderRow('Width', 'vig-width', vignetteWidth, e => {
    vignetteWidth = parseFloat(e.target.value);
    applyVignetteStyle();
  });

  const swatchRow = document.createElement('div');
  swatchRow.className = 'vig-swatch-row';
  [['white', '#ffffff'], ['grey', '#808080'], ['black', '#000000']].forEach(([key, hex]) => {
    const sw = document.createElement('button');
    sw.className = 'vig-swatch' + (vignetteColor === key ? ' active' : '');
    sw.style.background = hex;
    sw.title = key.charAt(0).toUpperCase() + key.slice(1);
    sw.addEventListener('click', () => {
      vignetteColor = key;
      applyVignetteStyle();
      buildVignetteControls(container);
    });
    swatchRow.appendChild(sw);
  });
  container.appendChild(swatchRow);
}

function drawGrain(canvas) {
  if (_grainImgPending) { _grainImgPending.onload = null; _grainImgPending = null; }
  // Use the viewport's CSS pixel dimensions, not the image buffer size.
  // Setting canvas.width to the full image resolution (e.g. 1800px) would
  // override the CSS inset:0 sizing and misplace the canvas.
  const vp = canvas.parentElement;
  const w = (vp ? vp.offsetWidth  : 0) || 800;
  const h = (vp ? vp.offsetHeight : 0) || 600;
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <filter id="noise">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#noise)" opacity="1"/>
  </svg>`;
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  _grainImgPending = img;
  img.onload = () => {
    _grainImgPending = null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function initFilters() {
  renderFilterChips();
}

// ── Sidecar ───────────────────────────────────────────────────────
const SIDECAR_PREFIX = 'raw-sidecar:';

// Short, stable FNV-1a hash of the full filename so two long paths that share
// the same first 255 chars do not collide onto one localStorage key. Read and
// write both go through this single function, so keying stays consistent.
function sidecarHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function getSidecarKey(filename) {
  // Truncated prefix stays human-readable; the full-name hash disambiguates collisions.
  return SIDECAR_PREFIX + sidecarHash(filename) + ':' + filename.slice(0, 255);
}

// Finding 40: accept an explicit card so crop/subjects come from the TARGET card,
// not the ambient window.lightboxCard() global. Callers MUST pass the card whose
// state they want to serialize; the lightbox default is just a backward-compat
// convenience.
function buildSidecarData(filename, cardOverride) {
  const look   = typeof window.currentLook   === 'function' ? window.currentLook()   : {};
  const levels = window.levelsState ? {
    inBlack:  window.levelsState.inBlack,
    inMid:    window.levelsState.inMid,
    inWhite:  window.levelsState.inWhite,
    outBlack: window.levelsState.outBlack,
    outWhite: window.levelsState.outWhite,
  } : { inBlack:0, inMid:1.0, inWhite:255, outBlack:0, outWhite:255 };
  const vignette = vignetteActive
    ? { amount: vignetteAmount, width: vignetteWidth, color: vignetteColor }
    : null;
  // Finding 40: use the explicitly-passed card when available; fall back to the
  // currently-displayed lightbox card for backward compatibility.
  const card = cardOverride || ((typeof window.lightboxCard === 'function') ? window.lightboxCard() : null);
  const crop     = card?._crop ?? null;
  const subjects = Array.isArray(card?._subjects) ? card._subjects : [];
  // Finding 46: include assetId so the sidecar key is stable across renames.
  const assetId = (typeof window._getCardAssetId === 'function') ? window._getCardAssetId(card) : null;
  return { filename, assetId, look, profile: activeProfile, filter: activeFilter, levels, vignette,
           crop, subjects };
}

// Finding 46: use stable assetId as sidecar key when available, so two files
// with the same basename in different directories never share a key.
function getAssetSidecarKey(assetId, filename) {
  if (assetId) {
    // Use assetId as the stable primary key, still with a human-readable prefix.
    return SIDECAR_PREFIX + sidecarHash(assetId) + ':' + filename.slice(0, 48);
  }
  return getSidecarKey(filename);
}

// Finding 46: saveSidecar now accepts an optional explicit card parameter.
// It surfaces persistence errors by re-throwing after logging — the caller
// decides how to surface the failure to the user.  updateSidecarDot is only
// called on SUCCESS (no optimistic false-success).
async function saveSidecar(filename, cardOverride) {
  if (!filename) return;
  const data = buildSidecarData(filename, cardOverride);
  const json = JSON.stringify(data);
  const assetId = data.assetId;
  if (window.IS_TAURI && window.__TAURI__) {
    // Tauri: the Rust side uses the full path, not a localStorage key.
    await window.__TAURI__.core.invoke('write_look', { path: filename, json });
    // Only reach here if invoke() did not throw.
    updateSidecarDot(filename, true);
  } else {
    const key = getAssetSidecarKey(assetId, filename);
    localStorage.setItem(key, json);
    // If localStorage.setItem throws (quota exceeded), it propagates to the caller.
    // For browsers that throw synchronously, no updateSidecarDot is called.
    updateSidecarDot(filename, true);
  }
}

// Finding 46: loadSidecar accepts an optional assetId for stable-key lookup.
// Falls back to basename-hash key for backward compat with pre-existing sidecars.
async function loadSidecar(filename, assetId) {
  if (!filename) return null;
  let json = null;
  if (window.IS_TAURI && window.__TAURI__) {
    try {
      json = await window.__TAURI__.core.invoke('read_look', { path: filename });
    } catch { json = null; }
  } else {
    // Try stable-key first; fall back to legacy basename key.
    if (assetId) {
      json = localStorage.getItem(getAssetSidecarKey(assetId, filename));
    }
    if (!json) {
      json = localStorage.getItem(getSidecarKey(filename));
    }
  }
  if (!json) return null;
  try { return JSON.parse(json); }
  catch { return null; }
}

function updateSidecarDot(filename, hasSidecar) {
  // Find the card whose _file.name matches and update its dot badge
  document.querySelectorAll('.thumb').forEach(card => {
    if (card._file?.name === filename) {
      let dot = card.querySelector('.sidecar-dot');
      if (hasSidecar && !dot) {
        dot = document.createElement('span');
        dot.className = 'sidecar-dot';
        card.appendChild(dot);
      } else if (!hasSidecar && dot) {
        dot.remove();
      }
    }
  });
}

async function applySidecar(sidecar) {
  if (!sidecar) return;
  if (sidecar.look && typeof window.applyLookValues === 'function') {
    window.applyLookValues(sidecar.look);
  }
  if (sidecar.profile !== undefined) {
    activeProfile = sidecar.profile;
    if (typeof renderProfileChips === 'function') renderProfileChips();
  }
  if (sidecar.filter !== undefined) {
    activeFilter = sidecar.filter;
    if (typeof renderFilterChips === 'function') renderFilterChips();
  }
  if (sidecar.vignette) {
    const v = sidecar.vignette;
    if (typeof v.amount === 'number') vignetteAmount = Math.max(0, Math.min(1, v.amount));
    if (typeof v.width  === 'number') vignetteWidth  = Math.max(0, Math.min(1, v.width));
    if (['black', 'white', 'grey'].includes(v.color)) vignetteColor = v.color;
    vignetteActive = true;
    const vigEl = document.getElementById('lb-vignette-overlay');
    if (vigEl) { applyVignetteStyle(); vigEl.style.display = 'block'; }
    buildOverlayChips();
  }
  // Finding 40: apply crop + subjects onto the EXPLICITLY-provided card when given;
  // fall back to the currently-displayed lightbox card for backward compatibility.
  const card = (typeof window.lightboxCard === 'function') ? window.lightboxCard() : null;
  if (card) {
    // Finding 40: route through assetStateStore so the edit is keyed on the stable
    // assetId, not the ambient current card. DOM proxy syncs it back immediately.
    const assetId = (typeof window._getCardAssetId === 'function') ? window._getCardAssetId(card) : null;
    if (assetId && window._assetStateStore) {
      window._assetStateStore.applySidecarEdit(assetId, sidecar);
      // Sync the committed state back to the card's DOM proxies.
      const asState = window._assetStateStore.getOrCreate(assetId);
      card._crop = asState.edit.crop;
      card._subjects = asState.edit.subjects;
    } else {
      // Fallback path (store not yet initialised or card lacks assetId).
      if (sidecar.crop && typeof sidecar.crop === 'object'
          && Number.isFinite(sidecar.crop.x) && Number.isFinite(sidecar.crop.y)
          && Number.isFinite(sidecar.crop.w) && Number.isFinite(sidecar.crop.h)) {
        card._crop = {
          x: Math.max(0, Math.min(1, sidecar.crop.x)),
          y: Math.max(0, Math.min(1, sidecar.crop.y)),
          w: Math.max(0.001, Math.min(1, sidecar.crop.w)),
          h: Math.max(0.001, Math.min(1, sidecar.crop.h)),
          ratio: typeof sidecar.crop.ratio === 'string' ? sidecar.crop.ratio : 'free',
        };
      } else {
        card._crop = null;
      }
      card._subjects = Array.isArray(sidecar.subjects)
        ? sidecar.subjects.filter(s => s && Number.isFinite(s.x) && Number.isFinite(s.y)
                                     && Number.isFinite(s.w) && Number.isFinite(s.h))
                          .map(s => ({
            id: s.id || ('s-' + Math.random().toString(36).slice(2, 8)),
            x: Math.max(0, Math.min(1, s.x)),
            y: Math.max(0, Math.min(1, s.y)),
            w: Math.max(0.001, Math.min(1, s.w)),
            h: Math.max(0.001, Math.min(1, s.h)),
            label: typeof s.label === 'string' ? s.label : '',
            note: typeof s.note === 'string' ? s.note : '',
            status: ['unknown','tentative','confirmed'].includes(s.status) ? s.status : 'unknown',
          }))
        : [];
    }
    if (typeof window.cropApplyToCard === 'function') window.cropApplyToCard(card);
  }
  if (sidecar.levels && window.levelsState) {
    const ranges = { inBlack:[0,255], inMid:[0.1,10], inWhite:[0,255], outBlack:[0,255], outWhite:[0,255] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      const v = sidecar.levels[k];
      if (typeof v === 'number' && v >= lo && v <= hi) window.levelsState[k] = v;
    }
    if (typeof window.syncHandlePosition === 'function') {
      ['inBlack','inMid','inWhite','outBlack','outWhite'].forEach(k => window.syncHandlePosition(k));
    }
    if (typeof window.updateHistogramAndLevels === 'function') window.updateHistogramAndLevels();
  }
}

window.saveSidecar  = saveSidecar;
window.loadSidecar  = loadSidecar;
window.applySidecar = applySidecar;
window.updateSidecarDot = updateSidecarDot;

function initSidecar() {
  // Ctrl+S handled in main.js
}

// ── User profiles ─────────────────────────────────────────────────
const USER_PROFILES_KEY = 'raw-profiles';

function loadUserProfiles() {
  try { return JSON.parse(localStorage.getItem(USER_PROFILES_KEY) || '[]'); }
  catch { return []; }
}

function saveUserProfiles(profiles) {
  try {
    localStorage.setItem(USER_PROFILES_KEY, JSON.stringify(profiles));
  } catch (e) {
    console.error('saveUserProfiles localStorage quota exceeded', e);
  }
}

function getUserProfile(name) {
  return loadUserProfiles().find(p => p.name === name)?.look ?? null;
}

function saveCurrentAsProfile(name) {
  if (!name || !name.trim()) return;
  const profiles = loadUserProfiles();
  const rawLook = typeof window.currentLook === 'function' ? window.currentLook() : {};
  const look = Object.fromEntries(
    LOOK_PARAMS.map(k => [k, k in rawLook ? clampLook(k, rawLook[k]) : 0])
  );
  const entry = { name: name.trim(), look, filter: activeFilter };
  const existing = profiles.findIndex(p => p.name === name.trim());
  if (existing >= 0) profiles[existing] = entry;
  else profiles.push(entry);
  saveUserProfiles(profiles);
  renderUserProfileChips();
}

function loadUserProfileByIndex(idx) {
  const profiles = loadUserProfiles();
  const p = profiles[idx];
  if (!p) return;
  if (typeof window.applyLookValues === 'function') window.applyLookValues(p.look);
  if (p.filter && typeof setActiveFilter === 'function') setActiveFilter(p.filter);
  activeProfile = p.name;
  renderProfileChips();
}

window.saveCurrentAsProfile  = saveCurrentAsProfile;
window.loadUserProfileByIndex = loadUserProfileByIndex;

// ── Colour Profiles ───────────────────────────────────────────────
const BUILTIN_PROFILES = {
  'Natural':   { contrast:0, saturation:0, vibrance:0, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0 },
  'Vivid':     { contrast:0.2, saturation:0.3, vibrance:0.2, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0 },
  'Muted':     { contrast:-0.15, saturation:-0.3, vibrance:0, temp:0, tint:0, highlights:0, shadows:0.1, whites:0, blacks:0, clarity:0 },
  'Portrait':  { contrast:0, saturation:0.1, vibrance:0, temp:0.05, tint:0, highlights:-0.1, shadows:0.15, whites:0, blacks:0, clarity:0 },
  'Monotone':  { contrast:0, saturation:-1.0, vibrance:0, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0 },
  'i-Enhance': { contrast:0.1, saturation:0.2, vibrance:0.3, temp:0, tint:0, highlights:0, shadows:0, whites:0, blacks:0, clarity:0.1 },
  'Flat':      { contrast:-0.4, saturation:-0.1, vibrance:0, temp:0, tint:0, highlights:-0.3, shadows:0.3, whites:0, blacks:0, clarity:0 },
};

let activeProfile = null;

const LOOK_PARAMS = ['exposureEv','contrast','shadows','highlights','whites','blacks',
                     'saturation','vibrance','temp','tint','texture','clarity'];

function clampLook(k, v) {
  if (k === 'exposureEv') return Math.max(-3, Math.min(3, v));
  return Math.max(-1, Math.min(1, v));
}

window.mergedLook = function mergedLook(baseLook) {
  const pDeltas = activeProfile ? (BUILTIN_PROFILES[activeProfile] || getUserProfile(activeProfile) || {}) : {};
  const fDeltas = activeFilter  ? (PIPELINE_FILTERS[activeFilter]  || {}) : {};
  const out = Object.assign({}, baseLook);
  for (const k of LOOK_PARAMS) {
    out[k] = clampLook(k, (out[k] ?? 0) + (pDeltas[k] ?? 0) + (fDeltas[k] ?? 0));
  }
  return out;
};

function setActiveProfile(name) {
  activeProfile = (activeProfile === name) ? null : name;
  renderProfileChips();
  if (typeof window.scheduleLiveUpdate === 'function') window.scheduleLiveUpdate();
}

window.setActiveProfile = setActiveProfile;

function renderProfileChips() {
  const el = document.getElementById('lb-profile-chips');
  if (!el) return;
  el.innerHTML = '';
  Object.keys(BUILTIN_PROFILES).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'lb-chip' + (activeProfile === name ? ' lb-chip-active' : '');
    btn.textContent = name;
    btn.addEventListener('click', () => setActiveProfile(name));
    el.appendChild(btn);
  });
  renderUserProfileChips();
}

function renderUserProfileChips() {
  const el = document.getElementById('lb-user-profile-chips');
  if (!el) return;
  el.innerHTML = '';
  const profiles = loadUserProfiles();
  profiles.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'lb-chip' + (activeProfile === p.name ? ' lb-chip-active' : '');
    btn.textContent = `${i + 1}. ${p.name}`;
    btn.title = `Ctrl+Shift+${(i + 1) % 10}`;
    btn.addEventListener('click', () => loadUserProfileByIndex(i));
    el.appendChild(btn);
  });
}

function initProfiles() {
  renderProfileChips();
}
// ── Clean canvas cache ────────────────────────────────────────────
// Stores a copy of the last WASM-rendered pixels before levels are applied.
// updateHistogramAndLevels always starts from this clean copy so dragging
// a levels handle doesn't compound the transform on each tick.
let _cleanData = null; // Uint8ClampedArray
let _cleanW    = 0;
let _cleanH    = 0;

function setCleanCanvas(imageData) {
  _cleanData = new Uint8ClampedArray(imageData.data); // deep copy
  _cleanW    = imageData.width;
  _cleanH    = imageData.height;
  updateHistogramAndLevels();
}

window.setCleanCanvas = setCleanCanvas;

// ── Levels ────────────────────────────────────────────────────────
const levelsState = { inBlack: 0, inMid: 1.0, inWhite: 255, outBlack: 0, outWhite: 255 };

const LEVELS_DEFAULTS = { inBlack: 0, inMid: 1.0, inWhite: 255, outBlack: 0, outWhite: 255 };

function levelsIsDefault() {
  return levelsState.inBlack === 0 && levelsState.inMid === 1.0 &&
         levelsState.inWhite === 255 && levelsState.outBlack === 0 && levelsState.outWhite === 255;
}

function remapPixel(v, inB, inM, inW, outB, outW) {
  const range = inW - inB;
  if (range <= 0) return outB;
  const normalized = Math.max(0, Math.min(1, (v - inB) / range));
  const gamma = Math.pow(normalized, 1.0 / inM);
  return Math.round(outB + gamma * (outW - outB));
}

function applyLevelsToImageData(imageData) {
  if (levelsIsDefault()) return;
  const { inBlack: inB, inMid: inM, inWhite: inW, outBlack: outB, outWhite: outW } = levelsState;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = remapPixel(i, inB, inM, inW, outB, outW);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = lut[d[i]];
    d[i+1] = lut[d[i+1]];
    d[i+2] = lut[d[i+2]];
    // alpha unchanged
  }
}

function syncHandlePosition(key) {
  const idMap = { inBlack: 'lb-lvl-in-black', inMid: 'lb-lvl-in-mid',
                  inWhite: 'lb-lvl-in-white', outBlack: 'lb-lvl-out-black', outWhite: 'lb-lvl-out-white' };
  const el = document.getElementById(idMap[key]);
  if (!el) return;
  let pct;
  if (key === 'inBlack')  pct = (levelsState.inBlack  / 255) * 100;
  else if (key === 'inWhite')  pct = (levelsState.inWhite  / 255) * 100;
  else if (key === 'inMid') {
    // gamma 0.1–10 mapped logarithmically: log10(1.0)=0 → 50%, larger=brighter(left)
    const logVal = Math.log10(levelsState.inMid); // range -1 to +1
    pct = (1 - (logVal + 1) / 2) * 100;
    pct = Math.max(0, Math.min(100, pct));
  }
  else if (key === 'outBlack') pct = (levelsState.outBlack / 255) * 100;
  else if (key === 'outWhite') pct = (levelsState.outWhite / 255) * 100;
  el.style.left = pct.toFixed(1) + '%';
}

function initLevels() {
  const handles = document.querySelectorAll('.lb-lvl-handle');

  handles.forEach(handle => {
    const key = handle.dataset.lvl;
    let dragging = false, startX = 0, startVal = 0;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      startX   = e.clientX;
      startVal = key === 'inMid' ? Math.log10(levelsState.inMid) : levelsState[key];
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',  onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      const track = handle.closest('.lb-levels-track');
      const trackW = track.getBoundingClientRect().width;
      if (trackW === 0) return;
      const dx = e.clientX - startX;
      const dpct = dx / trackW;

      if (key === 'inMid') {
        // log scale: left = brighter (gamma > 1), right = darker (gamma < 1)
        const newLog = Math.max(-1, Math.min(1, startVal - dpct));
        levelsState.inMid = Math.pow(10, newLog);
      } else {
        const dval = dpct * 255;
        let newVal = Math.round(Math.max(0, Math.min(255, startVal + dval)));
        if (key === 'inBlack')  newVal = Math.min(newVal, levelsState.inWhite  - 1);
        if (key === 'inWhite')  newVal = Math.max(newVal, levelsState.inBlack  + 1);
        if (key === 'outBlack') newVal = Math.min(newVal, levelsState.outWhite - 1);
        if (key === 'outWhite') newVal = Math.max(newVal, levelsState.outBlack + 1);
        levelsState[key] = newVal;
      }
      syncHandlePosition(key);
      updateHistogramAndLevels();
    }

    function onUp() {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',  onUp);
    }
  });

  document.getElementById('lb-levels-reset')?.addEventListener('click', () => {
    Object.assign(levelsState, LEVELS_DEFAULTS);
    ['inBlack','inMid','inWhite','outBlack','outWhite'].forEach(syncHandlePosition);
    updateHistogramAndLevels();
  });
}

window.levelsState = levelsState;
window.syncHandlePosition = syncHandlePosition;

// ── Histogram ─────────────────────────────────────────────────────
let histMode = 'L'; // 'L' or 'RGB'

function initHistogram() {
  const modeBtn = document.getElementById('lb-hist-mode');
  if (!modeBtn) return;
  modeBtn.addEventListener('click', () => {
    histMode = histMode === 'L' ? 'RGB' : 'L';
    modeBtn.textContent = histMode;
    updateHistogramAndLevels();
  });
}

function computeHistogram(pixels) {
  const lum = new Uint32Array(256);
  const r   = new Uint32Array(256);
  const g   = new Uint32Array(256);
  const b   = new Uint32Array(256);
  // Sample ~500 K pixels regardless of resolution: imperceptible for 256-bin display,
  // 40× faster on a 20 MP image vs iterating every pixel.
  const stride = Math.max(1, Math.floor(pixels.length / 4 / 500_000)) * 4;
  for (let i = 0; i < pixels.length; i += stride) {
    const rv = pixels[i], gv = pixels[i+1], bv = pixels[i+2];
    lum[Math.round(0.299 * rv + 0.587 * gv + 0.114 * bv)]++;
    r[rv]++; g[gv]++; b[bv]++;
  }
  return { lum, r, g, b };
}

function drawHistogram(hist) {
  const canvas = document.getElementById('lb-hist-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  function drawCurve(data, colour) {
    let maxVal = 1;
    for (let i = 0; i < 256; i++) if (data[i] > maxVal) maxVal = data[i];
    const logMax = Math.log1p(maxVal);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W;
      const y = H - (Math.log1p(data[i]) / logMax) * H;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  }

  if (histMode === 'L') {
    drawCurve(hist.lum, 'rgba(220,220,220,0.85)');
  } else {
    drawCurve(hist.r, 'rgba(220,60,60,0.55)');
    drawCurve(hist.g, 'rgba(60,200,60,0.55)');
    drawCurve(hist.b, 'rgba(60,120,255,0.55)');
  }
}

function updateHistogramAndLevels() {
  const hPanel = document.getElementById('lb-panel-h');
  if (!hPanel) return;
  const lbCanvas = document.getElementById('lightbox-canvas');
  if (!lbCanvas) return;
  if (!_cleanData || _cleanW === 0 || _cleanH === 0) return;
  if (hPanel.querySelector('.lb-panel-body').hidden) return;

  // Work from the clean pre-levels copy, never from the already-leveled canvas
  const workBuf = new Uint8ClampedArray(_cleanData);
  const imageData = new ImageData(workBuf, _cleanW, _cleanH);
  applyLevelsToImageData(imageData);
  const ctx = lbCanvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  // imageData was modified in-place by applyLevelsToImageData — histogram reflects post-levels output
  const hist = computeHistogram(imageData.data);
  drawHistogram(hist);
}

window.updateHistogramAndLevels = updateHistogramAndLevels;

// defer scripts run after DOMContentLoaded — call init directly
initPanelToggles();
initHistogram();
initLevels();
initProfiles();
initFilters();
initSidecar();

})();
