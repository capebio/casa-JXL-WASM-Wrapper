// perf-dashboard.js — 2 fps (500 ms) poller for window.__perfDebug stats.
//
// Runs standalone (direct tab) or embedded as an iframe inside the main app.
// The main app exposes window.__perfDebug = { scheduler, assetStore, jxlCache }
// ONLY when loaded with ?debug=1 in its URL.
//
// Stats sources:
//   scheduler.getStats()  → activeWorkers, idleWorkers, queueDepth, dedupeSize, draining
//   assetStore.getStats() → allocatedBytes, budgetBytes, hits, misses, evictions
//   jxlCache.getStats()   → hits, misses, totalRequests, hitRate
//
// No behavior change to any source: all reads are plain property accesses.

'use strict';

const POLL_MS = 500;       // 2 fps
const FPS_SAMPLES = 60;    // ring-buffer length for sparkline

// ---- FPS ring buffer (tracks UI refresh rate of this frame) ----
const fpsHistory = new Float32Array(FPS_SAMPLES);
let fpsHead = 0;
let lastFrameTime = performance.now();

// ---- DOM refs (captured once at module evaluation) ----
const barActive     = document.getElementById('bar-active');
const barIdle       = document.getElementById('bar-idle');
const poolActive    = document.getElementById('pool-active');
const poolTotal     = document.getElementById('pool-total');
const fpsLabel      = document.getElementById('fps-label');
const fpsChartEl    = /** @type {HTMLCanvasElement} */ (document.getElementById('fps-chart'));
const memAllocated  = document.getElementById('mem-allocated');
const memBudget     = document.getElementById('mem-budget');
const memMeter      = document.getElementById('mem-meter');
const cacheHitRate  = document.getElementById('cache-hit-rate');
const queueDepthEl  = document.getElementById('queue-depth');
const dedupSizeEl   = document.getElementById('dedup-size');
const drainingEl    = document.getElementById('draining-state');
const debugMissing  = document.getElementById('debug-missing');

const ctx2d = fpsChartEl.getContext('2d');

// ---- Try to locate __perfDebug in same window, parent, or opener ----
function getDebug() {
  if (window.__perfDebug) return window.__perfDebug;
  try { if (window.opener && window.opener !== window && window.opener.__perfDebug) return window.opener.__perfDebug; } catch (_) { /* cross-origin */ }
  try { if (window.parent && window.parent !== window && window.parent.__perfDebug) return window.parent.__perfDebug; } catch (_) { /* cross-origin */ }
  return null;
}

// ---- FPS sparkline drawing ----
function drawFpsChart() {
  const W = fpsChartEl.width;
  const H = fpsChartEl.height;
  ctx2d.clearRect(0, 0, W, H);

  // Reference grid line at 60 fps (midpoint of 0–120 scale).
  const y60 = H - (60 / 120) * H;
  ctx2d.strokeStyle = '#21262d';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, y60);
  ctx2d.lineTo(W, y60);
  ctx2d.stroke();

  // Sparkline: oldest sample on left, newest on right.
  ctx2d.beginPath();
  ctx2d.strokeStyle = '#1f6feb';
  ctx2d.lineWidth = 1.5;
  for (let i = 0; i < FPS_SAMPLES; i++) {
    const idx = (fpsHead + i) % FPS_SAMPLES;
    const fps = Math.min(120, Math.max(0, fpsHistory[idx]));
    const x = (i / (FPS_SAMPLES - 1)) * W;
    const y = H - (fps / 120) * H;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}

// ---- rAF loop — tracks this window's UI refresh rate ----
function onFrame() {
  const now = performance.now();
  const elapsed = now - lastFrameTime;
  if (elapsed > 0) {
    fpsHistory[fpsHead % FPS_SAMPLES] = 1000 / elapsed;
    fpsHead++;
  }
  lastFrameTime = now;
  requestAnimationFrame(onFrame);
}

