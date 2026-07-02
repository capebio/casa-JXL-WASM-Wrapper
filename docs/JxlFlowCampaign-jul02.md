# JXL Flow Campaign — 2026-07-02

Goal: reduce largest bottlenecks / slow-throughput / memory hogs across photographic + videographic flow. Four directives:

1. **Image pathway** — emphasis on E3 encode + time-to-first-paint (TTFP)
2. **Video: JOLT** (JXL-Optimized Lossy Transport, `casa_video.rs`, landed 05adabaa)
3. **Video: FableBraid** (braided-rANS lossless, branch fb8x @434237c7)
4. **Flipflop rule** — any doubtful win gets interleaved A/B (flipflop/flipflopdom); sequential per-arm timing is drift-biased and forbidden for <10% deltas

## Branches / worktrees

| Worktree | Branch | Base | Scope |
|---|---|---|---|
| `C:\Foo\rcw-jxlflow` | `perf/jxl-flow-jul02-jf7w` | main @a3bc6e7a | image E3, TTFP, JOLT |
| `C:\Foo\rcw-fableflow` | `perf/fable-flow-jul02-fbw2` | fb8x @434237c7 | FableBraid |

Primary checkout untouched (has unrelated WIP: butteraugli sub-integ gitlink + rebuilt dec wasm — NOT mine, left alone).

## Gates (from repo history)

- Byte-exact A/B on every opt (output SHA / FNV identical)
- Interleaved flipflop for <10% deltas (lesson: dec_ans degenerate fastpath = thermal-drift artifact)
- MSVC test suite pass + wasm32-unknown-unknown check clean
- libjxl opts: WASM-COMPILE gate, not just native A/B (lesson: butteraugli b9f2 revert)
- Check `docs/rejected optimizations.md` + CLAUDE.md reject table before implementing

## Status log

- [x] Worktrees + branches created
- [x] Phase 1: recon (7 parallel deep-readers) — `docs/recon-jul02.json`, ~51 candidates
- [x] Phase 2: triage vs rejection log (see Candidates below). Hand-verified JE-1 recon write-only claim.
- [x] Phase 3: implement + verify — 6 parallel agents (wf_2742380b-de4): 29 opt commits landed, 5 rejections logged, all gates green per agent
- [x] Phase 4: merged cv-enc/cv-dec/appe3/ttfp into jf7w (1 semantic merge fix: cv-dec tests vs CV-E2 signature, e93a9565). Merged-head gates: MSVC lib 274/0, wasm32 raw-pipeline+root clean, web bun 278p + 2 pre-existing env fails (= baseline), jxl-session/scheduler/worker-browser at exact pristine-main parity (S14 + spawn fails pre-exist on main). fable work already on fbw2. libjxl sub branch parked un-merged (gitlink NOT bumped — dist rebuild on primary is the ship gate).

Baselines (2026-07-02): MSVC lib tests green — 267 (main base), 271 (fable base). Golden corpus: C:\Foo\raw-converter\tests\real_video_ghana (48×720p PNG).

## Candidates

Full recon output: `docs/recon-jul02.json` (7 areas, ~51 candidates). Triage verdict:

**Implement now (6 parallel agents):**

| Agent | Branch | Scope |
|---|---|---|
| cv-enc | perf/jf-cvenc-jul02 | JOLT encode: dead recon removal (verified write-only by hand: writes :477/:516/:533/:922/:940/:1005/:1047, zero reads), batch effort bug (Realtime pays e3, header lies), par_iter batch, persistent encoder, scratch reuse, threaded runner (SHA-gated) |
| cv-dec | perf/jf-cvdec-jul02 | CASV decode: GOP-parallel batch, MT libjxl decode (archive 9fps→24fps unlock), persistent decoder+scratch, streaming for-each API (663MB→~6MB), footer decode in place |
| fable | perf/fable-flow-jul02-fbw2 | FableBraid: planar state across P-frames, fused row-recon+RCT, dead zero-fills, plane-parallel rayon, wasm simd128 kernel ports, encoder trims. FBR1 bitstream frozen |
| appe3 | perf/jf-appe3-jul02 | E3 app path: RGB-native variants (D1 half), stream_band borrow, owned rgb16 entry, RAW take-by-value (−36MB/photo), chunked full-res tier (exploratory) |
| ttfp | perf/jf-ttfp-jul02 | TTFP: prewarm RAW wasm at pool init, wire scheduler prewarm, kill per-pass getImageData readback, repaintThumb downsample, two-phase RAW task |
| libjxl | perf/jf-e3-jul02-lx6d (sub, off capebio 6479ef13) | e3 internals: dead orig_opsin at falcon, SIMD coeff-order zero-scan, fused RGBA8→float input, CfL/num_zeros/EncCache alloc trims. WASM-compile gate |

