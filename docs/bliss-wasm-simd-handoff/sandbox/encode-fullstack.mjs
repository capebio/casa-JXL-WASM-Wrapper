// Definitive BLISS ENCODE benchmark: scalar / v128 / v128+8-thread in ONE headless-Chromium harness,
// identical real-Gobabeb pixels (decoded from the .bliss test files), median of 15. Encode is
// band-parallel, so MT applies. Writes docs/bliss-encode-accel.json.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, sep, extname } from 'node:path';
import { chromium } from 'playwright';
import { cpus } from 'node:os';

const ROOT = normalize(join(import.meta.dirname));
const CORES = Math.min(cpus().length, 8);
const REPS = 15;
const OUT = String.raw`C:\Foo\raw-converter-wasm\docs\bliss-encode-accel.json`;
const manifest = JSON.parse(readFileSync(join(ROOT, 'mt-data', 'manifest.json'), 'utf8'));
const CONFIGS = [
  { key:'scalar', pkg:'pkg-scalar', threads:0 },
  { key:'v128',   pkg:'pkg',        threads:0 },
  { key:'mt8',    pkg:'pkg-mt',     threads:CORES },
];
const MIME = new Map([['.js','text/javascript'],['.wasm','application/wasm'],['.html','text/html'],['.json','application/json'],['.bliss','application/octet-stream']]);
const HEADERS = t => ({ 'Content-Type':t, 'Cross-Origin-Opener-Policy':'same-origin', 'Cross-Origin-Embedder-Policy':'require-corp', 'Cross-Origin-Resource-Policy':'cross-origin' });

const PAGE = (pkg, threads) => `<!doctype html><meta charset=utf8><body><script type=module>
import initBliss, { bliss_encode, bliss_decode${threads>0?', initThreadPool':''} } from '/${pkg}/bliss_wasm_sandbox.js';
const median = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
(async () => {
 try {
  await initBliss();
  ${threads>0 ? `if(!self.crossOriginIsolated) throw new Error('not COI'); await initThreadPool(${threads});` : ''}
  const manifest = ${JSON.stringify(manifest)};
  const out = {};
  for (const m of manifest){
    const buf = new Uint8Array(await (await fetch('/mt-data/'+m.tag+'.bliss')).arrayBuffer());
    const dec = bliss_decode(buf); // [w LE][h LE][rgb...]
    const w = dec[0]|(dec[1]<<8)|(dec[2]<<16)|(dec[3]<<24), h = dec[4]|(dec[5]<<8)|(dec[6]<<16)|(dec[7]<<24);
    const rgb = dec.subarray(8);
    for (let i=0;i<3;i++) bliss_encode(rgb, w, h, 2, 2); // warm
    const npx = w*h;
    const times=[]; for(let r=0;r<${REPS};r++){ const t=performance.now(); bliss_encode(rgb, w, h, 2, 2); times.push(performance.now()-t); }
    const ms = median(times);
    out[m.tag] = { mp:m.mp, bands:m.bands, medMs:+ms.toFixed(2), mps:+(npx/(ms/1e3)/1e6).toFixed(1) };
  }
  window.__result = { ok:true, coi:self.crossOriginIsolated, out };
 } catch(e){ window.__result = { ok:false, error:String(e&&(e.stack||e.message)||e) }; }
})();
</script>`;

