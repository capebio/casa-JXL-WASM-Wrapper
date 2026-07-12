#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { chromium } from 'playwright';

const REPO = normalize(join(import.meta.dirname, '..', '..'));
const DIST = join(REPO, 'packages', 'jxl-wasm', 'dist');
const CORPUS = join(REPO, 'docs', 'Benchmark results', 'P2200619-prog-p6-q85.jxl');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const resolvePath = (value) => normalize(isAbsolute(value) ? value : join(REPO, value));
const armDirs = {
  a: resolvePath(arg('--a', 'packages/jxl-wasm/dist')),
  b: args.includes('--b') ? resolvePath(arg('--b', 'packages/jxl-wasm/dist')) : null,
};
const mode = arg('--mode', 'final');
const concurrency = Number(arg('--concurrency', '1'));
const reps = Number(arg('--reps', '5'));
const rounds = Number(arg('--rounds', '2'));
const coolMs = Number(arg('--cool-ms', '1500'));
const tier = arg('--tier', 'simd');
const timeoutMs = Number(arg('--timeout-ms', '300000'));

if (!new Set(['final', 'passes']).has(mode)) throw new Error('mode must be final or passes');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error('concurrency must be an integer in [1, 8]');
}
if (!Number.isInteger(reps) || reps < 1) throw new Error('reps must be positive');
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('rounds must be positive');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.jxl', 'application/octet-stream'],
]);
const headers = (type) => ({
  'Content-Type': type,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
});
const send = (res, code, type, data) => {
  res.writeHead(code, headers(type));
  res.end(data);
};
const within = (base, path) => {
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..'));
};

const page = `<!doctype html><meta charset=utf-8><script type=module>
import { createDecoder, setJxlModuleFactoryForTesting } from '/dist/facade.js';
const query = new URL(location.href).searchParams;
const arm = query.get('arm');
const tier = query.get('tier');
const mode = query.get('mode');
const reps = Number(query.get('reps'));
const coolMs = Number(query.get('coolMs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashBytes = bytes => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};
setJxlModuleFactoryForTesting(async () => {
  const createModule = (await import('/' + arm + '/jxl-core.dec.' + tier + '.js')).default;
  return createModule({ locateFile: name => '/' + arm + '/' + name });
});
async function decodeOnce(bytes) {
  const decoder = createDecoder({
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    ...(mode === 'passes' ? { progressiveDetail: 'passes' } : {}),
  });
  let finalPixels = null;
  let width = 0;
  let height = 0;
  let progressFrames = 0;
  const consume = (async () => {
    for await (const event of decoder.events()) {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'progress') progressFrames++;
      if (event.type === 'final') {
        finalPixels = event.pixels instanceof Uint8Array
          ? event.pixels
          : new Uint8Array(event.pixels);
        width = event.info.width;
        height = event.info.height;
      }
    }
  })();
  const started = performance.now();
  if (mode === 'passes') {
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      await decoder.push(bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
      await sleep(0);
    }
  } else {
    await decoder.push(bytes);
  }
  await decoder.close();
  await consume;
  await decoder.dispose();
  const elapsedMs = performance.now() - started;
  if (finalPixels === null) throw new Error('decoder emitted no final frame');
  return {
    elapsedMs,
    width,
    height,
    progressFrames,
    byteHash: hashBytes(finalPixels),
    byteLength: finalPixels.byteLength,
  };
}
(async () => {
  try {
    const bytes = new Uint8Array(await (await fetch('/__corpus')).arrayBuffer());
    await decodeOnce(bytes);
    await sleep(coolMs);
    const samplesMs = [];
    let last = null;
    for (let index = 0; index < reps; index++) {
      last = await decodeOnce(bytes);
      samplesMs.push(last.elapsedMs);
      await sleep(coolMs);
    }
    window.__decodeResult = { ok: true, samplesMs, ...last };
  } catch (error) {
    window.__decodeResult = { ok: false, error: String(error?.stack ?? error) };
  }
})();</script>`;

