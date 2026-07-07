// report.js — Self-contained HTML report export.
//
// Generates a downloadable HTML file containing:
//   - Original image (base64)
//   - 4 codec thumbnails at current quality
//   - BD-rate table (5 quality levels: 60, 70, 80, 90, 95)
//   - Butteraugli scores table
//
// Usage: await exportReport(state)
//   state: { rgba, w, h, quality, results, sweepData, file }

import { codecs } from './codecs.js';
import { getButteraugliScore } from './heatmap.js';

const BD_QUALITIES = [60, 70, 80, 90, 95];
const CODEC_KEYS = ['jxl', 'jpeg', 'avif', 'webp'];
const CODEC_NAMES = { jxl: 'JXL', jpeg: 'JPEG', avif: 'AVIF', webp: 'WebP' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtBd(pct) {
    if (pct == null || !Number.isFinite(pct)) return '—';
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

// ── BD-rate ───────────────────────────────────────────────────────────────────

function sortByDist(curve) {
    return [...curve]
        .filter(p => p.bpp > 0 && Number.isFinite(p.butteraugli))
        .sort((a, b) => a.butteraugli - b.butteraugli)
        .map(p => ({ d: p.butteraugli, r: Math.log10(p.bpp) }));
}
function interpRate(pts, d) {
    if (d <= pts[0].d) return pts[0].r;
    if (d >= pts[pts.length - 1].d) return pts[pts.length - 1].r;
    for (let i = 1; i < pts.length; i++) {
        if (d <= pts[i].d) {
            const t = (d - pts[i - 1].d) / (pts[i].d - pts[i - 1].d);
            return pts[i - 1].r + t * (pts[i].r - pts[i - 1].r);
        }
    }
    return pts[pts.length - 1].r;
}
function bdRate(ref, test) {
    const R = sortByDist(ref), T = sortByDist(test);
    if (R.length < 2 || T.length < 2) return null;
    const lo = Math.max(R[0].d, T[0].d);
    const hi = Math.min(R[R.length - 1].d, T[T.length - 1].d);
    if (!(hi > lo)) return null;
    const N = 100;
    let acc = 0;
    for (let i = 0; i < N; i++) {
        const d0 = lo + (hi - lo) * (i / N);
        const d1 = lo + (hi - lo) * ((i + 1) / N);
        const f0 = interpRate(T, d0) - interpRate(R, d0);
        const f1 = interpRate(T, d1) - interpRate(R, d1);
        acc += 0.5 * (f0 + f1) * (d1 - d0);
    }
    return (Math.pow(10, acc / (hi - lo)) - 1) * 100;
}

// ── Canvas → base64 data URL ──────────────────────────────────────────────────

async function rgbaToDataUrl(rgba, w, h, mimeType, quality) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h),
        0, 0
    );
    const blob = await canvas.convertToBlob({ type: mimeType, quality: quality / 100 });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function bytesToDataUrl(bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ── Sweep data collection ──────────────────────────────────────────────────────

async function collectSweep(rgba, w, h) {
    const npx = w * h;
    const sweep = {};
    for (const key of CODEC_KEYS) sweep[key] = [];
    for (const q of BD_QUALITIES) {
        await Promise.all(CODEC_KEYS.map(async (key) => {
            try {
                const encoded = await codecs[key].encode(rgba, w, h, q);
                const decoded = await codecs[key].decode(encoded);
                const butteraugli = getButteraugliScore(rgba, decoded.data, w, h);
                const bpp = (encoded.length * 8) / npx;
                sweep[key].push({ quality: q, bytes: encoded.length, bpp, butteraugli, encMs: 0 });
            } catch (_) { /* skip unsupported */ }
        }));
    }
    return sweep;
}

// ── HTML template ─────────────────────────────────────────────────────────────

function buildHtml({ fileName, genDate, w, h, quality, originalDataUrl, thumbDataUrls, results, sweepData }) {
    const bdRates = {};
    const ref = sweepData.jpeg;
    for (const key of CODEC_KEYS) {
        if (key === 'jpeg') { bdRates[key] = 0; continue; }
        bdRates[key] = bdRate(ref, sweepData[key]);
    }

    const thumbCards = CODEC_KEYS.map(key => {
        const r = results[key];
        if (!r) return `<div class="card"><div class="card-name">${CODEC_NAMES[key]}</div><div class="no-data">no data</div></div>`;
        return `
        <div class="card">
            <div class="card-name">${CODEC_NAMES[key]}</div>
            <img src="${thumbDataUrls[key]}" alt="${CODEC_NAMES[key]} at q${quality}" />
            <div class="meta">
                <span>${fmtBytes(r.bytes)}</span>
                <span>${r.encMs.toFixed(1)} ms enc</span>
                <span>BA: ${Number.isFinite(r.butteraugliScore) ? r.butteraugliScore.toFixed(3) : '—'}</span>
                <span>BD: ${fmtBd(bdRates[key])}</span>
            </div>
        </div>`;
    }).join('\n');

    const butteraugliRows = BD_QUALITIES.map(q => {
        const cells = CODEC_KEYS.map(key => {
            const pt = (sweepData[key] || []).find(p => p.quality === q);
            return `<td>${pt ? pt.butteraugli.toFixed(3) : '—'}</td>`;
        }).join('');
        return `<tr><td>${q}</td>${cells}</tr>`;
    }).join('\n');

    const bdRows = CODEC_KEYS.map(key => {
        const pts = sweepData[key] || [];
        const cells = BD_QUALITIES.map(q => {
            const pt = pts.find(p => p.quality === q);
            return `<td>${pt ? fmtBytes(pt.bytes) : '—'}</td>`;
        }).join('');
        return `<tr><td>${CODEC_NAMES[key]}</td>${cells}<td class="${bdRates[key] < 0 ? 'good' : ''}">${fmtBd(bdRates[key])}</td></tr>`;
    }).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Codec Compare Report — ${fileName}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    h1, h2, h3 { margin: 0 0 0.5rem; }
    h1 { font-size: 1.4rem; color: #f1f5f9; }
    h2 { font-size: 1.1rem; color: #94a3b8; margin-top: 2rem; }
    .meta-row { font-size: 0.8rem; color: #64748b; margin-bottom: 1.5rem; }
    .original img { max-width: 100%; max-height: 400px; border-radius: 8px; }
    .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1rem; min-width: 180px; }
    .card-name { font-weight: 700; font-size: 1rem; margin-bottom: 0.5rem; color: #f1f5f9; }
    .card img { max-width: 100%; border-radius: 4px; }
    .card .meta { font-size: 0.75rem; color: #94a3b8; margin-top: 0.4rem; display: flex; flex-direction: column; gap: 0.2rem; }
    .no-data { font-size: 0.8rem; color: #64748b; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.85rem; }
    th, td { padding: 0.5rem 0.75rem; border: 1px solid #334155; text-align: center; }
    th { background: #1e293b; color: #94a3b8; }
    td.good { color: #4ade80; font-weight: 600; }
    .footer { margin-top: 2rem; font-size: 0.75rem; color: #475569; }
  </style>
</head>
<body>
  <h1>Codec Compare Report</h1>
  <div class="meta-row">
    File: <strong>${fileName}</strong> &nbsp;|&nbsp;
    Dimensions: ${w}×${h} &nbsp;|&nbsp;
    Quality: ${quality} &nbsp;|&nbsp;
    Generated: ${genDate}
  </div>

  <h2>Original</h2>
  <div class="original"><img src="${originalDataUrl}" alt="original" /></div>

  <h2>Codec Thumbnails at Quality ${quality}</h2>
  <div class="cards">${thumbCards}</div>

  <h2>File Sizes (bytes) Across Quality Levels</h2>
  <table>
    <thead><tr><th>Codec</th>${BD_QUALITIES.map(q => `<th>Q${q}</th>`).join('')}<th>BD-Rate vs JPEG</th></tr></thead>
    <tbody>${bdRows}</tbody>
  </table>

  <h2>Butteraugli Scores (JS approx.) Across Quality Levels</h2>
  <table>
    <thead><tr><th>Quality</th>${CODEC_KEYS.map(k => `<th>${CODEC_NAMES[k]}</th>`).join('')}</tr></thead>
    <tbody>${butteraugliRows}</tbody>
  </table>

  <div class="footer">Generated by CasaWASM Codec Compare &mdash; butteraugli scores are JS approximations (not libjxl native). Negative BD-rate = smaller file at equal quality.</div>
</body>
</html>`;
}

// ── Public: exportReport ───────────────────────────────────────────────────────

/**
 * Generate and download a self-contained HTML codec comparison report.
 * @param {object} state - App state object from compare.js.
 */
export async function exportReport(state) {
    const { rgba, w, h, quality, results, sweepData, file } = state;
    const fileName = file ? file.name : 'image';
    const genDate = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Ensure sweep data is available; run a fresh sweep if not.
    const sweep = sweepData || await collectSweep(rgba, w, h);

    // Original as JPEG data URL (compressed for file size).
    const originalDataUrl = await rgbaToDataUrl(rgba, w, h, 'image/jpeg', 90);

    // Thumbnail data URLs for each codec at current quality.
    const thumbDataUrls = {};
    const resultsMap = {};
    for (const key of CODEC_KEYS) {
        const r = results ? results.get(key) : null;
        if (r) {
            thumbDataUrls[key] = await bytesToDataUrl(r.encoded, codecs[key].mimeType);
            resultsMap[key] = { bytes: r.bytes, encMs: r.encMs, butteraugliScore: r.butteraugliScore };
        } else {
            // Encode at current quality for thumbnails.
            try {
                const encoded = await codecs[key].encode(rgba, w, h, quality);
                thumbDataUrls[key] = await bytesToDataUrl(encoded, codecs[key].mimeType);
                resultsMap[key] = { bytes: encoded.length, encMs: 0, butteraugliScore: NaN };
            } catch (_) {
                thumbDataUrls[key] = '';
                resultsMap[key] = null;
            }
        }
    }

    const html = buildHtml({ fileName, genDate, w, h, quality, originalDataUrl, thumbDataUrls, results: resultsMap, sweepData: sweep });

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `codec-compare-${fileName.replace(/\.[^.]+$/, '')}-q${quality}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