function startServer(){
  const server = createServer((req,res)=>{
    const u = new URL(req.url,'http://127.0.0.1'); const q=u.searchParams;
    if (u.pathname==='/'){ res.writeHead(200,HEADERS('text/html')); res.end(PAGE(q.get('pkg'), Number(q.get('threads')||'0'))); return; }
    let pathname = decodeURIComponent(u.pathname);
    for (const c of CONFIGS){ if (pathname===`/${c.pkg}`||pathname===`/${c.pkg}/`) pathname=`/${c.pkg}/bliss_wasm_sandbox.js`; }
    const full = normalize(join(ROOT, pathname.replace(/^\/+/,''))); const rel=relative(ROOT,full);
    if (rel.startsWith('..')||rel.split(sep).includes('..')){ res.writeHead(403,HEADERS('text/plain')); res.end('no'); return; }
    let data; try { data=readFileSync(full); } catch { res.writeHead(404,HEADERS('text/plain')); res.end('404'); return; }
    res.writeHead(200,HEADERS(MIME.get(extname(full).toLowerCase())??'application/octet-stream')); res.end(data);
  });
  return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,port:server.address().port})));
}
async function runOnce(browser,port,cfg){
  const page=await browser.newPage(); let logs='';
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
  for (let round=0; round<3; round++){
    for (const cfg of CONFIGS){ const r=await runOnce(browser,port,cfg); if(!r.ok){ console.error(`${cfg.key} FAILED:\n${r.log}`); await browser.close(); server.close(); process.exit(1);} (runs[cfg.key]??=[]).push(r); }
  }
} finally { await browser.close(); server.close(); }

const med = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
console.log(`\nBLISS ENCODE full stack — real Gobabeb, headless Chromium, cores=${CORES}, reps=${REPS}`);
const perImage = {};
for (const m of manifest){ const row={};
  for (const c of CONFIGS){ row[c.key]={ mps:med(runs[c.key].map(r=>r.out[m.tag].mps)), medMs:med(runs[c.key].map(r=>r.out[m.tag].medMs)) }; }
  perImage[m.tag]={ mp:m.mp, bands:m.bands, ...row };
  const sc=row.scalar.mps,v=row.v128.mps,mt=row.mt8.mps;
  console.log(`${m.tag.padEnd(9)} ${m.mp}MP ~${m.bands}b:  scalar ${sc.toFixed(1)} → v128 ${v.toFixed(1)} (${(v/sc).toFixed(2)}×) → mt${CORES} ${mt.toFixed(1)} MP/s (${(mt/sc).toFixed(2)}× total)  [${row.scalar.medMs.toFixed(0)}→${row.v128.medMs.toFixed(0)}→${row.mt8.medMs.toFixed(0)} ms]`);
}
const lb=perImage.lightbox, th=perImage.thumbnail, lg=perImage.large;
const accel = {
  note:'BLISS in-browser ENCODE, one grounded run: scalar / v128 / mt8. Real Gobabeb pixels, headless Chromium, median of '+REPS+'. Encode output byte-identical scalar==v128 (see enc-compare.mjs).',
  measuredAt:new Date().toISOString(), corpus:'Gobabeb 10 (Olympus ORF)', cores:CORES, reps:REPS,
  encodeMps:{
    thumbnail512:{ scalar:th.scalar.mps, v128:th.v128.mps, mt8:th.mt8.mps, v128Speedup:+(th.v128.mps/th.scalar.mps).toFixed(2), bands:th.bands },
    lightbox1800:{ scalar:lb.scalar.mps, v128:lb.v128.mps, mt8:lb.mt8.mps, v128Speedup:+(lb.v128.mps/lb.scalar.mps).toFixed(2), mt8SpeedupVsV128:+(lb.mt8.mps/lb.v128.mps).toFixed(2), totalSpeedupVsScalar:+(lb.mt8.mps/lb.scalar.mps).toFixed(2), bands:lb.bands },
    large3400:{ scalar:lg.scalar.mps, v128:lg.v128.mps, mt8:lg.mt8.mps, v128Speedup:+(lg.v128.mps/lg.scalar.mps).toFixed(2), mt8SpeedupVsV128:+(lg.mt8.mps/lg.v128.mps).toFixed(2), totalSpeedupVsScalar:+(lg.mt8.mps/lg.scalar.mps).toFixed(2), bands:lg.bands },
  },
  lightboxMs:{ scalar:lb.scalar.medMs, v128:lb.v128.medMs, mt8:lb.mt8.medMs },
  perImage,
};
writeFileSync(OUT, JSON.stringify(accel,null,2));
console.log(`\nwrote ${OUT}`);
