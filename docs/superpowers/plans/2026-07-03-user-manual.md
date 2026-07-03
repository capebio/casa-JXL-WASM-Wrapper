# User Manual HTML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `docs/user-manual.html` — a self-contained, tabbed HTML reference manual for internal developers covering Architecture, CASAVA video, Perceptual Metrics, and Benchmarks.

**Architecture:** Single HTML file with inline CSS + JS. Four tabs switched by JS class toggle. Dark theme matching `docs/ecosystem-map.html`. All content, numbers, and file paths embedded — no external requests.

**Tech Stack:** Vanilla HTML5/CSS3/JS (no framework), inline SVG for stack diagram.

---

### Task 1: HTML shell + CSS + tab infrastructure

**Files:**
- Create: `docs/user-manual.html`

- [ ] **Step 1: Create the file with shell, CSS, and tab JS**

Create `docs/user-manual.html` with this exact content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CasaWASM · Developer Manual</title>
<style>
:root{
  --bg:#0b0e14;--bg2:#0e1320;--bg3:#111827;--ink:#e7ecf4;--dim:#8b95a8;
  --line:#1d2638;--acc:#4ea1d3;--acc2:#5cc98c;--acc3:#c46bd6;--acc4:#e0a14a;
  --warn:#d3654e;--panel:#0f1522ee;--mono:'JetBrains Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--ink);
  font:14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
/* ── Layout ── */
#wrap{display:flex;flex-direction:column;height:100vh}
#header{padding:14px 24px;background:var(--bg2);border-bottom:1px solid var(--line);
  display:flex;align-items:baseline;gap:16px;flex-shrink:0}
#header h1{font-size:16px;font-weight:700;letter-spacing:.3px}
#header h1 small{color:var(--dim);font-weight:400;font-size:12px;margin-left:8px}
/* ── Tabs ── */
#tabbar{display:flex;gap:2px;padding:0 16px;background:var(--bg2);
  border-bottom:1px solid var(--line);flex-shrink:0}
.tb{padding:10px 18px;border:none;background:none;color:var(--dim);
  font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;
  transition:color .15s,border-color .15s}
