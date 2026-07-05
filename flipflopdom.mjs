// flipflopdom.mjs — flip-flop timing in a REAL browser (Chrome via Playwright/CDP).
// Sister to flipflop.mjs: same interleaved A/B discipline, stats, and TOON journal,
// but each flip runs IN THE PAGE (or a Worker) so it can touch browser-only APIs —
// OPFS sync access handles, SharedArrayBuffer transfer, createImageBitmap, WASM-in-
// browser. Time is measured in-page with performance.now(); the CDP round-trip is
// BETWEEN flips, never inside the timed region.
//
// Reuses: flipflop.mjs (rotate/stats/summary/verdict), flipflop-metrics (host
// thermal sampler), flipflop-journal (TOON), tools/launch-browser (Playwright CDP).
// Cross-origin isolation (COOP/COEP) is served by an inline static server so SAB +
// OPFS sync handles are available.
//
// Run: node flipflopdom.mjs .flipflop/dom-tests/<name>.mjs --print [--headed]
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { hostname, cpus } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { rotate, pickBaseline, roundsFor, computeSummary, buildVerdict } from './flipflop.mjs';
import { startSampler, nearestSample, throttleVerdict } from './flipflop-metrics.mjs';
import { buildRecord, appendRecord, firstPaintOfDay } from './flipflop-journal.mjs';

const DEFAULT_JOURNAL = 'docs/outputs/timing tests/flipflop/flipflopdom-journal.toon';
const ROOT = process.cwd();

// ---- COOP/COEP static server: crossOriginIsolated → SAB + OPFS sync handles ----
const SEC = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
const MIME = { '.html': 'text/html', '.mjs': 'application/javascript', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };
const IMPORTMAP_HTML = `<script type="importmap">
{
  "imports": {
    "@casabio/jxl-core": "/packages/jxl-core/dist/index.js",
    "@casabio/jxl-core/errors": "/packages/jxl-core/dist/errors.js",
    "@casabio/jxl-core/protocol": "/packages/jxl-core/dist/protocol.js",
    "@casabio/jxl-core/types": "/packages/jxl-core/dist/types.js",
    "@casabio/jxl-wasm": "/packages/jxl-wasm/dist/index.js",
    "@casabio/jxl-worker-browser": "/packages/jxl-worker-browser/dist/index.js",
    "@casabio/jxl-session": "/packages/jxl-session/dist/index.js",
    "@casabio/jxl-scheduler": "/packages/jxl-scheduler/dist/index.js",
    "@casabio/jxl-capabilities": "/packages/jxl-capabilities/dist/index.js"
  }
}
</script>`;
function startServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/__dom__') { rep.writeHead(200, { ...SEC, 'Content-Type': 'text/html' }); rep.end(`<!doctype html><meta charset=utf8><title>flipflopdom</title>${IMPORTMAP_HTML}<body>`); return; }
      const fp = path.join(ROOT, decodeURIComponent(u.pathname));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rep.writeHead(404, SEC); rep.end('not found'); return; }
      rep.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(rep);
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}
const urlFor = (port, abs) => `http://127.0.0.1:${port}/` + path.relative(ROOT, abs).replaceAll('\\', '/');

// ---- the runtime injected into the page: relay to a Worker, or run inline ----
function pageRuntimeSrc({ testUrl, runnerUrl, workerUrl, useWorker }) {
  if (useWorker) {
    const W = new Worker(workerUrl, { type: 'module' });
    let seq = 0; const waiters = new Map();
    W.onmessage = (e) => { const { id, ok, result, error } = e.data; const w = waiters.get(id); if (w) { waiters.delete(id); ok ? w.res(result) : w.rej(new Error(error)); } };
    W.onerror = (e) => { for (const w of waiters.values()) w.rej(new Error('worker error: ' + e.message)); waiters.clear(); };
    const call = (type, payload) => new Promise((res, rej) => { const id = ++seq; waiters.set(id, { res, rej }); W.postMessage({ id, type, ...payload }); });
    window.__ff = { init: () => call('init', { testUrl }), setup: (desc) => call('setup', { desc }), flip: (idx, reps, round) => call('flip', { idx, reps, round }), evalOutputs: (b) => call('eval', { baseIdx: b }) };
  } else {
    let ready = (async () => { const [{ makeRunner }, mod] = await Promise.all([import(runnerUrl), import(testUrl)]); return makeRunner(mod); })();
    window.__ff = { init: async () => { await ready; }, setup: async (d) => (await ready).setup(d), flip: async (i, r, rd) => (await ready).flip(i, r, rd), evalOutputs: async (b) => (await ready).evalOutputs(b) };
  }
}

