// Pure static-SVG figure generators (strings). No DOM, no deps.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PAD = { l: 70, r: 160, t: 30, b: 60 }; // right pad leaves room for legend

function frame(width, height, xLabel, yLabel, extra = "") {
  return { width, height, plotW: width - PAD.l - PAD.r, plotH: height - PAD.t - PAD.b, xLabel, yLabel, extra };
}
function axes(f, xTicks, yTicks) {
  const x0 = PAD.l, y0 = f.height - PAD.b, x1 = f.width - PAD.r, y1 = PAD.t;
  let s = `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="#444"/>`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="#444"/>`;
  for (const t of xTicks) s += `<line x1="${t.px}" y1="${y0}" x2="${t.px}" y2="${y0+5}" stroke="#444"/><text x="${t.px}" y="${y0+20}" font-size="12" text-anchor="middle" fill="#333">${esc(t.label)}</text>`;
  for (const t of yTicks) s += `<line x1="${x0-5}" y1="${t.py}" x2="${x0}" y2="${t.py}" stroke="#444"/><text x="${x0-10}" y="${t.py+4}" font-size="12" text-anchor="end" fill="#333">${esc(t.label)}</text>`;
  s += `<text x="${(x0+x1)/2}" y="${f.height-15}" font-size="14" text-anchor="middle" fill="#111">${esc(f.xLabel)}</text>`;
  s += `<text x="18" y="${(y0+y1)/2}" font-size="14" text-anchor="middle" fill="#111" transform="rotate(-90 18 ${(y0+y1)/2})">${esc(f.yLabel)}</text>`;
  return s;
}
function legend(f, items) {
  const x = f.width - PAD.r + 15; let y = PAD.t + 10; let s = "";
  for (const it of items) { s += `<rect x="${x}" y="${y-9}" width="12" height="12" fill="${it.color}"/><text x="${x+18}" y="${y+1}" font-size="12" fill="#111">${esc(it.label)}</text>`; y += 20; }
  return s;
}
const ticks = (min, max, n, toPx, fmt = (v)=>v.toFixed(1)) =>
  Array.from({length: n+1}, (_, i) => { const v = min + (max-min)*i/n; return { v, label: fmt(v), ...toPx(v) }; });

export function rdCurve({ series, xLabel = "bpp", yLabel = "butteraugli", width = 800, height = 500 }) {
  const f = frame(width, height, xLabel, yLabel);
  const xs = series.flatMap(s => s.points.map(p => p.x));
  const ys = series.flatMap(s => s.points.map(p => p.y));
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const px = (x) => PAD.l + (xmax===xmin?0:(x-xmin)/(xmax-xmin))*f.plotW;
  const py = (y) => PAD.t + (ymax===ymin?0:(1-(y-ymin)/(ymax-ymin)))*f.plotH;
  let body = axes(f, ticks(xmin, xmax, 5, v=>({px:px(v)})), ticks(ymin, ymax, 5, v=>({py:py(v)})));
  for (const s of series) {
    const pts = s.points.map(p => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
    body += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    for (const p of s.points) body += `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3" fill="${s.color}"/>`;
  }
  body += legend(f, series);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><rect width="${width}" height="${height}" fill="#fff"/>${body}</svg>`;
}

export function paretoPlot(opts) { return rdCurve({ ...opts, xLabel: opts.xLabel || "encode ms", yLabel: opts.yLabel || "bpp" }); }

// Scatter of labelled points (no connecting lines). points = [{x,y,label,color}].
export function scatterPlot({ points, xLabel = "x", yLabel = "y", width = 800, height = 500 }) {
  const f = frame(width, height, xLabel, yLabel);
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const px = (x) => PAD.l + (xmax===xmin?0.5:(x-xmin)/(xmax-xmin))*f.plotW;
  const py = (y) => PAD.t + (ymax===ymin?0.5:(1-(y-ymin)/(ymax-ymin)))*f.plotH;
  let body = axes(f, ticks(xmin, xmax, 5, v=>({px:px(v)})), ticks(ymin, ymax, 5, v=>({py:py(v)})));
  for (const p of points) {
    const cx = px(p.x), cy = py(p.y);
    body += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${p.color||'#333'}" stroke="#fff"/>`;
    body += `<text x="${(cx+8).toFixed(1)}" y="${(cy+4).toFixed(1)}" font-size="11" fill="#111">${esc(p.label)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><rect width="${width}" height="${height}" fill="#fff"/>${body}</svg>`;
}

