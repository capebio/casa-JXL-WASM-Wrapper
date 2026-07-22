// Definitive BLISS decode benchmark: scalar / v128-1thread / v128-8thread on IDENTICAL real Gobabeb
// content, ONE substrate (headless Chromium, the deployment target). All three configs are the same
// sandbox crate — only build flags differ (pkg-scalar = no simd; pkg = wasm SIMD; pkg-mt = SIMD +
// wasm-bindgen-rayon threads). Decode output is checked bit-identical across configs. Writes
// docs/bliss-decode-accel.json so every report number traces to this single grounded run.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, sep, extname } from 'node:path';
import { chromium } from 'playwright';
import { cpus } from 'node:os';

const ROOT = normalize(join(import.meta.dirname));
const CORES = Math.min(cpus().length, 8);
const REPS = 15;
const OUT = String.raw`C:\Foo\raw-converter-wasm\docs\bliss-decode-accel.json`;
const manifest = JSON.parse(readFileSync(join(ROOT, 'mt-data', 'manifest.json'), 'utf8'));
// config -> {pkg dir, threads (0 = no pool)}
const CONFIGS = [
  { key:'scalar',  pkg:'pkg-scalar', threads:0, label:'scalar WASM' },
  { key:'v128',    pkg:'pkg',        threads:0, label:'wasm SIMD (v128), 1 thread' },
  { key:'mt8',     pkg:'pkg-mt',     threads:CORES, label:`wasm SIMD + ${CORES} threads` },
];

const MIME = new Map([['.js','text/javascript'],['.wasm','application/wasm'],['.html','text/html'],['.json','application/json'],['.bliss','application/octet-stream']]);
const HEADERS = t => ({ 'Content-Type':t, 'Cross-Origin-Opener-Policy':'same-origin', 'Cross-Origin-Embedder-Policy':'require-corp', 'Cross-Origin-Resource-Policy':'cross-origin' });

const PAGE = (pkg, threads) => `<!doctype html><meta charset=utf8><body><script type=module>
import initBliss, { bliss_decode${threads>0?', initThreadPool':''} } from '/${pkg}/bliss_wasm_sandbox.js';
const median = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
(async () => {
 try {
  await initBliss();
  ${threads>0 ? `if (typeof initThreadPool!=='function') throw new Error('no initThreadPool'); if(!self.crossOriginIsolated) throw new Error('not COI'); await initThreadPool(${threads});` : ''}
  const manifest = ${JSON.stringify(manifest)};
  const out = {};
  for (const m of manifest){
    const buf = new Uint8Array(await (await fetch('/mt-data/'+m.tag+'.bliss')).arrayBuffer());
    let dec = bliss_decode(buf); let checksum=0; for(let i=8;i<dec.length;i+=1021) checksum=(checksum+dec[i])>>>0;
    const npx = m.mp*1e6;
    const times=[]; for(let r=0;r<${REPS};r++){ const t=performance.now(); bliss_decode(buf); times.push(performance.now()-t); }
    const ms = median(times);
    out[m.tag] = { mp:m.mp, bands:m.bands, medMs:+ms.toFixed(2), mps:+(npx/(ms/1e3)/1e6).toFixed(1), checksum };
  }
  window.__result = { ok:true, coi:self.crossOriginIsolated, out };
 } catch(e){ window.__result = { ok:false, error:String(e&&(e.stack||e.message)||e) }; }
})();
</script>`;

function startServer(){
  const server = createServer((req,res)=>{
    const u = new URL(req.url,'http://127.0.0.1');
    const q = u.searchParams;
    if (u.pathname==='/'){ res.writeHead(200,HEADERS('text/html')); res.end(PAGE(q.get('pkg'), Number(q.get('threads')||'0'))); return; }
    let pathname = decodeURIComponent(u.pathname);
    // wasm-bindgen-rayon workerHelpers import('../../..') resolves to the pkg dir → map to main JS
    for (const c of CONFIGS){ if (pathname===`/${c.pkg}`||pathname===`/${c.pkg}/`) pathname=`/${c.pkg}/bliss_wasm_sandbox.js`; }
    const full = normalize(join(ROOT, pathname.replace(/^\/+/,'')));
    const rel = relative(ROOT, full);
    if (rel.startsWith('..')||rel.split(sep).includes('..')){ res.writeHead(403,HEADERS('text/plain')); res.end('no'); return; }
    let data; try { data = readFileSync(full); } catch { res.writeHead(404,HEADERS('text/plain')); res.end('404 '+u.pathname); return; }
    res.writeHead(200,HEADERS(MIME.get(extname(full).toLowerCase())??'application/octet-stream')); res.end(data);
  });
  return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,port:server.address().port})));
}
async function runOnce(browser,port,cfg){
  const page = await browser.newPage(); let logs='';
  page.on('console',m=>logs+='[page] '+m.text()+'\n'); page.on('pageerror',e=>logs+='[err] '+(e.stack||e.message)+'\n');
  await page.goto(`http://127.0.0.1:${port}/?pkg=${cfg.pkg}&threads=${cfg.threads}`,{waitUntil:'load'});
  let r; try { await page.waitForFunction(()=>window.__result!==undefined,{timeout:120000}); r=await page.evaluate(()=>window.__result); }
  catch(e){ r={ok:false,error:'timeout '+e.message}; }
  r.log=logs.trim(); await page.close(); return r;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless:true, args:['--enable-features=SharedArrayBuffer'] });