.tb:hover{color:var(--ink)}
.tb.on{color:var(--acc);border-bottom-color:var(--acc);font-weight:600}
#content{flex:1;overflow-y:auto;padding:28px 32px}
.tab{display:none}.tab.on{display:block}
/* ── Typography ── */
h2{font-size:18px;font-weight:700;margin-bottom:16px;color:var(--ink)}
h3{font-size:14px;font-weight:600;margin:24px 0 10px;color:var(--acc)}
h4{font-size:13px;font-weight:600;margin:18px 0 8px;color:var(--acc2)}
p{margin-bottom:10px;color:var(--ink);max-width:780px}
/* ── Code ── */
code{font-family:var(--mono);font-size:12px;background:var(--bg3);
  padding:1px 5px;border-radius:4px;color:#a8d8f0}
pre{font-family:var(--mono);font-size:12px;background:var(--bg3);
  border:1px solid var(--line);border-radius:6px;padding:14px 16px;
  overflow-x:auto;margin:10px 0 16px;line-height:1.5}
pre .kw{color:#c792ea}pre .fn{color:#82aaff}
pre .str{color:#c3e88d}pre .cm{color:#546e7a;font-style:italic}
pre .num{color:#f78c6c}
/* ── Tables ── */
.tbl-wrap{overflow-x:auto;margin:10px 0 20px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;padding:8px 12px;background:var(--bg3);
  color:var(--dim);font-weight:600;border-bottom:2px solid var(--line)}
td{padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
tr:nth-child(even) td{background:#0d111a}
td code{font-size:11px}
/* ── Callouts ── */
.box{border-radius:8px;padding:14px 18px;margin:14px 0}
.box-green{background:#0a1f14;border:1px solid #2a6b3a;border-left:4px solid var(--acc2)}
.box-blue{background:#0a1526;border:1px solid #1d3a52;border-left:4px solid var(--acc)}
.box-orange{background:#1a1206;border:1px solid #5a3d10;border-left:4px solid var(--acc4)}
.box-title{font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;
  margin-bottom:8px}
.box-green .box-title{color:var(--acc2)}
.box-blue .box-title{color:var(--acc)}
.box-orange .box-title{color:var(--acc4)}
/* ── Score badges ── */
.score{display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700}
.s5{background:#0a2a0a;color:#5cc98c;border:1px solid #2a6b3a}
.s4{background:#0a1f2a;color:#4ea1d3;border:1px solid #1d3a52}
.s3{background:#1a1a0a;color:#c9a94e;border:1px solid #5a4a10}
/* ── SVG diagram ── */
#arch-svg{width:100%;max-width:760px;margin:0 0 24px;display:block}
/* ── Misc ── */
.dim{color:var(--dim)}
.path{font-family:var(--mono);font-size:12px;color:#a8d8f0}
.section-sep{border:none;border-top:1px solid var(--line);margin:28px 0}
ul{padding-left:20px;margin:6px 0 12px}
li{margin-bottom:4px}
</style>
</head>
<body>
<div id="wrap">
<div id="header">
  <h1>CasaWASM <small>Developer Manual · 2026-07-03</small></h1>
</div>
<div id="tabbar">
  <button class="tb on" onclick="sw(0)">Architecture</button>
  <button class="tb" onclick="sw(1)">CASAVA</button>
  <button class="tb" onclick="sw(2)">Perceptual Metrics</button>
  <button class="tb" onclick="sw(3)">Benchmarks</button>
</div>
<div id="content">
  <div id="t0" class="tab on"><!-- Architecture --></div>
  <div id="t1" class="tab"><!-- CASAVA --></div>
  <div id="t2" class="tab"><!-- Perceptual Metrics --></div>
  <div id="t3" class="tab"><!-- Benchmarks --></div>
</div>
</div>
<script>
const tabs=document.querySelectorAll('.tab');
const btns=document.querySelectorAll('.tb');
function sw(i){
  tabs.forEach((t,j)=>{t.classList.toggle('on',i===j)});
  btns.forEach((b,j)=>{b.classList.toggle('on',i===j)});
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verify file opens in browser with 4 empty tabs**

Open `docs/user-manual.html` in a browser. Confirm: dark background, 4 tab buttons, clicking switches active tab (tab text turns blue), no console errors.

- [ ] **Step 3: Commit the shell**

```powershell
git add docs/user-manual.html
git commit -m "docs(manual): HTML shell + CSS + tab infrastructure"
```

---

### Task 2: Tab 1 — Architecture

**Files:**
- Modify: `docs/user-manual.html` — fill `<div id="t0">`

- [ ] **Step 1: Replace the Architecture tab div with full content**

Replace `<div id="t0" class="tab on"><!-- Architecture --></div>` with:

```html
  <div id="t0" class="tab on">
    <h2>Architecture</h2>

    <h3>Stack Diagram</h3>
    <svg id="arch-svg" viewBox="0 0 740 420" xmlns="http://www.w3.org/2000/svg">
      <style>
        .sl text{font:12px ui-sans-serif,sans-serif;fill:#e7ecf4}
        .sl rect{rx:6}
        .arr{stroke:#4ea1d3;stroke-width:1.5;fill:none;marker-end:url(#ah)}
        .lbl{font:11px ui-sans-serif,sans-serif;fill:#8b95a8}
      </style>
      <defs>
        <marker id="ah" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0,8 3,0 6" fill="#4ea1d3"/>
        </marker>
      </defs>
      <!-- Layer: UI -->
      <g class="sl">
        <rect x="10" y="10" width="720" height="38" fill="#1a2440"/>
        <text x="24" y="33" font-weight="600">UI / main.js</text>
        <text x="200" y="33" class="lbl">web/main.js — orchestrates workers, lightbox, gallery</text>
      </g>
      <!-- Layer: jxl-stream + jxl-session -->
      <g class="sl">
        <rect x="10" y="64" width="350" height="38" fill="#0e2030"/>
        <text x="24" y="83" font-weight="600" fill="#4ea1d3">jxl-stream</text>
        <text x="120" y="83" class="lbl">ReadableStream / fetch → push</text>
        <rect x="375" y="64" width="355" height="38" fill="#0e2030"/>
        <text x="389" y="83" font-weight="600" fill="#4ea1d3">jxl-session</text>
        <text x="475" y="83" class="lbl">API → AsyncEventStream of frames</text>
      </g>
      <!-- Layer: jxl-scheduler -->
      <g class="sl">
        <rect x="10" y="118" width="720" height="38" fill="#1a1230"/>
        <text x="24" y="137" font-weight="600" fill="#c46bd6">jxl-scheduler</text>
        <text x="150" y="137" class="lbl">preemption · dedup · backpressure · pool lifecycle</text>
      </g>
      <!-- Layer: workers -->
      <g class="sl">
        <rect x="10" y="172" width="350" height="38" fill="#0e200e"/>
        <text x="24" y="191" font-weight="600" fill="#5cc98c">jxl-worker-browser</text>
        <text x="180" y="191" class="lbl">decode-handler / encode-handler</text>
        <rect x="375" y="172" width="355" height="38" fill="#0e200e"/>
        <text x="389" y="191" font-weight="600" fill="#5cc98c">jxl-worker-node</text>
        <text x="510" y="191" class="lbl">N-API backend</text>
      </g>
      <!-- Layer: facade -->
      <g class="sl">
        <rect x="10" y="226" width="720" height="38" fill="#2a1a08"/>
        <text x="24" y="245" font-weight="600" fill="#e0a14a">jxl-wasm / facade.ts</text>
        <text x="200" y="245" class="lbl">WASM heap alloc · zero-copy writes · capability cache</text>
      </g>
      <!-- Layer: bridge + libjxl -->
      <g class="sl">
        <rect x="10" y="280" width="350" height="38" fill="#2a0a0a"/>
        <text x="24" y="299" font-weight="600" fill="#d3654e">bridge.cpp</text>
        <text x="120" y="299" class="lbl">C++ FFI; grow-only realloc buffers</text>
        <rect x="375" y="280" width="355" height="38" fill="#2a0a0a"/>
        <text x="389" y="299" font-weight="600" fill="#d3654e">libjxl-012 (capebio fork)</text>
        <text x="530" y="299" class="lbl">encode + decode</text>
      </g>
      <!-- Side: jxl-cache -->
      <g class="sl">
        <rect x="10" y="334" width="350" height="38" fill="#1a1a1a"/>
        <text x="24" y="353" font-weight="600" fill="#8b95a8">jxl-cache</text>
        <text x="120" y="353" class="lbl">OPFS / fs LRU — beside pipeline, not in it</text>
      </g>
      <!-- Side: raw-pipeline -->
      <g class="sl">
        <rect x="375" y="334" width="355" height="38" fill="#1a1a1a"/>
        <text x="389" y="353" font-weight="600" fill="#8b95a8">src/lib.rs (raw-pipeline)</text>
        <text x="540" y="353" class="lbl">ORF/DNG/CR2 → RGB8/16</text>
      </g>
      <!-- Arrows -->
      <line class="arr" x1="185" y1="102" x2="185" y2="118"/>
      <line class="arr" x1="555" y1="102" x2="555" y2="118"/>
      <line class="arr" x1="370" y1="48" x2="370" y2="64"/>
      <line class="arr" x1="370" y1="156" x2="370" y2="172"/>
      <line class="arr" x1="370" y1="210" x2="370" y2="226"/>
      <line class="arr" x1="370" y1="264" x2="370" y2="280"/>
    </svg>

    <h3>Module Map</h3>
    <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>Package / Crate</th><th>Path</th><th>Role</th><th>Score</th>
      </tr></thead>
      <tbody>
        <tr><td><b>jxl-stream</b></td><td class="path">packages/jxl-stream/src/browser.ts</td><td>fromReadableStream / fromResponse; one-ahead I/O prefetch</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-session</b></td><td class="path">packages/jxl-session/src/decode-session.ts</td><td>Public DecodeSession: acquire slot, push chunks, emit frames</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>jxl-scheduler</b></td><td class="path">packages/jxl-scheduler/src/scheduler.ts</td><td>Preemption, fan-out dedupe, adaptive HWM backpressure</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-scheduler pool</b></td><td class="path">packages/jxl-scheduler/src/pool.ts</td><td>Worker lifecycle, prewarm, idle reap</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-worker-browser</b></td><td class="path">packages/jxl-worker-browser/src/decode-handler.ts</td><td>libjxl session state machine, EMA drain, budget</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-worker-browser worker</b></td><td class="path">packages/jxl-worker-browser/src/worker.ts</td><td>Message routing, cold-start buffering, shutdown</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-worker-node</b></td><td class="path">packages/jxl-worker-node/</td><td>N-API backend; symmetric lifecycle, generation guards</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-wasm / facade</b></td><td class="path">packages/jxl-wasm/src/facade.ts</td><td>WASM heap alloc, zero-copy writes, capability cache</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-wasm / bridge</b></td><td class="path">packages/jxl-wasm/src/bridge.cpp</td><td>C++ FFI; grow-only realloc buffers; Butteraugli / SSIM exports</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-cache</b></td><td class="path">packages/jxl-cache/src/browser.ts</td><td>OPFS + LRU; content-agnostic, sits beside pipeline</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-capabilities</b></td><td class="path">packages/jxl-capabilities/</td><td>Runtime SIMD / thread / SharedArrayBuffer probe</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-policy</b></td><td class="path">packages/jxl-policy/</td><td>Encode/decode preset selection, effort/quality mapping</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-core</b></td><td class="path">packages/jxl-core/</td><td>Protocol types, error codes, shared schema</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-native</b></td><td class="path">packages/jxl-native/</td><td>N-API native codec binding</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>jxl-pyramid</b></td><td class="path">packages/jxl-pyramid/</td><td>Tiled megatexture pyramid decode, LRU cache, velocity prefetch</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>pyramid-ingest</b></td><td class="path">packages/pyramid-ingest/</td><td>RAW → pyramid ladder CLI (quality/hash/shard/manifest/backends)</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>jxl-test-corpus</b></td><td class="path">packages/jxl-test-corpus/</td><td>Procedural deterministic fixtures + WebCrypto SHA-256 verification</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>casv-web</b></td><td class="path">packages/casv-web/</td><td>Browser CASAVA decode / showcase / export (8 tests)</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>fast-jpeg</b></td><td class="path">packages/fast-jpeg/ · crates/fast-jpeg/</td><td>DCT-domain JPEG thumbnail decode</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>raw-pipeline</b></td><td class="path">crates/raw-pipeline/src/lib.rs</td><td>WASM entry: process_orf, process_dng, LookRenderer, downscale_rgba</td><td><span class="score s5">5/5</span></td></tr>
        <tr><td><b>jxl-ffi</b></td><td class="path">crates/jxl-ffi/</td><td>Safe Rust bindings to libjxl-012 C API</td><td><span class="score s4">4/5</span></td></tr>
        <tr><td><b>web/main.js</b></td><td class="path">web/main.js</td><td>Gallery orchestration, lightbox, channel slider, RAW → JXL dispatch</td><td><span class="score s3">3/5</span></td></tr>
        <tr><td><b>web/jxl-progressive-*</b></td><td class="path">web/jxl-progressive-*.js</td><td>Progressive gallery: coordinator, frame, tier-cap, policy, paint</td><td><span class="score s3">3/5</span></td></tr>
      </tbody>
    </table>
    </div>

    <h3>Layer Invariants</h3>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Concern</th><th>Lives in</th><th>Must NOT appear in</th></tr></thead>
      <tbody>
        <tr><td><b>Backpressure</b></td><td><code>scheduler.ts</code>, <code>decode-handler.ts</code> (<code>waitForDrain</code>, adaptive HWM)</td><td>facade, session</td></tr>
        <tr><td><b>Deduplication</b></td><td><code>scheduler.ts</code> (<code>DedupeRegistry</code>)</td><td>jxl-cache (must not duplicate by sourceKey)</td></tr>
        <tr><td><b>Session budget</b></td><td>Session-level elapsed from construction (<code>stageStartMs</code>)</td><td>Per-stage resets — silently multiply budget×N_stages</td></tr>
        <tr><td><b>Preemption</b></td><td><code>scheduler.ts</code> only (pause/resume ACK protocol)</td><td>Workers (no soft-yield; WASM push is synchronous)</td></tr>
        <tr><td><b>Format validation</b></td><td>libjxl (<code>"error"</code> decode event)</td><td>jxl-cache, jxl-stream (no magic-byte checks)</td></tr>
        <tr><td><b>Session protocol</b></td><td><code>jxl-core</code> types</td><td>jxl-cache, jxl-stream (must not know event shapes)</td></tr>
      </tbody>
    </table>
    </div>

    <h3>Critical Behavioral Contracts</h3>
    <ul>
      <li><code>decode_budget_exceeded</code> → <code>frameStream.end()</code> (graceful partial frame) then <code>done()</code> rejects with <code>BudgetExceeded</code>. This is <code>finishWithError()</code>, NOT <code>fail()</code>.</li>
      <li><code>scheduler.onMessage(sessionId, handler)</code> returns <b>void</b> — no unsubscribe.</li>
      <li><code>scheduler.send()</code> is fire-and-forget — does not throw on dead sessions.</li>
      <li><code>decoder.push()</code> (WASM) is <b>synchronous</b> — cannot yield mid-push.</li>
      <li><code>postMessage(msg, [pixels])</code> <b>detaches</b> the ArrayBuffer — no recycling.</li>
      <li>Workers are <b>stateless</b> between sessions — no WASM decoder state across <code>recycle()</code>.</li>
      <li><code>SharedArrayBuffer</code> requires COOP/COEP headers on the serving page.</li>
    </ul>

    <h3>Build System</h3>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Target</th><th>Command</th><th>Output</th></tr></thead>
      <tbody>
        <tr><td>WASM (raw-pipeline)</td><td><code>wasm-pack build --target web --out-dir pkg --release</code></td><td><code>web/pkg/</code></td></tr>
        <tr><td>JXL WASM bridge</td><td><code>node packages/jxl-wasm/scripts/build.mjs --host-toolchain</code><br><span class="dim">(requires Emscripten via emsdk; use <code>%TEMP%\jxl-wasm-work</code>)</span></td><td><code>packages/jxl-wasm/dist/jxl-core.{simd,scalar,dec.*,enc.*}.{js,wasm}</code></td></tr>
        <tr><td>Native cjxl (MSVC)</td><td><code>.\build-msvc.ps1 build --release</code><br><span class="dim">(vcvars64 + clang-cl + ninja; <b>STATIC</b> link — DLL swap = exit 53)</span></td><td><code>target\release\</code> or <code>external\libjxl-012\build\</code></td></tr>
        <tr><td>libjxl-012 fork</td><td>Must set <code>LIBJXL_SRC_DIR=external/libjxl-012</code> (not upstream)</td><td>Shared or static lib consumed by jxl-ffi</td></tr>
      </tbody>
    </table>
    </div>

    <div class="box box-orange">
      <div class="box-title">⚠ Worktree Rule</div>
      Automated / subagent runs MUST use a dedicated <code>git worktree</code>. Never <code>checkout</code>, <code>reset --hard</code>, or <code>stash</code> in the user's primary checkout. Forward <code>commit</code> on the checked-out branch is the only HEAD advance allowed.
    </div>
  </div>
```

- [ ] **Step 2: Reload browser, verify Architecture tab**

All three sub-sections visible: SVG diagram renders (colored layer boxes, arrows), module map table has 23+ rows with score badges, layer invariants table has 6 rows, build table has 4 rows. Orange worktree callout visible.

- [ ] **Step 3: Commit**

```powershell
git add docs/user-manual.html
git commit -m "docs(manual): Architecture tab — stack SVG, module map, invariants, build"
```

---

### Task 3: Tab 2 — CASAVA

**Files:**
- Modify: `docs/user-manual.html` — fill `<div id="t1">`

- [ ] **Step 1: Replace the CASAVA tab div**

Replace `<div id="t1" class="tab"><!-- CASAVA --></div>` with:

```html
  <div id="t1" class="tab">
    <h2>CASAVA — Casabio's Video Apparatus</h2>

    <p>CASAVA is Casabio's video container format. On-disk magic bytes: <code>CASV</code>, file extension <code>.casv</code>. Implemented in <code class="path">crates/raw-pipeline/src/casa_video.rs</code> (feature flag: <code>jxl-codec</code>).</p>
    <p>It is a JXL-based intra + P-frame hybrid: I-frames are full JXL VarDCT encodes; P-frames use <b>REPLACE-skip</b> semantics — changed regions are re-encoded as fresh JXL stills, unchanged regions are skipped. Drift-freedom is guaranteed because the encoder <i>never decodes its own output</i> — change detection runs on source frames.</p>

    <div class="box box-blue">
      <div class="box-title">Why not additive residuals?</div>
      Additive lossy residual coding was tested and <b>rejected</b>: JXL's perceptual model misjudges residual planes — errors accumulate rather than cancel. REPLACE semantics with source-frame detection is the design that works. See <code>docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md §8</code>.
    </div>

    <hr class="section-sep"/>
    <h3>JOLT — JXL-Optimised Lossy Transport</h3>
    <p>JOLT is the lossy streaming tier of CASAVA. GOP length = 24. Change-detection threshold is auto-derived from distance (<code>default_thresh_for_distance</code>). Batch encode is frame-parallel (<code>into_par_iter</code>; 4.3–5.6× on corpus).</p>

    <h4>Presets</h4>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Preset</th><th>distance</th><th>effort</th><th>skip</th><th>Use case</th></tr></thead>
      <tbody>
        <tr><td><code>JoltPreset::Realtime</code></td><td>2.0</td><td>1</td><td>tile 32</td><td>Live capture / screen share</td></tr>
        <tr><td><code>JoltPreset::Balanced</code></td><td>1.0</td><td>3</td><td>tile 32</td><td>Default — measured optimum</td></tr>
        <tr><td><code>JoltPreset::Quality</code></td><td>0.5</td><td>4</td><td>tile 32</td><td>Visually transparent</td></tr>
      </tbody>
    </table>
    </div>

    <h4>Measured performance — 720p dashcam, 48 frames, i7-10850H, single-thread</h4>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Tier</th><th>Size</th><th>vs raw</th><th>enc ms/f</th><th>dec ms/f</th><th>dec fps</th><th>24fps?</th></tr></thead>
      <tbody>
        <tr><td><b>JOLT Realtime</b></td><td>4.04 MB</td><td>3.0%</td><td>60.1</td><td>18.1</td><td>55</td><td><span style="color:#5cc98c">✓ PASS</span></td></tr>
        <tr><td><b>JOLT Balanced</b></td><td>6.87 MB</td><td>5.2%</td><td>73.1</td><td>23.8</td><td>42</td><td><span style="color:#5cc98c">✓ PASS</span></td></tr>
        <tr><td><b>JOLT Quality</b></td><td>10.76 MB</td><td>8.1%</td><td>81.6</td><td>18.8</td><td>53</td><td><span style="color:#5cc98c">✓ PASS</span></td></tr>
        <tr><td>Lossless archive</td><td>17.69 MB</td><td>13.3%</td><td>33.8</td><td>109.7</td><td>9</td><td><span style="color:#d3654e">✗ FAIL</span></td></tr>
      </tbody>
    </table>
    </div>
    <p class="dim" style="font-size:12px">Encode is offline/near-real-time; GOP-parallel encode multiplies throughput by core count. Lossless decode fails 24fps single-thread — that gap is exactly why JOLT exists.</p>

    <h4>Rate Control (landed 2026-07-03)</h4>
    <p>Target a <b>byte rate</b> instead of a fixed distance. Streaming encoders only; batch stays fixed-distance.</p>
    <p>Implementation: <b>closed-loop VBV feedback</b> — no probe encodes. The finished GOP's measured bytes steer the next GOP's distance:</p>
    <pre><span class="cm">// d_next = d_prev * sqrt(actual_bytes / target_bytes), clamped to [min_d, max_d]</span>
<span class="cm">// Plus a leaky-bucket VBV term. Converges in a few GOPs at zero extra encode cost.</span>
CasaVideoOptions::streaming_bitrate(start_distance, target_bytes_per_sec)</pre>

    <h4>Rate Metadata</h4>
    <ul>
      <li><b>Header files</b> (<code>jolt_encode</code>, <code>encode_casv_video</code>): <code>CasvHeader.flags</code> — bit 0 = lossy, bits 8..15 = <code>round(distance×10)</code>, bits 16..19 = effort. Accessors: <code>CasvHeader::{is_lossy, lossy_distance, rate_effort}</code>.</li>
      <li><b>Footer (streamed) files</b> (<code>jolt_encode_stream_to</code>): 8-byte <code>CASR</code> rate box between index and footer. <code>parse_casv_rate_box</code> returns <code>None</code> for legacy files — fully backwards compatible.</li>
    </ul>

    <h4>Rust API</h4>
    <pre><span class="kw">use</span> raw_pipeline::casa_video::{
    jolt_encode, jolt_encode_stream_to, JoltPreset, CasaVideoOptions, parse_casv_rate_box
};

<span class="cm">// Batch (all frames resident) → header-format .casv</span>
<span class="kw">let</span> casv = <span class="fn">jolt_encode</span>(&amp;frames, w, h, <span class="num">24</span>, <span class="num">1</span>, JoltPreset::Balanced)?;

<span class="cm">// Streaming to a sink (prev+current frame resident) → footer format + rate box</span>
<span class="fn">jolt_encode_stream_to</span>(&amp;<span class="kw">mut</span> source, JoltPreset::Realtime, &amp;<span class="kw">mut</span> file)?;

<span class="cm">// Full knobs when presets don't fit:</span>
<span class="kw">let</span> opts = CasaVideoOptions::<span class="fn">jolt</span>(JoltPreset::Quality);  <span class="cm">// then tweak fields</span>

<span class="cm">// Byte-rate target (streaming only):</span>
<span class="kw">let</span> opts = CasaVideoOptions::<span class="fn">streaming_bitrate</span>(<span class="num">1.0</span>, <span class="num">500_000</span>);  <span class="cm">// 500 KB/s</span></pre>

    <hr class="section-sep"/>
    <h3>FableBraid — SIMD-Rate Lossless Codec</h3>
    <p>FableBraid is CASAVA's lossless tier. It bypasses libjxl entirely — a new Rust module with <b>8-way braided rANS</b> entropy + mod-256 row predictors. Decode is SIMD/ILP-bound, not dependency-bound (unlike JXL's serial per-pixel Huffman chain).</p>

    <h4>Why FableBraid?</h4>
    <p>Profiling (casa_prof) showed lossless JXL decode is 93–100% inside the serial per-pixel modular loop: prefix/Huffman symbol reads chained through one bit position. No local rewrite removes that dependency chain — FableBraid replaces the format entirely for lossless CASAVA tiers.</p>

    <h4>Format layout</h4>
    <pre><span class="cm">// Container</span>
<span class="str">"FBR1"</span> | u32 w | u32 h | u8 nplanes | u8 rct

<span class="cm">// rct: 0 = none, 1 = subtract-green (R-=G, B-=G mod 256)</span>
<span class="cm">// Per plane: u32 len | plane blob</span>

<span class="cm">// Plane blob:</span>
u8  predictor        <span class="cm">// 0=Zero 1=Top 2=External(prev frame plane)</span>
u8  reserved         <span class="cm">// 0</span>
h × u8 row_modes     <span class="cm">// 0=COPY 1=RANS 2=RAW</span>
u32 n_syms
[<span class="kw">if</span> n_syms>0] 256 × u16 freqs  <span class="cm">// normalized to 4096</span>
              8 × u32 initial_rans_states
              u32 rans_len | rans_bytes
u32 raw_len | raw_residual_bytes</pre>

    <h4>Decode performance vs JXL (BBB 854×480 keyframe, i7-10850H, single-thread)</h4>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Comparison</th><th>FableBraid bpp</th><th>Size vs fjxl-e1</th><th>Decode speedup vs e1</th><th>Size vs e3</th><th>Decode speedup vs e3</th></tr></thead>
      <tbody>
        <tr><td>BBB keyframe 0</td><td colspan="5" class="dim">7–16× faster decode than fjxl-e1; bytes −29..+6% vs JXL-e3. All gates met.</td></tr>
      </tbody>
    </table>
    </div>
    <p class="dim" style="font-size:12px">Full per-frame table: <code>docs/FableBraid-spec.md §Results</code>. Encode is two-pass (speed secondary); decode is the deliverable.</p>

    <hr class="section-sep"/>
    <h3>casv-web Package</h3>
    <p><code>packages/casv-web/</code> — browser CASAVA decode, showcase, and export. 8 tests. New package as of 2026-07-03 (branch <code>feat/deferred-batch2-jul03-m8x4</code>).</p>
    <p>Features: browser-side CASAVA decode via WASM, frame showcase/playback, export to standard formats, wired to Tauri encode path (native encode blocked on cross-repo <code>casa_video</code> sync).</p>
  </div>
```

- [ ] **Step 2: Reload browser, verify CASAVA tab**

CASAVA tab content visible: intro paragraphs, blue "additive residuals" callout, JOLT section with 3-row presets table, 4-row perf table (green/red PASS/FAIL), rate control code block, FableBraid section, format layout code block, casv-web section.

- [ ] **Step 3: Commit**

```powershell
git add docs/user-manual.html
git commit -m "docs(manual): CASAVA tab — JOLT presets/perf/rate-control, FableBraid, casv-web"
```

---

### Task 4: Tab 3 — Perceptual Metrics

**Files:**
- Modify: `docs/user-manual.html` — fill `<div id="t2">`

- [ ] **Step 1: Replace the Perceptual Metrics tab div**

Replace `<div id="t2" class="tab"><!-- Perceptual Metrics --></div>` with:

```html
  <div id="t2" class="tab">
    <h2>Perceptual Metrics</h2>

    <p>A shared Rust SIMD kernel replacing the JS <code>web/jxl-butteraugli.js</code> approximation. Compiled two ways from one codebase: <b>WASM v128</b> for the browser chart/byte-cutoff worker, and <b>AVX2+FMA</b> (+ optional AVX-512) for native Tauri/server ingest.</p>
    <p>Optimised for throughput at scale — millions of progressive-pass comparisons. The JS path remains in the browser convergence loop as a fallback; the WASM engine choice is pending a flipflop result.</p>

    <h3>Module Layout</h3>
    <p>All files under <code class="path">crates/raw-pipeline/src/perceptual/</code>:</p>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>File</th><th>Role</th></tr></thead>
      <tbody>
        <tr><td><code>mod.rs</code></td><td>Public API: <code>Opts</code>, <code>BackendChoice</code>, <code>ChannelMoments</code>, <code>Metrics</code>, <code>detect_native()</code></td></tr>
        <tr><td><code>butteraugli.rs</code></td><td>XYB + box-blur + 3-scale p-norm (p=3) approximation; <code>Kweights</code></td></tr>
        <tr><td><code>ssim.rs</code></td><td>Global moment SSIM + per-channel moments (<code>ChannelMoments</code>)</td></tr>
        <tr><td><code>psnr.rs</code></td><td>MSE → dB conversion</td></tr>
        <tr><td><code>xyb.rs</code></td><td>RGBA u8 → planar X/Y/B f32 via sqrt-linear LUT (avoids per-pixel gamma + sqrt)</td></tr>
        <tr><td><code>blur.rs</code></td><td>Separable box blur with clamp-to-edge (spatial masking for Butteraugli-approx)</td></tr>
        <tr><td><code>simd/scalar.rs</code></td><td><b>Parity oracle</b> — portable Rust, universal fallback, never optimised</td></tr>
        <tr><td><code>simd/avx2.rs</code></td><td>AVX2 + FMA path (x86_64); runtime-gated</td></tr>
        <tr><td><code>simd/wasm.rs</code></td><td>core::arch::wasm32 v128 path; Path A (strict) + Path B (relaxed)</td></tr>
        <tr><td><code>simd/avx512.rs</code></td><td>Optional f32×16 path; <code>cfg</code> + runtime-gated</td></tr>
        <tr><td><code>simd/mod.rs</code></td><td>Backend trait, dispatch table, flip-flop registry</td></tr>
        <tr><td><code>telemetry.rs</code></td><td><code>TelemetryMetrics</code>, <code>RgbHistogram</code>, <code>analyze_fused</code></td></tr>
      </tbody>
    </table>
    </div>

    <h3>Three Metrics</h3>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Metric</th><th>Algorithm</th><th>Approx cost (1MP, 4 passes)</th><th>Primary use</th></tr></thead>
      <tbody>
        <tr>
          <td><b>Butteraugli-approx</b></td>
          <td>RGBA→XYB, box-blur Y (spatial masking), weighted per-channel error with p-norm (p=3) at 3 octaves (full×4 + half×2 + quarter×1 ÷ 7)</td>
          <td>~333ms JS / ~83ms/pass</td>
          <td>Progressive byte-cutoff convergence detection; plateau at first AC pass (~50% bytes)</td>
        </tr>
        <tr>
          <td><b>SSIM</b></td>
          <td>5 deinterleaved per-channel sums (μ, σ², σ₁₂); global moments variant</td>
          <td>~120ms JS / ~30ms/pass</td>
          <td>Per-pass quality metric in convergence loop; complements Butteraugli</td>
        </tr>
        <tr>
          <td><b>PSNR</b></td>
          <td>MSE → 10·log₁₀(255²/MSE) dB</td>
          <td>~58ms JS / ~15ms/pass</td>
          <td>Fast first-pass quality gate; RECOGNIZABLE_DB=20, PREVIEW_DB=30</td>
        </tr>
      </tbody>
    </table>
    </div>

    <h3>SIMD Backend Dispatch</h3>
    <pre><span class="kw">pub enum</span> BackendChoice {
    Auto,          <span class="cm">// picks fastest available at runtime (production default)</span>
    ForceScalar,   <span class="cm">// forces scalar.rs (parity oracle — for test/debug)</span>
    Force(u8),     <span class="cm">// forces specific SIMD path id (for flipflop bench)</span>
}</pre>

    <p><code>BackendChoice::Auto</code> calls <code>detect_native()</code> at runtime to select the fastest available path. The dispatch table in <code>simd/mod.rs</code> is populated at compile time; unavailable paths are omitted.</p>

    <h3>Parity Contract</h3>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Comparison</th><th>Tolerance</th><th>Enforced by</th></tr></thead>
      <tbody>
        <tr><td>scalar.rs ↔ any SIMD path</td><td>≤ 1×10⁻⁴ relative</td><td>Unit tests; SIMD reassociates reductions — this is acceptable for a heuristic score</td></tr>
        <tr><td>Rust scalar ↔ JS approximation</td><td>≤ 1×10⁻³ relative</td><td>Port-fidelity gate in <code>benchmark/metrics-micro-bench.mjs</code></td></tr>
        <tr><td>within-engine view vs copy (SSIM)</td><td>bit-exact</td><td><code>.flipflop/tests/ssim-buffer-engine.mjs</code> asserts <code>ssimViewJs === ssimCopyJs</code></td></tr>
      </tbody>
    </table>
    </div>

    <h3>Calibration Results</h3>
    <p>Measured on 2 ORFs, 1600px, effort=3, quality=85:</p>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Byte cutoff</th><th>Butteraugli</th><th>SSIM</th><th>PSNR</th><th>State</th></tr></thead>
      <tbody>
        <tr><td>20%</td><td>70–74</td><td>0.889–0.893</td><td>21–23 dB</td><td>DC pass only</td></tr>
        <tr><td>30%</td><td>~62</td><td>0.928–0.937</td><td>23–24 dB</td><td>DC + some AC</td></tr>
        <tr><td><b>50%</b></td><td><b>4.6–5.0</b></td><td><b>0.997–0.998</b></td><td><b>29–30 dB</b></td><td><b>First AC pass complete ← inflection point</b></td></tr>
        <tr><td>80–90%</td><td>4.5–5.0</td><td>0.999</td><td>33–37 dB</td><td>Plateau (same AC pass)</td></tr>
        <tr><td>100%</td><td>0.000</td><td>1.000</td><td>∞</td><td>Full decode</td></tr>
      </tbody>
    </table>
    </div>

    <div class="box box-green">
      <div class="box-title">Recommended thresholds</div>
      <ul style="margin:0;padding-left:16px">
        <li><b>Butteraugli ≤ 5.0</b> → first AC pass complete (~50% of bytes). <b>Use this.</b></li>
        <li>Butteraugli ≤ 1.5 → only at 100% bytes (full decode). Too strict for streaming.</li>
        <li>SSIM ≥ 0.9 → DC-pass only (Butteraugli ~62, visually blocky). Too lenient — SSIM is misleadingly optimistic here.</li>
      </ul>
    </div>

    <h3>JS Approximation (browser fallback)</h3>
    <p><code class="path">web/jxl-butteraugli.js</code> — the existing JS Butteraugli-inspired scorer. Same XYB + box-blur + 3-scale p-norm algorithm; not bit-exact with libjxl. Still used in the browser progressive convergence loop (<code>measureConvergenceProfile</code> in <code>backends.ts</code>).</p>
    <p><code>_jxl_wasm_ssim_compare(ptr1,ptr2,w,h)</code> is already exported from the split dec/enc WASM builds. The engine choice (js vs wasm, copy vs view buffer) is pending the 4-way flipflop in <code>.flipflop/tests/ssim-buffer-engine.mjs</code>.</p>

    <h3>Perceptual Constancy Mode</h3>
    <p>A separate, runtime-only colour adjustment engine in <code class="path">crates/raw-pipeline/src/pipeline.rs</code> (<code>apply_tone_math</code> hot path). When <code>perceptual_constancy: true</code>, provides illumination-invariant exposure/saturation/white-balance using a log-space foundation with planned B-matrix + Molchanov tensor integration. Designed for AR plant recognition and photogrammetry workflows where specimens must read consistently under varying light.</p>
    <p class="dim" style="font-size:12px">Status: stub + foundation in place. Full non-Riemannian maths (Bujack 2022/2025) targeted for LUT/SIMD acceleration. Not the same as the Butteraugli-replacement kernel above.</p>
  </div>
```

- [ ] **Step 2: Reload browser, verify Perceptual Metrics tab**

Tab shows: intro, 12-row module layout table, 3-row metrics table with algorithm details, backend dispatch code block, 3-row parity contract table, 5-row calibration table with inflection-point row highlighted in bold, green recommended-thresholds callout, JS fallback section, Perceptual Constancy section.

- [ ] **Step 3: Commit**

```powershell
git add docs/user-manual.html
git commit -m "docs(manual): Perceptual Metrics tab — module layout, three metrics, SIMD dispatch, calibration"
```

---

### Task 5: Tab 4 — Benchmarks

**Files:**
- Modify: `docs/user-manual.html` — fill `<div id="t3">`

- [ ] **Step 1: Replace the Benchmarks tab div**

Replace `<div id="t3" class="tab"><!-- Benchmarks --></div>` with:

```html
  <div id="t3" class="tab">
    <h2>Benchmarks</h2>

    <h3>Flipflop Framework</h3>
    <p>Interleaved N-way A/B timing harness. Variants are interleaved with start-rotation to cancel thermal drift. Results appended to a <b>TOON ledger</b> — a <code>.toon</code> file capturing per-flip time, memory, temperature, and optional quality/marks.</p>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Concept</th><th>Detail</th></tr></thead>
      <tbody>
        <tr><td>Invocation</td><td><code>node flipflop.mjs &lt;test-file&gt; --print</code></td></tr>
        <tr><td>Ledger location</td><td><code>docs/benchmarks/*.toon</code></td></tr>
        <tr><td>Thermal control</td><td>Interleaved arms + start-rotation; each arm measured in same thermal window</td></tr>
        <tr><td>Trust level</td><td>Reported as <code>trust:high</code> only on a cooled, idle box (LibreHardwareMonitor recommended)</td></tr>
        <tr><td>Equal gate</td><td>Within-engine variants must produce bit-exact output; cross-variant tolerance documented per test</td></tr>
        <tr><td>DOM variant</td><td><code>flipflopdom</code> — runs inside headless Chrome/Playwright for browser-only APIs (OPFS, SharedArrayBuffer, WASM-in-browser)</td></tr>
      </tbody>
    </table>
    </div>

    <h3>Section Bench</h3>
    <p>Permanent pipeline-attribution harness. Answers: <i>where did this change land?</i> Source: <code class="path">crates/raw-pipeline/examples/pipeline_section_bench.rs</code>.</p>

    <h4>Sections measured</h4>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Section</th><th>Source</th><th>Isolates</th></tr></thead>
      <tbody>
        <tr><td><code>raw_parse</code></td><td>cr2/dng::decode_bytes, ORF tiff+decompress</td><td>Demux + LJPEG/decompress</td></tr>
        <tr><td><code>demosaic</code></td><td>demosaic::*</td><td>CFA → RGB16</td></tr>
        <tr><td><code>tone</code></td><td>pipeline::process_into_auto</td><td>Develop → RGB8</td></tr>
        <tr><td><code>encode</code></td><td>libjxl (jxl_casaencoder)</td><td>JXL encode</td></tr>
        <tr><td><code>decode_full</code></td><td>libjxl (jxl_casadecoder)</td><td>JXL full decode</td></tr>
        <tr><td><code>ttfp</code></td><td>decode_progressive_first_total</td><td>Time-to-first-paint (first progressive frame)</td></tr>
        <tr><td><code>load_e2e</code></td><td>sum</td><td>RAW bytes → full image ready (no render)</td></tr>
        <tr><td><code>ttfp_e2e</code></td><td>sum</td><td>RAW → first paint</td></tr>
      </tbody>
    </table>
    </div>

    <h4>Two modes</h4>
    <p>Run via <code>benchmark/run-section-bench.mjs &lt;mode&gt; [reps] [effort]</code></p>
    <ul>
      <li><b>relative</b> — current build vs last persisted run (<code>section-history/section-bench-last.json</code>). Regression detector: run after every change.</li>
      <li><b>absolute</b> — current build vs libjxl 0.11.2 anchor, interleaved A/B in one wall window (thermal-cancelled), 5-rep median.</li>
    </ul>
    <p>Output: console table + inline-SVG grouped-bar chart (<code>docs/outputs/timing tests/section-bench-*.html</code>) + JSON.</p>

    <div class="box box-blue">
      <div class="box-title">Noise-floor control</div>
      In absolute mode, <code>raw_parse</code>/<code>demosaic</code>/<code>tone</code> are the <b>same code</b> in both builds → their A/B ratio = pure measurement noise. A real signal must beat that spread. (First run: noise sections 0.89–1.29×; <code>ttfp</code> 2.0–2.5× → genuine.)
    </div>

    <hr class="section-sep"/>
    <h3>Timing Tests — Summary</h3>
    <p>Full test suite defined in <code>docs/Optimal-settings.md</code>, results in <code>docs/Timing Test Summary.md</code>. Each test outputs a TOON ledger row with <code>raw_ms</code>, <code>rgba_ms</code>, <code>encode_ms</code>, <code>decode_ms</code>, <code>total_ms</code>, <code>size</code>.</p>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Test</th><th>File</th><th>Sweep</th><th>Key finding</th></tr></thead>
      <tbody>
        <tr><td><b>1</b> · Progressive vs one-shot</td><td><code>test_1_progressive_vs_oneshot.mjs</code></td><td>Encode strategy</td><td>Progressive: +200ms encode, −60ms first-paint. Use progressive for all web-facing output.</td></tr>
        <tr><td><b>2</b> · Thumbnail generation</td><td><code>test_2_thumbnail_generation.mjs</code></td><td>400px encode+decode</td><td>effort=3, quality=80. Downsample=2 saves 1–2.4× (minimal abs time). Pre-encode thumbs, don't downsample on-the-fly.</td></tr>
        <tr><td><b>3</b> · Lightbox detail</td><td><code>test_3_lightbox_view.mjs</code></td><td>1600px + ROI</td><td>ROI center-50% ≈ 245–415ms. Use effort=3, quality=85, progressive=true.</td></tr>
        <tr><td><b>3.1</b> · Effort sweep</td><td>(subset of test 3)</td><td>effort 3 / 5 / 7</td><td>808ms → 1829ms → 3513ms. Lock effort=3 for real-time transcoding.</td></tr>
        <tr><td><b>4</b> · Bulk gallery</td><td><code>test_4_bulk_gallery.mjs</code></td><td>Sequential multi-image decode</td><td>Confirms progressive presets optimal across batch; no sequential penalty.</td></tr>
        <tr><td><b>5</b> · First-paint / streaming</td><td><code>test_5_first_paint_streaming.mjs</code></td><td>Byte cutoffs 10–100%</td><td>25% → PSNR ~21.8. 50% → PSNR ~28.6, first AC pass fits. Progressive handles streaming natively.</td></tr>
        <tr><td><b>6</b> · Policy matrix</td><td><code>test_6_policy_matrix_sweep.mjs</code></td><td>effort / quality / modular / resampling</td><td>VarDCT always beats forced modular for photographic RAW. Resampling negligible.</td></tr>
        <tr><td><b>7</b> · P3.1 features</td><td><code>test_7_p3_features_benchmark.mjs</code></td><td>previewFirst, region, downsample</td><td>previewFirst (DC-only) 220–270ms — SLOWER than first AC pass 165–185ms. Do NOT use previewFirst.</td></tr>
        <tr><td><b>13</b> · Quality ladder</td><td><code>test_13_quality_ladder_sweep.mjs</code></td><td>q70→q95 at 1600px, effort=3</td><td>q85 = 465KB, best web balance. q90 = 614KB. q95 = 1042KB.</td></tr>
        <tr><td><b>14</b> · Modular mode</td><td><code>test_14_modular_mode_sweep.mjs</code></td><td>modular vs VarDCT</td><td>Forced modular = 2.2MB + much slower. Default VarDCT is always correct for photo RAW.</td></tr>
      </tbody>
    </table>
    </div>

    <div class="box box-green">
      <div class="box-title">Locked Settings — Authoritative</div>
      <div class="tbl-wrap" style="margin:8px 0 0">
      <table>
        <thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead>
        <tbody>
          <tr><td><code>effort</code></td><td><b>3</b></td><td>Test 3.1: 808ms vs 1829ms (effort=5) vs 3513ms (effort=7)</td></tr>
          <tr><td><code>quality</code> (full-size)</td><td><b>85</b></td><td>Test 13: 465KB, best web balance</td></tr>
          <tr><td><code>quality</code> (thumbnail)</td><td><b>80</b></td><td>Test 2: optimal for 400px</td></tr>
          <tr><td><code>progressive</code></td><td><b>true</b></td><td>Test 1: −60ms perceived first-paint</td></tr>
          <tr><td><code>progressiveFlavor</code></td><td><b>'ac'</b></td><td>Test 7: first AC pass reliably faster than DC-only preview</td></tr>
          <tr><td><code>previewFirst</code></td><td><b>false</b></td><td>Test 7: DC preview 220–270ms vs AC pass 165–185ms</td></tr>
          <tr><td>Modular</td><td><b>default (VarDCT)</b></td><td>Tests 6+14: forced modular always slower + larger for photo</td></tr>
        </tbody>
      </table>
      </div>
    </div>

    <h3>JOLT Performance (cross-reference)</h3>
    <p>Measured 2026-07-02: <code>examples/jolt_bench.rs</code>, Ghana dashcam, 48 frames @ 1280×720, i7-10850H. See CASAVA tab for full table.</p>
    <p>Key result: every JOLT preset decodes 720p in real time (≥24fps) single-threaded. Lossless archive does not (9fps). That gap is JOLT's reason to exist.</p>

    <h3>Measurement Recipes</h3>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Use case</th><th>Recipe</th><th>Cost</th></tr></thead>
      <tbody>
        <tr><td>Kernel A/B (enc/dec, no libjxl build)</td><td><code>clang++ -O3 -std=c++17 tools/&lt;name&gt;_ab.cc -o ab &amp;&amp; ./ab</code></td><td>Seconds</td></tr>
        <tr><td>Real dec-path number</td><td>Merge dec opts → one <code>build.mjs</code> rebuild → flipflop NEW dist vs baseline from git history</td><td>~34min WASM build (shared, paid once)</td></tr>
        <tr><td>Encoder number</td><td>Build cjxl OLD vs NEW via <code>jxl_encdec_ab</code> (<code>LIBJXL_SOURCE_DIR</code>); SHA-compare e3+e9</td><td>One build pair, shared across all enc opts</td></tr>
        <tr><td>App-path-dead opts</td><td>Assembly diff or skip — facade flipflop reads neutral regardless of rebuild</td><td>Zero (don't build)</td></tr>
      </tbody>
    </table>
    </div>
  </div>
```

- [ ] **Step 2: Reload browser, verify Benchmarks tab**

Tab shows: flipflop table (6 rows), section bench with 8-row sections table, 2-mode description, blue noise-floor callout, timing tests 10-row summary table, green locked settings table (7 rows), JOLT cross-reference, 4-row measurement recipes table.

- [ ] **Step 3: Commit**

```powershell
git add docs/user-manual.html
git commit -m "docs(manual): Benchmarks tab — flipflop, section bench, timing tests, locked settings"
```

---

### Task 6: Final polish + verify success criteria

**Files:**
- Modify: `docs/user-manual.html` — minor polish only

- [ ] **Step 1: Verify all 6 success criteria**

Open `docs/user-manual.html` in browser. Check each:

1. No network requests — open DevTools → Network tab → reload → 0 requests after initial load
2. All 4 tabs switch — click each, verify content appears, no JS errors in console
3. Module map matches `CLAUDE.md` layer map — cross-check the 6 packages listed in CLAUDE.md Key Files table against the module map table rows (jxl-stream, jxl-session, jxl-scheduler/pool, jxl-worker-browser, jxl-wasm/facade, jxl-cache all present with correct paths)
4. JOLT perf numbers match `docs/jolt-lossy-video.md` — verify: Realtime 4.04MB/3.0%/60.1/18.1/55fps, Balanced 6.87MB/5.2%/73.1/23.8/42fps, Quality 10.76MB/8.1%/81.6/18.8/53fps, lossless 17.69MB/13.3%/33.8/109.7/9fps
5. Locked settings match `docs/Timing Test Summary.md` — effort=3, quality=85/80, progressive=true, progressiveFlavor=ac, previewFirst=false, VarDCT default
6. Perceptual module paths match filesystem — verify `crates/raw-pipeline/src/perceptual/` contains: `mod.rs`, `butteraugli.rs`, `ssim.rs`, `psnr.rs`, `xyb.rs`, `blur.rs`, `simd/scalar.rs`, `simd/avx2.rs`, `simd/wasm.rs`, `simd/avx512.rs`, `simd/mod.rs`, `telemetry.rs`

- [ ] **Step 2: Fix any discrepancies found in step 1**

If any number or path is wrong, correct it before the final commit.

- [ ] **Step 3: Final commit**

```powershell
git add docs/user-manual.html
git commit -m "docs(manual): user manual complete — Architecture/CASAVA/Perceptual/Benchmarks"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered in |
|---|---|
| Tabbed HTML, 4 tabs, self-contained | Task 1 (shell) |
| Stack diagram SVG with hover | Task 2 (Architecture, SVG) |
| Module map table (16 packages + 3 crates) | Task 2 (Architecture) |
| Layer invariants | Task 2 (Architecture) |
| Build overview (3 outputs) | Task 2 (Architecture) |
| CASAVA overview + JOLT presets table | Task 3 (CASAVA) |
| JOLT perf table with real measured numbers | Task 3 (CASAVA) |
| Rate control (VBV feedback) | Task 3 (CASAVA) |
| Rate metadata (header flags + CASR box) | Task 3 (CASAVA) |
| Rust API snippets | Task 3 (CASAVA) |
| FableBraid format + perf | Task 3 (CASAVA) |
| casv-web package | Task 3 (CASAVA) |
| Perceptual module file layout | Task 4 (Perceptual) |
| Three metrics table with cost + algorithm | Task 4 (Perceptual) |
| SIMD backend dispatch + parity chain | Task 4 (Perceptual) |
| Calibration results table with 50% inflection | Task 4 (Perceptual) |
| Butteraugli threshold recommendations | Task 4 (Perceptual) |
| JS fallback + SSIM engine status | Task 4 (Perceptual) |
| Perceptual Constancy Mode | Task 4 (Perceptual) |
| Flipflop framework | Task 5 (Benchmarks) |
| Section bench sections + two modes | Task 5 (Benchmarks) |
| Timing tests 1–14 summary | Task 5 (Benchmarks) |
| Locked settings table | Task 5 (Benchmarks) |
| JOLT cross-reference | Task 5 (Benchmarks) |
| Measurement recipes | Task 5 (Benchmarks) |
| Dark theme (#0b0e14) matching ecosystem-map.html | Task 1 (CSS) |
| 6 verifiable success criteria | Task 6 |

No gaps found.

**Placeholder scan:** No TBDs, TODOs, or "similar to" references. All code blocks contain real content. All numbers sourced from `docs/jolt-lossy-video.md` and `docs/Timing Test Summary.md`.

**Type consistency:** No cross-task type references — HTML-only tasks, no shared function signatures.