// Slopegraph: left column = baseline (100), right column = each metric's value. metrics=[{label,value,color}].
export function slopeChart({ metrics, leftLabel = "original", rightLabel = "ours", baseline = 100, yLabel = "% of original", width = 700, height = 440 }) {
  const f = frame(width, height, "", yLabel);
  const vals = [baseline, ...metrics.map(m => m.value)];
  const vmin = Math.min(...vals) * 0.95, vmax = Math.max(...vals) * 1.05;
  const py = (v) => PAD.t + (1 - (v - vmin) / (vmax - vmin)) * f.plotH;
  const xL = PAD.l + f.plotW * 0.25, xR = PAD.l + f.plotW * 0.75;
  let body = axes(f, [], ticks(vmin, vmax, 5, v=>({py:py(v)}), v=>v.toFixed(0)+"%"));
  body += `<text x="${xL}" y="${PAD.t-8}" font-size="13" text-anchor="middle" fill="#111">${esc(leftLabel)}</text>`;
  body += `<text x="${xR}" y="${PAD.t-8}" font-size="13" text-anchor="middle" fill="#111">${esc(rightLabel)}</text>`;
  body += `<line x1="${xL}" y1="${py(baseline)}" x2="${xR}" y2="${py(baseline)}" stroke="#bbb" stroke-dasharray="4 3"/>`;
  for (const m of metrics) {
    const yR = py(m.value);
    body += `<line x1="${xL}" y1="${py(baseline)}" x2="${xR}" y2="${yR}" stroke="${m.color}" stroke-width="2.5"/>`;
    body += `<circle cx="${xL}" cy="${py(baseline)}" r="4" fill="${m.color}"/><circle cx="${xR}" cy="${yR}" r="4" fill="${m.color}"/>`;
    body += `<text x="${xR+10}" y="${(yR+4).toFixed(1)}" font-size="12" fill="#111">${esc(m.label)}: ${m.value.toFixed(0)}%</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><rect width="${width}" height="${height}" fill="#fff"/>${body}</svg>`;
}

export function barChart({ bars, yLabel = "value", xLabel = "", width = 600, height = 400 }) {
  const f = frame(width, height, xLabel, yLabel);
  const max = Math.max(...bars.map(b => b.value), 1);
  const bw = f.plotW / (bars.length * 1.5);
  const py = (v) => PAD.t + (1 - v/max) * f.plotH;
  let body = axes(f, [], ticks(0, max, 5, v=>({py:py(v)}), v=>v.toFixed(0)));
  bars.forEach((b, i) => {
    const x = PAD.l + (i + 0.25) * (f.plotW / bars.length);
    const y = py(b.value), h = (f.height - PAD.b) - y;
    body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${b.color}"/>`;
    // stagger labels up/down on alternating bars so long names don't overlap
    const labelY = f.height - PAD.b + 18 + (i % 2) * 15;
    body += `<line x1="${(x+bw/2).toFixed(1)}" y1="${f.height-PAD.b}" x2="${(x+bw/2).toFixed(1)}" y2="${labelY-9}" stroke="#ccc"/>`;
    body += `<text x="${(x+bw/2).toFixed(1)}" y="${labelY}" font-size="11" text-anchor="middle" fill="#333">${esc(b.label)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><rect width="${width}" height="${height}" fill="#fff"/>${body}</svg>`;
}

// grouped delta bars (e.g. size%/enc%/dec% of ours vs original jxl); reuses barChart per group is enough for v1.
export function deltaChart({ groups, yLabel = "% of original", width = 700, height = 420 }) {
  // groups = [{ label, value, color }] already flattened by the caller (e.g. "size", "enc", "dec").
  return barChart({ bars: groups, yLabel, width, height });
}