const runs = {};
try {
  // 3 interleaved rounds to cancel drift
  for (let round=0; round<3; round++){
    for (const cfg of CONFIGS){ const r=await runOnce(browser,port,cfg); if(!r.ok){ console.error(`${cfg.key} FAILED:\n${r.log}`); await browser.close(); server.close(); process.exit(1);} (runs[cfg.key]??=[]).push(r); }
  }
} finally { await browser.close(); server.close(); }

const med = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
// bit-identical parity across configs (per image)
let parity = true;
for (const m of manifest){ const cs = CONFIGS.map(c=>runs[c.key][0].out[m.tag].checksum); if (new Set(cs).size!==1) parity=false; }

console.log(`\nBLISS decode full stack — real Gobabeb, headless Chromium, cores=${CORES}, reps=${REPS}`);
console.log(`crossOriginIsolated: ${runs.mt8[0].coi} · decode bit-identical across configs: ${parity?'PASS':'FAIL'}\n`);
const perImage = {};
for (const m of manifest){
  const row = {};
  for (const c of CONFIGS){ row[c.key] = { mps: med(runs[c.key].map(r=>r.out[m.tag].mps)), medMs: med(runs[c.key].map(r=>r.out[m.tag].medMs)) }; }
  perImage[m.tag] = { mp:m.mp, bands:m.bands, ...row };
  const sc=row.scalar.mps, v=row.v128.mps, mt=row.mt8.mps;
  console.log(`${m.tag.padEnd(9)} ${m.mp}MP ~${m.bands}b:  scalar ${sc.toFixed(1)} → v128 ${v.toFixed(1)} (${(v/sc).toFixed(2)}×) → mt${CORES} ${mt.toFixed(1)} MP/s (${(mt/sc).toFixed(2)}× total)  [${row.scalar.medMs.toFixed(0)}→${row.v128.medMs.toFixed(0)}→${row.mt8.medMs.toFixed(0)} ms]`);
}

// derive the report JSON from THIS single grounded run
const lb = perImage.lightbox, th = perImage.thumbnail, lg = perImage.large;
const accel = {
  note: 'BLISS in-browser decode, one grounded run: scalar / v128 (wasm SIMD, 1 thread) / mt8 (v128 + rayon threads). Identical real-Gobabeb .bliss decoded by all three; output bit-identical. Headless Chromium, COOP/COEP, median of '+REPS+'.',
  measuredAt: new Date().toISOString(),
  corpus: 'Gobabeb 10 (Olympus ORF)', cores: CORES, reps: REPS,
  substrate: { scalar:'WASM, no SIMD', v128:'WASM SIMD, 1 thread', mt8:`WASM SIMD + ${CORES} rayon threads (SharedArrayBuffer)` },
  decodeMps: {
    thumbnail512:  { scalar:th.scalar.mps, v128:th.v128.mps, mt8:th.mt8.mps, v128Speedup:+(th.v128.mps/th.scalar.mps).toFixed(2), bands:th.bands },
    lightbox1800:  { scalar:lb.scalar.mps, v128:lb.v128.mps, mt8:lb.mt8.mps, v128Speedup:+(lb.v128.mps/lb.scalar.mps).toFixed(2), mt8SpeedupVsV128:+(lb.mt8.mps/lb.v128.mps).toFixed(2), totalSpeedupVsScalar:+(lb.mt8.mps/lb.scalar.mps).toFixed(2), bands:lb.bands },
    large3400:     { scalar:lg.scalar.mps, v128:lg.v128.mps, mt8:lg.mt8.mps, v128Speedup:+(lg.v128.mps/lg.scalar.mps).toFixed(2), mt8SpeedupVsV128:+(lg.mt8.mps/lg.v128.mps).toFixed(2), totalSpeedupVsScalar:+(lg.mt8.mps/lg.scalar.mps).toFixed(2), bands:lg.bands },
  },
  coldOpenLightboxMs: { scalar:lb.scalar.medMs, v128:lb.v128.medMs, mt8:lb.mt8.medMs },
  parity: parity ? 'bit-identical decode across scalar / v128 / mt8' : 'PARITY FAILED',
  perImage,
};
writeFileSync(OUT, JSON.stringify(accel,null,2));
console.log(`\nwrote ${OUT}`);