fpsHistory.fill(0);
requestAnimationFrame(onFrame);

// ---- Poll loop ----
function pollStats() {
  const dbg = getDebug();

  if (!dbg) {
    debugMissing.hidden = false;
    drawFpsChart();
    setTimeout(pollStats, POLL_MS);
    return;
  }
  debugMissing.hidden = true;

  // — Worker pool / scheduler panel —
  if (typeof dbg.scheduler?.getStats === 'function') {
    const s = dbg.scheduler.getStats();
    const active = s.activeWorkers ?? 0;
    const idle   = s.idleWorkers   ?? 0;
    const total  = active + idle;
    const activePct = total > 0 ? ((active / total) * 100).toFixed(1) : '0';
    const idlePct   = total > 0 ? ((idle   / total) * 100).toFixed(1) : '0';
    barActive.style.width   = activePct + '%';
    barIdle.style.width     = idlePct   + '%';
    poolActive.textContent  = String(active);
    poolTotal.textContent   = String(total);
    queueDepthEl.textContent = String(s.queueDepth  ?? 0);
    dedupSizeEl.textContent  = String(s.dedupeSize  ?? 0);
    drainingEl.textContent   = s.draining ? 'yes' : 'no';
  }

  // — Asset store panel —
  if (typeof dbg.assetStore?.getStats === 'function') {
    const a = dbg.assetStore.getStats();
    const alloc  = a.allocatedBytes ?? 0;
    const budget = a.budgetBytes    ?? 0;
    memAllocated.textContent = (alloc  / 1e6).toFixed(1);
    memBudget.textContent    = (budget / 1e6).toFixed(1);
    const fillPct = budget > 0 ? Math.min(100, (alloc / budget) * 100) : 0;
    // Colour gradient: green (low) → orange → red (near-full).
    const hue = Math.round(120 - Math.min(120, fillPct * 1.2));
    memMeter.style.width      = fillPct.toFixed(1) + '%';
    memMeter.style.background = `hsl(${hue},70%,38%)`;
  } else if (typeof dbg.assetStore?.stats === 'function') {
    // Graceful fallback: old-style stats() before getStats() was added.
    const a = dbg.assetStore.stats();
    const alloc  = a.bytes    ?? 0;
    const budget = a.maxBytes ?? 0;
    memAllocated.textContent = (alloc  / 1e6).toFixed(1);
    memBudget.textContent    = (budget / 1e6).toFixed(1);
    const fillPct = budget > 0 ? Math.min(100, (alloc / budget) * 100) : 0;
    const hue = Math.round(120 - Math.min(120, fillPct * 1.2));
    memMeter.style.width      = fillPct.toFixed(1) + '%';
    memMeter.style.background = `hsl(${hue},70%,38%)`;
  }

  // — JXL cache (OPFS hit rate) —
  if (typeof dbg.jxlCache?.getStats === 'function') {
    const c = dbg.jxlCache.getStats();
    const total = c.totalRequests ?? 0;
    cacheHitRate.textContent = total > 0
      ? ((c.hits / total) * 100).toFixed(1) + '%'
      : '—';
  } else if (typeof dbg.jxlCache?.stats === 'function') {
    const c = dbg.jxlCache.stats();
    cacheHitRate.textContent = c.hitRate != null
      ? (c.hitRate * 100).toFixed(1) + '%'
      : '—';
  } else {
    cacheHitRate.textContent = '—';
  }

  // — FPS sparkline —
  const latest = fpsHistory[(fpsHead - 1 + FPS_SAMPLES) % FPS_SAMPLES];
  fpsLabel.textContent = latest > 0 ? latest.toFixed(1) + ' fps' : '— fps';
  drawFpsChart();

  setTimeout(pollStats, POLL_MS);
}

// Start the first poll after a short delay so the DOM is fully rendered.
setTimeout(pollStats, 150);