function startServer() {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') return send(res, 200, mime.get('.html'), page);
      if (url.pathname === '/__corpus') {
        return send(res, 200, mime.get('.jxl'), readFileSync(CORPUS));
      }
      const match = /^\/(dist|a|b)\/(.+)$/.exec(decodeURIComponent(url.pathname));
      if (match === null) return send(res, 404, 'text/plain', 'not found');
      const key = match[1];
      const base = key === 'dist' ? DIST : armDirs[key];
      if (base === null) return send(res, 404, 'text/plain', 'arm unavailable');
      const full = normalize(join(base, match[2]));
      if (!within(base, full)) return send(res, 403, 'text/plain', 'forbidden');
      return send(res, 200, mime.get(extname(full)) ?? 'application/octet-stream', readFileSync(full));
    } catch (error) {
      return send(res, 404, 'text/plain', String(error));
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const sorted = values => [...values].sort((a, b) => a - b);
const percentile = (values, p) => {
  const ordered = sorted(values);
  const position = (ordered.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  const weight = position - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
};
const summarize = runs => {
  const samplesMs = runs.flatMap(run => run.samplesMs);
  const medianMs = percentile(samplesMs, 0.5);
  const iqrMs = percentile(samplesMs, 0.75) - percentile(samplesMs, 0.25);
  const first = runs[0];
  const hashesEqual = runs.every(run => run.byteHash === first.byteHash);
  const shapesEqual = runs.every(run =>
    run.width === first.width && run.height === first.height && run.byteLength === first.byteLength);
  const throughputMpixPerSec = (first.width * first.height / 1e6) / (medianMs / 1000);
  return {
    n: samplesMs.length,
    samplesMs,
    medianMs,
    iqrMs,
    throughputMpixPerSec,
    width: first.width,
    height: first.height,
    byteLength: first.byteLength,
    byteHash: first.byteHash,
    progressFrames: first.progressFrames,
    pxDifferCount: hashesEqual && shapesEqual ? 0 : -1,
    maxAbsDiff: hashesEqual && shapesEqual ? 0 : -1,
    trust: iqrMs / medianMs <= 0.15 ? 'high' : 'low',
  };
};

async function runArm(browser, port, arm) {
  const context = await browser.newContext();
  try {
    const pages = await Promise.all(Array.from({ length: concurrency }, async () => {
      const target = await context.newPage();
      await target.goto(
        `http://127.0.0.1:${port}/?arm=${arm}&tier=${tier}&mode=${mode}&reps=${reps}&coolMs=${coolMs}`,
        { waitUntil: 'load' },
      );
      return target;
    }));
    await Promise.all(pages.map(target =>
      target.waitForFunction(
        () => window.__decodeResult !== undefined,
        undefined,
        { timeout: timeoutMs },
      )));
    const results = await Promise.all(pages.map(target => target.evaluate(() => window.__decodeResult)));
    const failure = results.find(result => !result.ok);
    if (failure) throw new Error(failure.error);
    return results;
  } finally {
    await context.close();
  }
}

for (const [name, dir] of Object.entries(armDirs)) {
  if (dir !== null && !statSync(dir).isDirectory()) throw new Error(`${name} artifact is not a directory: ${dir}`);
}
const kill = setTimeout(() => process.exit(2), timeoutMs + 30000);
const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--enable-features=SharedArrayBuffer'] });
const runs = { a: [], b: [] };
try {
  for (let round = 0; round < rounds; round++) {
    const order = armDirs.b === null
      ? ['a']
      : (round % 2 === 0 ? ['a', 'b'] : ['b', 'a']);
    for (const arm of order) runs[arm].push(...await runArm(browser, port, arm));
  }
} finally {
  await browser.close();
  server.close();
  clearTimeout(kill);
}

const result = {
  corpus: CORPUS,
  mode,
  tier,
  concurrency,
  a: summarize(runs.a),
  ...(armDirs.b === null ? {} : { b: summarize(runs.b) }),
};
if (result.b) {
  result.parity = {
    maxAbsDiff: result.a.byteHash === result.b.byteHash ? 0 : -1,
    pxDifferCount: result.a.byteHash === result.b.byteHash ? 0 : -1,
  };
  result.deltaPct = ((result.b.medianMs - result.a.medianMs) / result.a.medianMs) * 100;
}
console.log(JSON.stringify(result, null, 2));
if (result.a.trust !== 'high' || (result.b && result.b.trust !== 'high')) process.exitCode = 3;
if (result.b && result.parity.maxAbsDiff !== 0) process.exitCode = 4;