**Deferred:** JE-8 atlas packing (format change), FB-7 FBR2 stripe braids (needs 2-cursor prototype flipflop), TTFP-5 (no production caller), TTFP-7 dec-only artifact (P3 split not built), A7-JE-2 AdmissionGate (active mag7 branch exists — not duplicating), A4-JE-4 fan-out schedule (bench-gated, later), JD-8 residual-add flatten (DS-HADD lesson, flipflop-gated, low value).

## Landed

All byte-exact unless noted; every timing <10% via interleaved flipflop; goldens = SHA256 ledgers (paths in agent notes inside `docs/recon-jul02.json` sibling reports).

### JOLT / CASV encode (cv-enc, 7 commits, merged into jf7w)
- **CV-E1** dead write-only in-loop recon deleted (all 4 lossy paths; one full FFI decode/frame gone). 36/36 golden .casv SHA identical. Enc ms/f: Realtime −15%, Balanced −11%, Quality −9%.
- **CV-E2** batch lossy encoders honor `opts.effort` (was: hardcoded e3 while header stamped requested effort — batch Realtime paid e3, metadata lied). NOT byte-exact by intent: exactly 8/36 goldens changed; batch output now SHA-identical to streaming output per preset. New pinning test.
- **CV-E3** frame-parallel batch lossy (`into_par_iter`): 4.3–5.6× batch encode, bytes identical.
- **CV-E4** persistent Encoder in StreamCtx + `encode_into` (rule #10).
- **CV-E5** streaming scratch reuse (atlas/bitmap/changed/crop) + ping-pong frame buffers via `next_frame_into`. Edge-tile scratch-reuse pinning test. Combined streaming enc floors: Realtime −26%, Balanced −29%, Quality −17%.

### CASV decode (cv-dec, 8 commits, merged)
- **CV-D1** persistent decoder + scratch reuse (−3.5% focused; rule #10).
- **CV-D2** `decode_casv_all_rgb8_threaded` (MT libjxl): archive 368→75 ms/f (~4.9×); MT==ST bytes pinned.
- **CV-D3** GOP-parallel batch decode: −39..77%.
- **CV-D4** streaming `decode_casv_for_each_rgb8(_threaded)`: peak RSS 173→34 MB @48f 720p, no per-frame clone.
- **CV-D5** zero-copy `CasvView` footer decode (no whole-stream re-framing): −44..47%, 158→22 MB.
- **CV-D7** single-parse frame metadata (rule #10).
- Post-pass jolt_bench: **Realtime 98 fps, Balanced 90 fps, Quality 109 fps** (all pass 24fps budget); archive batch 9→18 fps (2-GOP file caps parallelism).

### FableBraid (fable, 7 commits on fbw2)
- FB-4 dead zero-fills/alloc churn; FB-2 DeltaDecodeSession planar-SG state across P-frames (−32.7%); FB-3 fused row reconstruction (−5.7%); FB-6 plane-parallel rayon join, 64K-px gate (−41.4% @720p); FB-1 wasm32 simd128 kernels — **wasm-runtime VERIFIED −27.3% med / −27.1% floor** (node scalar-vs-simd128 artifacts, interleaved, parity-gated; harness `tools/fable-wasm-flip.mjs` @73ee1f26; kernels already live in shipped builds via `.cargo/config.toml` +simd128); FB-9 encoder trims (−9.6% encode); FB-5 fable-arm clone drop.
- **Cumulative 720p decode: 505.8→145.2 ms/clip = −71.3% (3.0 ms/f ≈ 330 fps)**; encode −5.8%. FBR1 bitstream + pixels frozen, golden SHAs identical every commit. 273 MSVC tests.

### E3 app path (appe3, 5 commits, merged)
- **AE-1** stream_band borrows raw window, dead zero-fills dropped (~160 MB traffic + 48 allocs per 24MP export; rule #10).
- **AE-2** `encode_variants_from_rgb16_owned`: live-heap peak 322→46 MB (−276 MB) @12MP, outputs identical.
- **AE-3** RGB-native variant path (D1 variant-half): resize per-channel-independence parity test written FIRST; 17-config golden FNV identical.
- **AE-6** full-res tiers through chunked encoder (blocker verified stale; chunked==whole 20/20 at all production rates + thread-count invariant): −4..7% wall, −28 MB peak.

### libjxl e3 internals (sub branch perf/jf-e3-jul02-lx6d off capebio 6479ef13 — NOT gitlink-bumped)
- LX-1 dead orig_opsin skip at falcon (−87 MB peak @12MP); LX-2 SIMD coeff-order zero-scan (upstream TODO); LX-3 fused u8→planar SIMD conversion; LX-4/5/6 alloc trims (CfL scratch, num_zeros 3.15MB→1.5KB, EncCache hoist).
- **Geomean +18.4% e3 encode throughput** (ABBA flipflop, 40 runs/arm); peak WS 540→453 MB. 24-config cjxl/djxl SHA A/B identical after every item; em++ compile gates (simd128 + relaxed-simd) clean.
- **Ship gate**: rebuild jxl-wasm dist from this rev ON PRIMARY checkout (primary currently has unrelated user WIP — blocked until that clears), then optional in-browser flipflopdom of LX-3.

### TTFP (ttfp, 5 commits, merged)
- TP-1 RAW-WASM PRELOAD prewarm at pool init; TP-2 scheduler prewarm wired (prewarmSize + worker-boot getWasm); TP-3 per-pass full-canvas getImageData readback killed (~80 MB alloc + GPU→CPU readback per pass @20MP); TP-4 repaintThumbFromJxl joins prefetch cache.
- **TP-5 two-phase ORF task**: previews post 35–49% earlier (byte-exact proven by committed `web/two-phase-raw.test.js` on real 20MP ORFs); costs +39–68% per-file worker CPU on the encode leg (single-thread proxy) — **deliberate latency-vs-throughput trade, revert lever = single `canSplit` gate in worker.js; needs product sign-off + browser measurement**.

⚠ **Dist-drift note (TP-2)**: main's committed `jxl-scheduler`/`jxl-session` dist contained artifacts of the UNMERGED mag7 branch (memory-admission-gate.*, session weight plumbing) — dist was ahead of src. TP-2's rebuild regenerates dist from src truth, so those files vanish on this branch. Merging mag7 later will hit modify/delete on dist — resolution: merge mag7 src, rebuild dist. Nothing on this branch's src consumes them (verified: suites at exact pristine-main parity).

## Rejected / deferred this campaign

Rejected (all logged in `docs/1 rejected optimizations.md`):
- **CV-E6** MT streaming JOLT runner: byte-identical across thread counts but measured 29% SLOWER on Realtime (32px-wide atlas = tiny-group slivers + fork-join sync). Reverted fully; re-visit only after JE-8 square atlas packing.
- **AE-5** RAW input by value: outputs identical but claimed −36MB never materializes (wasm memory monotonic; dlmalloc can't host rgb16 master in freed hole) + reproducible +44MB regression on ORF classic. Lesson: early-drop theories must check the freed block can host the later peak alloc.
- **TTFP-4-DNG** two-phase split for DNG: previews NOT byte-identical (no superpixel preview path in process_dng_impl); guard test pins it. CR2 also excluded (flags ignored, split doubles decode).
- **TTFP-2-reput**: recon's "redundant putImageData" claim WRONG — M2 FilterEngine paints the same canvas in between; re-put is load-bearing. Kept.
- **CV-D6** decode-in-place full-width rects: instrumented 0–4.8% of P-frames affected; fails cost/benefit.

Deferred: JE-8 square atlas packing (format bump; also prerequisite for MT streaming re-attempt), FB-7 FBR2 stripe braids (format), FB-1 browser timing (flipflopdom after web/pkg rebuild), LX-3 in-browser measure (with dist rebuild), TTFP-5/TTFP-7, footer random-access twin, archive-batch-24fps policy (gop_len vs MT-inner scheduling), TTFP-2 sibling readbacks (pixel-peep, Tauri live-raw), AdmissionGate (active mag7 branch).
