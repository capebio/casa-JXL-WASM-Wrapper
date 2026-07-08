// Measure demosaic-MHC + tone in a REAL browser with the wasm-bindgen-rayon pool engaged
// (initThreadPool). Proves initThreadPool works headless + quantifies the MT speedup over the
// single-thread node baseline (tools/demtone-st.mjs). Runs from the PRIMARY tree (needs
// node_modules/playwright); the MT pkg (built in the worktree via build-parallel-wasm.ps1)
// is copied to ./pkg-mt-orf first. COOP/COEP served inline so crossOriginIsolated → SAB.
//
//   (copy worktree/pkg -> raw-converter-wasm/pkg-mt-orf, then:)  node tools/demtone-mt-run.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./launch-browser.mjs";

const ROOT = process.cwd();
const PKG = "/pkg-mt-orf/raw_converter_wasm.js";
const SEC = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
const MIME = { ".html": "text/html", ".mjs": "application/javascript", ".js": "application/javascript", ".wasm": "application/wasm", ".json": "application/json" };

const PAGE = `<!doctype html><meta charset=utf8><title>demtone-mt</title><body><script type="module">
import init, { initThreadPool, demtone_bench_prepare, demtone_bench_mhc, demtone_bench_tone } from "${PKG}";
const med = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
const mn = a => Math.min(...a);
const t1 = f => { const s = performance.now(); f(); return performance.now()-s; };
(async () => {
  await init();
  const N = navigator.hardwareConcurrency || 4;
  await initThreadPool(N);
  demtone_bench_prepare(5240, 3912);              // real 20MP Olympus sensor
  for (let i=0;i<4;i++){ demtone_bench_mhc(); demtone_bench_tone(); }   // warm the pool
  const mhc=[], tone=[];
  for (let i=0;i<12;i++){ mhc.push(t1(demtone_bench_mhc)); tone.push(t1(demtone_bench_tone)); }
  window.__RESULT__ = { N, crossOriginIsolated: self.crossOriginIsolated,
    mhc_min:mn(mhc), mhc_med:med(mhc), tone_min:mn(tone), tone_med:med(tone) };
})().catch(e => { window.__RESULT__ = { error: String(e) + " :: " + (e && e.stack || "") }; });
</script>`;

function startServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/harness") { rep.writeHead(200, { ...SEC, "Content-Type": "text/html" }); rep.end(PAGE); return; }
      let fp = path.join(ROOT, decodeURIComponent(u.pathname));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { rep.writeHead(404, SEC); rep.end("nf"); return; }
      if (fs.statSync(fp).isDirectory()) {
        // ESM package-dir import (wasm-bindgen-rayon worker does `import('../../..')`):
        // raw wasm-bindgen emits no package.json, so resolve the known entry directly.
        const cand = path.join(fp, "raw_converter_wasm.js");
        if (fs.existsSync(cand)) fp = cand;
        else { rep.writeHead(404, SEC); rep.end("nf-dir"); return; }
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
page.on("requestfailed", (r) => logs.push("[reqfail] " + r.url() + " " + (r.failure()?.errorText || "")));
try {
  await page.goto(`http://127.0.0.1:${port}/harness`, { waitUntil: "load", timeout: 60000 });
  let r;
  try {
    await page.waitForFunction("window.__RESULT__ !== undefined", { timeout: 120000 });
    r = await page.evaluate("window.__RESULT__");
  } catch (e) {
    console.log("=== TIMEOUT / no __RESULT__ — page logs: ===");
    console.log(logs.length ? logs.join("\n") : "(no console/error output)");
    console.log("  crossOriginIsolated:", await page.evaluate("self.crossOriginIsolated").catch(() => "?"));
    throw e;
  }
  console.log("=== DEMOSAIC-MHC + TONE — MULTI-THREAD (browser, initThreadPool) ===");
  if (r.error) { console.log("  ERROR:", r.error); if (logs.length) console.log("  logs:", logs.join(" | ")); }
  else {
    console.log(`  threads=${r.N}  crossOriginIsolated=${r.crossOriginIsolated}`);
    console.log(`  demosaic MHC : min ${r.mhc_min.toFixed(1)}ms  med ${r.mhc_med.toFixed(1)}ms`);
    console.log(`  tone         : min ${r.tone_min.toFixed(1)}ms  med ${r.tone_med.toFixed(1)}ms`);
    console.log(`  demtone total: med ${(r.mhc_med + r.tone_med).toFixed(1)}ms`);
    console.log(`  (ST node baseline was demosaic 371 + tone 757 = 1128ms → MT speedup = ${(1127.8/(r.mhc_med+r.tone_med)).toFixed(2)}×)`);
  }
} finally {
  await close().catch(() => {});
  srv.close();
}