function validate(meta) {
  if (!meta || !meta.name || !meta.description) throw new Error('test must export name + description');
  if (!Array.isArray(meta.variants) || meta.variants.length < 2) throw new Error('test needs >= 2 variants');
}

export async function runTestDom(testFile, opts) {
  const { srv, port } = await startServer();
  const testAbs = path.resolve(testFile);
  const testUrl = urlFor(port, testAbs);
  const runnerUrl = urlFor(port, path.join(ROOT, '.flipflop/dom-runner.mjs'));
  const workerUrl = urlFor(port, path.join(ROOT, '.flipflop/dom-worker.mjs'));

  const { launch } = await import('./tools/launch-browser.mjs');
  const launched = await launch({ headless: !opts.headed });
  const page = launched.page;
  let rec;
  try {
    await page.goto(`http://127.0.0.1:${port}/__dom__`);
    const isolated = await page.evaluate(() => crossOriginIsolated);
    // read metadata in the page main thread (harmless module eval; no setup/run there)
    const meta = await page.evaluate(async (u) => {
      const m = await import(u);
      return { name: m.name, description: m.description, isAsync: !!m.isAsync, worker: !!m.worker, rounds: m.rounds ?? null,
        variants: (m.variants || []).map((v) => ({ name: v.name, role: v.role || 'primary', baseline: !!v.baseline, qualityThreshold: v.qualityThreshold ?? null })) };
    }, testUrl);
    validate(meta);
    const variants = meta.variants;
    const base = pickBaseline(variants);

    await page.evaluate(pageRuntimeSrc, { testUrl, runnerUrl, workerUrl, useWorker: meta.worker });
    await page.evaluate(() => window.__ff.init());

    const sizes = opts.sizes || [256, 512, 1024, 2048, 4096];
    const types = opts.types || ['dom'];
    const items = [];
    for (const t of types) for (const s of sizes) items.push({ name: `${t}@${s}`, type: t, size: s, width: s, height: s, kind: 'fractal' });

    const sampler = opts.noMetrics ? { samples: [], stop() {} } : startSampler({ intervalMs: opts.samplerMs ?? 500 });
    const flips = []; const quality = {}; const equality = {};
    const reps = opts.innerReps || 1;

    for (const desc of items) {
      await page.evaluate((d) => window.__ff.setup(d), desc);
      const rounds = roundsFor(desc, opts.rounds);
      for (let r = 0; r < rounds; r++) {
        for (const v of rotate(variants, r)) {
          const idx = variants.indexOf(v);
          let res;
          try { res = await page.evaluate(({ idx, reps, r }) => window.__ff.flip(idx, reps, r), { idx, reps, r }); }
          catch (e) {
            console.error(`[flipflopdom] flip failed input=${desc.name} round=${r} variant=${v.name}:`, e.stack || e.message || e);
            flips.push({ input: desc.name, round: r, variant: v.name, ms: NaN, rss_mb: 'n/a', temp_c: 'n/a', freq_ratio: 'n/a', first_paint: r === 0 });
            continue;
          }
          const samp = nearestSample(sampler.samples, performance.now());
          flips.push({ input: desc.name, round: r, variant: v.name, ms: +res.ms.toFixed(3), rss_mb: res.heap_mb ?? 'n/a', temp_c: samp.temp, freq_ratio: samp.freq, first_paint: r === 0, marks: res.marks });
        }
      }
      const ev = await page.evaluate((b) => window.__ff.evalOutputs(b), variants.indexOf(base));
      for (const v of variants) {
        if (v.name === base.name) continue;
        if (ev.equal && ev.equal[v.name] !== undefined) equality[`${desc.name}|${v.name}`] = ev.equal[v.name];
        if (ev.quality && ev.quality[v.name] !== undefined) { quality[`${desc.name}|${v.name}`] = ev.quality[v.name]; quality[`${desc.name}|${v.name}|ok`] = ev.qok ? !!ev.qok[v.name] : true; }
      }
    }
    sampler.stop();

    const thermal = throttleVerdict(sampler.samples);
    const summary = computeSummary(flips, variants, quality, equality);
    thermal.variance_flag = summary.some((row) => row.trust === 'low');
    const verdict = buildVerdict(summary, base.name, thermal);
    const now = new Date();
    const ts = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const marksAgg = (() => {
      const g = {};
      for (const f of flips) if (f.marks) for (const [label, ms] of Object.entries(f.marks)) { const k = `${f.input}|${f.variant}|${label}`; (g[k] ??= { input: f.input, variant: f.variant, label, vals: [] }).vals.push(ms); }
      return Object.values(g).map((x) => ({ input: x.input, variant: x.variant, label: x.label, median_ms: +([...x.vals].sort((a, b) => a - b)[x.vals.length >> 1] ?? 0).toFixed(3) }));
    })();

    let commit = 'n/a'; try { commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'n/a'; } catch {}
    rec = {
      ts, name: meta.name, description: meta.description,
      first_paint_of_day: opts.journal ? firstPaintOfDay(opts.journal, ts.slice(0, 10)) : true,
      env: { commit, host: hostname(), cpu: cpus()[0]?.model ?? 'n/a', cores: cpus().length, node: process.version, runtime: 'chromium', launch_kind: launched.kind, cross_origin_isolated: isolated, os: `${process.platform}-${process.arch}` },
      config: { variants: variants.map((v) => v.name).join(','), baseline: base.name, timing_mode: meta.worker ? 'browser-worker' : 'browser-page', input_source: 'fractal(meta)', rounds: typeof opts.rounds === 'number' ? opts.rounds : 'default', inner_reps: reps, sampler_ms: opts.samplerMs ?? 500 },
      summaryCols: ['input', 'variant', 'role', 'median_warm_ms', 'median_all_ms', 'min_ms', 'stdev_ms', 'saved_pct', 'quality', 'quality_ok', 'trust'],
      summary,
      marksCols: ['input', 'variant', 'label', 'median_ms'], marks: marksAgg,
      flipsCols: ['input', 'round', 'variant', 'ms', 'rss_mb', 'temp_c', 'freq_ratio', 'first_paint'],
      flips: flips.map((f) => ({ input: f.input, round: f.round, variant: f.variant, ms: f.ms, rss_mb: f.rss_mb, temp_c: f.temp_c, freq_ratio: f.freq_ratio, first_paint: f.first_paint })),
      thermal, verdict,
    };
    if (opts.journal && !opts.dry) appendRecord(opts.journal, buildRecord(rec));
  } finally {
    await launched.close().catch(() => {});
    srv.close();
  }
  return rec;
}

