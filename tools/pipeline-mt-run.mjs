// #3 pipeline A/B in a REAL browser with initThreadPool: sequential (decompress whole →
// demosaic → tone, both MT) vs pipelined (producer decodes strips serially while par_bridge
// consumers demosaic+tone them, overlapping demtone with the serial decode). TRUE alternation,
// min+median, `_equal` byte-identity pin. Runs from PRIMARY (needs playwright); MT pkg copied
// to ./pkg-mt-orf. COOP/COEP served inline → crossOriginIsolated → SAB → threads.
//   (copy worktree/pkg -> raw-converter-wasm/pkg-mt-orf, then:)  node tools/pipeline-mt-run.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./launch-browser.mjs";

const ROOT = process.cwd();
const PKG = "/pkg-mt-orf/raw_converter_wasm.js";
const SEC = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" };
const MIME = { ".html": "text/html", ".mjs": "application/javascript", ".js": "application/javascript", ".wasm": "application/wasm", ".json": "application/json" };

const PAGE = `<!doctype html><meta charset=utf8><body><script type="module">
import init, { initThreadPool, pipeline_bench_prepare, pipeline_bench_pipelined, pipeline_bench_sequential, pipeline_bench_equal } from "${PKG}";
const med = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
const mn = a => Math.min(...a);
const t1 = f => { const s = performance.now(); f(); return performance.now()-s; };
(async () => {
  await init();
  const N = navigator.hardwareConcurrency || 4;
  await initThreadPool(N);
  pipeline_bench_prepare(5240, 3912, 0x1234);
  const equal = pipeline_bench_equal();                       // byte-identity pin
  for (let i=0;i<3;i++){ pipeline_bench_sequential(); pipeline_bench_pipelined(); }  // warm
  const seq=[], pip=[];
  for (let i=0;i<10;i++){ seq.push(t1(pipeline_bench_sequential)); pip.push(t1(pipeline_bench_pipelined)); }
  window.__RESULT__ = { N, crossOriginIsolated: self.crossOriginIsolated, equal,
    seq_min:mn(seq), seq_med:med(seq), pip_min:mn(pip), pip_med:med(pip) };
})().catch(e => { window.__RESULT__ = { error: String(e) + " :: " + (e && e.stack || "") }; });
</script>`;

function startServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/harness") { rep.writeHead(200, { ...SEC, "Content-Type": "text/html" }); rep.end(PAGE); return; }
      let fp = path.join(ROOT, decodeURIComponent(u.pathname));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { rep.writeHead(404, SEC); rep.end("nf"); return; }
      if (fs.statSync(fp).isDirectory()) {  // wasm-bindgen-rayon worker does import('../../..')
        const cand = path.join(fp, "raw_converter_wasm.js");
        if (fs.existsSync(cand)) fp = cand; else { rep.writeHead(404, SEC); rep.end("nf-dir"); return; }
      }
      rep.writeHead(200, { ...SEC, "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/javascript" });
      fs.createReadStream(fp).pipe(rep);
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, port: srv.address().port }));
  });
}

const { srv, port } = await startServer();
const { page, close } = await launch({ headless: true });
const logs = [];
page.on("console", (m) => logs.push("[console] " + m.text()));
page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/harness`, { waitUntil: "load", timeout: 60000 });
  let r;
  try { await page.waitForFunction("window.__RESULT__ !== undefined", { timeout: 120000 }); r = await page.evaluate("window.__RESULT__"); }
  catch (e) { console.log("TIMEOUT — logs:\n" + (logs.join("\n") || "(none)")); throw e; }
  console.log("=== #3 PIPELINE decode∥demtone — MULTI-THREAD (browser, initThreadPool) ===");
  if (r.error) { console.log("  ERROR:", r.error); console.log(logs.join("\n")); }
  else {
    console.log(`  threads=${r.N}  crossOriginIsolated=${r.crossOriginIsolated}  byte-identical=${r.equal}`);
    console.log(`  sequential (decompress→demosaic→tone) : min ${r.seq_min.toFixed(1)}  med ${r.seq_med.toFixed(1)} ms`);
    console.log(`  pipelined  (decode ∥ demosaic+tone)   : min ${r.pip_min.toFixed(1)}  med ${r.pip_med.toFixed(1)} ms`);
    console.log(`  speed-up (seq/pip)                    : min ${(r.seq_min/r.pip_min).toFixed(3)}×  med ${(r.seq_med/r.pip_med).toFixed(3)}×`);
    if (!r.equal) console.log("  !!! CORRECTNESS FAIL: pipelined != sequential");
  }
} finally { await close().catch(() => {}); srv.close(); }
