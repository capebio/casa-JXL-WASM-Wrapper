// BLISS WASM-MT decode bench: realized band-parallel speedup in headless Chromium (COOP/COEP →
// SharedArrayBuffer + wasm-bindgen-rayon pool). Decodes real Gobabeb .bliss (v128 kernels) at
// threads=1 (serial pool) vs threads=CORES. Same pkg-mt, fresh page load per thread count (the
// pool is once-init per page). Reports MP/s + speedup + bit-identical parity across thread counts.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, normalize, relative, sep, extname } from 'node:path';
import { chromium } from 'playwright';
import { cpus } from 'node:os';

const ROOT = normalize(join(import.meta.dirname));
const PKG = 'pkg-mt';
const CORES = Math.min(cpus().length, 8);
const REPS = 15;
const manifest = JSON.parse(readFileSync(join(ROOT, 'mt-data', 'manifest.json'), 'utf8'));

const MIME = new Map([['.js','text/javascript'],['.mjs','text/javascript'],['.wasm','application/wasm'],['.html','text/html'],['.json','application/json'],['.bliss','application/octet-stream']]);
const HEADERS = t => ({ 'Content-Type':t, 'Cross-Origin-Opener-Policy':'same-origin', 'Cross-Origin-Embedder-Policy':'require-corp', 'Cross-Origin-Resource-Policy':'cross-origin' });

const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import initBliss, { bliss_decode, initThreadPool } from '/${PKG}/bliss_wasm_sandbox.js';
const median = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
(async () => {
 try {
  const threads = Number(new URL(location.href).searchParams.get('threads')||'1');
  await initBliss();
  const iso = self.crossOriginIsolated;
  if (typeof initThreadPool !== 'function') throw new Error('initThreadPool not exported');
  if (!iso) throw new Error('not crossOriginIsolated');
  await initThreadPool(threads);
  const manifest = ${JSON.stringify(manifest)};
  const out = {};
  for (const m of manifest){
    const buf = new Uint8Array(await (await fetch('/mt-data/'+m.tag+'.bliss')).arrayBuffer());
    // warm + checksum
    let dec = bliss_decode(buf); let checksum=0; for(let i=8;i<dec.length;i+=1021) checksum=(checksum+dec[i])>>>0;
    const npx = m.mp*1e6;
    const times=[]; for(let r=0;r<${REPS};r++){ const t=performance.now(); bliss_decode(buf); times.push(performance.now()-t); }
    const ms = median(times);
    out[m.tag] = { mp:m.mp, bands:m.bands, medMs:+ms.toFixed(2), mps:+(npx/(ms/1e3)/1e6).toFixed(1), checksum };
  }
  window.__result = { ok:true, threads, iso, out };
 } catch(e){ window.__result = { ok:false, error:String(e&&(e.stack||e.message)||e) }; }
})();
</script>`;

function startServer(){
  const server = createServer((req,res)=>{
    const u = new URL(req.url,'http://127.0.0.1');
    if (u.pathname==='/'){ res.writeHead(200,HEADERS('text/html')); res.end(PAGE); return; }
    let pathname = decodeURIComponent(u.pathname);
    if (pathname===`/${PKG}`||pathname===`/${PKG}/`) pathname=`/${PKG}/bliss_wasm_sandbox.js`;
    const full = normalize(join(ROOT, pathname.replace(/^\/+/,'')));
    const rel = relative(ROOT, full);
    if (rel.startsWith('..')||rel.split(sep).includes('..')){ res.writeHead(403,HEADERS('text/plain')); res.end('no'); return; }
    let data; try { data = readFileSync(full); } catch { res.writeHead(404,HEADERS('text/plain')); res.end('404 '+u.pathname); return; }
    res.writeHead(200,HEADERS(MIME.get(extname(full).toLowerCase())??'application/octet-stream')); res.end(data);
  });
  return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,port:server.address().port})));
}
async function runOnce(browser,port,threads){
  const page = await browser.newPage(); let logs='';
  page.on('console',m=>logs+='[page] '+m.text()+'\n'); page.on('pageerror',e=>logs+='[err] '+(e.stack||e.message)+'\n'); page.on('requestfailed',r=>logs+='[reqfail] '+r.url()+'\n');
  await page.goto(`http://127.0.0.1:${port}/?threads=${threads}`,{waitUntil:'load'});
  let result; try { await page.waitForFunction(()=>window.__result!==undefined,{timeout:120000}); result=await page.evaluate(()=>window.__result); }
  catch(e){ result={ok:false,error:'timeout '+e.message}; }
  result.log = logs.trim(); await page.close(); return result;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless:true, args:['--enable-features=SharedArrayBuffer'] });
const runs = { st:[], mt:[] };
try {
  for (let round=0; round<3; round++){
    const order = round%2 ? [['mt',CORES],['st',1]] : [['st',1],['mt',CORES]];
    for (const [k,t] of order){ const r = await runOnce(browser,port,t); if(!r.ok){ console.error(`run ${k} threads=${t} FAILED:\n${r.log}`); await browser.close(); server.close(); process.exit(1);} runs[k].push(r); }
  }
} finally { await browser.close(); server.close(); }

const med = xs => xs.slice().sort((a,b)=>a-b)[xs.length>>1];
console.log(`\nBLISS WASM-MT decode — real Gobabeb, cores=${CORES}, reps=${REPS}, pkg=${PKG}`);
console.log(`crossOriginIsolated: ${runs.st[0].iso}`);
for (const m of manifest){
  const st = med(runs.st.map(r=>r.out[m.tag].mps));
  const mt = med(runs.mt.map(r=>r.out[m.tag].mps));
  const parity = runs.st[0].out[m.tag].checksum === runs.mt[0].out[m.tag].checksum;
  console.log(`${m.tag.padEnd(9)} ${m.mp}MP ~${m.bands} bands:  ST(1) ${st.toFixed(1)} → MT(${CORES}) ${mt.toFixed(1)} MP/s  = ${(mt/st).toFixed(2)}×   parity:${parity?'PASS':'FAIL'}`);
}