function parseArgs(argv) {
  const o = { journal: DEFAULT_JOURNAL, samplerMs: 500, noMetrics: false, print: false, dry: false, headed: false, innerReps: 1 };
  let testFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--rounds') { const r = next(); o.rounds = r.includes(':') ? Object.fromEntries(r.split(',').map((s) => s.split(':').map((x, k) => k ? +x : x.trim()))) : +r; }
    else if (a === '--sizes') o.sizes = next().split(',').map((x) => +x);
    else if (a === '--types') o.types = next().split(',');
    else if (a === '--inner-reps') o.innerReps = +next();
    else if (a === '--sampler-ms') o.samplerMs = +next();
    else if (a === '--journal') o.journal = next();
    else if (a === '--no-metrics') o.noMetrics = true;
    else if (a === '--print') o.print = true;
    else if (a === '--headed') o.headed = true;
    else if (a === '--dry') { o.dry = true; o.rounds = o.rounds ?? 1; }
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--')) testFile = a;
  }
  return { o, testFile };
}

function printSummary(rec) {
  if (!rec) return;
  console.log(`\nflipflopdom: ${rec.name} [${rec.config.timing_mode}, isolated=${rec.env.cross_origin_isolated}] — ${rec.verdict}\n`);
  console.log(rec.summaryCols.join('\t'));
  for (const row of rec.summary) console.log(rec.summaryCols.map((c) => row[c]).join('\t'));
  if (rec.marks && rec.marks.length) {
    console.log('\nper-stage timeline (full path — Δ each stage, ms):');
    const byInput = {};
    for (const m of rec.marks) (byInput[m.input] ??= []).push(m);
    for (const [input, ms] of Object.entries(byInput)) {
      let prev = 0;
      const parts = ms.map((m) => { const d = m.median_ms - prev; prev = m.median_ms; return `${m.label}=${d.toFixed(2)}`; });
      console.log(`  ${input}: ${parts.join('  ')}  (total ${prev.toFixed(2)})`);
    }
  }
}

async function main() {
  const { o, testFile } = parseArgs(process.argv.slice(2));
  if (o.help || !testFile) {
    console.log('Usage: node flipflopdom.mjs <test-file> [--sizes a,b] [--rounds spec] [--inner-reps n] [--journal path] [--no-metrics] [--print] [--headed] [--dry]');
    if (!testFile && !o.help) process.exitCode = 1;
    return;
  }
  const rec = await runTestDom(testFile, o);
  if (o.print || o.dry) printSummary(rec);
  if (rec && !o.dry) console.log(`flipflopdom: appended to ${o.journal}`);
}

if (process.argv[1] && process.argv[1].endsWith('flipflopdom.mjs')) {
  main().catch((e) => { console.error('flipflopdom error:', e.stack || e.message); process.exitCode = 1; });
}
