# EpicCodeReview

**Target:** `packages/jxl-pyramid/src/` (focus: decode-level.ts, choose-level.ts, tiled-decode-pool.ts)
**Branch reviewed:** `performance/jxl-pyramid-warm-pool` (worktree)
**Mode:** workalone | **Status:** review-only (user halted before fix stage)
**Generated:** 2026-06-09

## Summary

- **111 candidates** raised by 6 finders (CodeQL skipped — not on PATH)
- **93 confirmed** by verifier — 2 critical, 17 high, 39 medium, 29 low, 6 info
- **2 uncertain** → see Open questions
- **16 false positives** dismissed

**One-line verdict:** Hot path is structurally sound for 8-bit happy path; 16-bit support is silently broken end-to-end through worker + dist, and the warm pool lacks cancellation, timeout, factory-isolation, and dispose — most acute risks are correctness (16-bit), safety (untrusted JXTC header), and pool lifecycle.

---

## Findings (confirmed)

### Critical (2)

**packages/jxl-pyramid/dist/tiled-decode-pool.js**
- L1-90 **dist/tiled-decode-pool.js is severely stale vs src — missing 16-bit path, missing persistent pool, missing transferable, missing error/messageerror listeners**
  - _Evidence:_ Direct read of dist/tiled-decode-pool.js (90 lines) confirms: line 1 imports only decodeTileContainerRegionRgba8 (no rgba16); line 4 hardcodes `viewport.w * viewport.h * 4`; line 38-61 reimplements per-frame Array.from(factory) + finally-terminate (no PyramidWorkerPool class). di

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L366-425 **Parallel worker pool path silently corrupts 16-bit tiled containers (worker.js only decodes rgba8)**
  - _Evidence:_ Verified web/lightbox/tiled-decode-worker.js line 9 calls decodeTileContainerRegionRgba8 unconditionally; no 16-bit branch. The pool path (decodeTiledViewportPooled) passes header.bitsPerSample to bppFor() and uses 8bpp stitch buffer when bits=16, but worker output is 4bpp. stitc


### High (17)

**packages/jxl-pyramid/dist/decode-level.js**
- L1-82 **dist/decode-level.js is stale: only imports decodeTileContainerRegionRgba8 — no 16-bit path, no pickRegionDecoder(bits), no bpp parametrization**
  - _Evidence:_ Confirmed by reading dist/decode-level.js: imports only decodeTileContainerRegionRgba8 (line 1), stitchTileDecodes hardcodes *4 (lines 31-39), no pickRegionDecoder, no bits parameter, no rgba16 branch. dist/level-source.js similarly omits bitsPerSample from the tiled result. dist

**packages/jxl-pyramid/src/choose-level.ts**
- L13-15 **chooseLevelForTarget sorts by pixel area but selects by long edge — picks the wrong level when area order disagrees with long-edge order**
  - _Evidence:_ Math is correct: with levels [{w:200,h:900,area:180000,longEdge:900}, {w:600,h:600,area:360000,longEdge:600}] sorted by area gives [200x900, 600x600]. find(longEdge>=550) returns 200x900 first. The doc-stated 'smallest pyramid level' should be 600x600. Standard pyramid levels (PY
- L8-16 **chooseLevelForTarget allocates and sorts a new array on every viewport/zoom change**
  - _Evidence:_ Confirmed: choose-level.ts:13 allocates `[...levels]` + sort on every call. web/lightbox/pyramid-lightbox.js:61 calls chooseLevelForTarget from pickLevel(zoomPct) which is invoked on every wheel/zoom interaction. web/pyramid-gallery/grid-controller.js:105 calls it from paintCell 

**packages/jxl-pyramid/src/decode-level.ts**
- L60-83 **stitchTileDecodes pixel-buffer allocation has unchecked multiplication overflow**
  - _Evidence:_ Verified decode-level.ts:65 and tiled-decode-pool.ts:41 both use unchecked w*h*bpp allocations. The viewport derives from clamps against source.width/height which come unchecked from JXTC header (level-source.ts:21-22). Worker output dims arrive at tiled-decode-pool.ts:87-88 with
- L114-119 **Promise.all over tile decodes has no AbortSignal — first failure leaves remaining tiles racing to completion with no cancellation**
  - _Evidence:_ Verified decode-level.ts:89-122. Function signature accepts no AbortSignal in options (lines 92-95). The RegionDecoder type (lines 15-18) has no signal parameter. Promise.all on line 114 fans out N tile decodes with no abort coordination — first rejection abandons in-flight WASM 
- L20-45 **decodeWhole leaks decoder if push/close/drain reject before dispose**
  - _Evidence:_ Lines 39-42 await push, close, drain, dispose sequentially with no try/finally. If decoder.push throws (malformed input), or the drain IIFE's 'error' branch (line 35) throws, decoder.dispose() is never invoked. WASM heap buffers and session state remain until GC reclaims the deco
- L29-41 **drain IIFE rejection becomes unhandled if push/close throws first**
  - _Evidence:_ Lines 29-38 start the drain IIFE immediately. Lines 39-41 await push, close, drain in order. If await decoder.push(bytes) rejects, the function unwinds before await drain is reached. drain remains an in-flight promise; if it later rejects (e.g., the 'error' event was already buff

**packages/jxl-pyramid/src/level-source.ts**
- L5-28 **LevelSource kind="whole" silently discards PyramidLevel.bitsPerSample — 16-bit whole-frame levels decode as 8-bit**
  - _Evidence:_ Confirmed: level-source.ts:5-7 "whole" variant has no bitsPerSample, createLevelSource on line 10 picks only "w"|"h"|"tiled" (drops bitsPerSample), and decode-level.ts:22 decodeWhole hardcodes `format: "rgba8"`. web/lightbox/pyramid-lightbox.js:52 filters levels by `l.bitsPerSamp

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L304-321 **Module-singleton pool captures the first caller's workerFactory and ignores all subsequent factories**
  - _Evidence:_ Verified: module-level `let pool: PyramidWorkerPool | null = null;` (line 304) and `if (pool && !pool['destroyed']) return pool;` (line 307). The incoming `factory` argument is silently ignored when a pool exists. Combined with logic-006 (destroyed never set), second callers with
- L338-357 **Worker death between tile jobs in coroutine slicing can cause indefinite hang — postMessage to terminated worker returns no response**
  - _Evidence:_ Verified tiled-decode-pool.ts:234-258 (spawnOne attaches permanent recycle listener; recycle calls destroyHandle which calls worker.terminate()) and 338-357 (coros hold a WorkerLike reference and call decodeTileWithWorker in each loop iteration). If recycle fires between iteratio
- L68-124 **decodeTileWithWorker has no timeout and no per-call abort — if worker silently never replies, promise hangs forever**
  - _Evidence:_ Verified tiled-decode-pool.ts:68-124. The Promise executor installs only message/error/messageerror listeners. No setTimeout, no AbortSignal, no health-check ping. The single hang-resistance mechanism is the permanent recycle listener in spawnOne (separate scope) — it terminates 
- L372-426 **decodeTiledViewportPooled cannot be cancelled — pan/zoom in UI keeps in-flight decode running and holds pool workers busy**
  - _Evidence:_ Verified at tiled-decode-pool.ts:372-426. The options type (lines 374-379) explicitly omits AbortSignal. decodeTilesParallel (line 323-364) similarly has no abort plumbing. The active workers set (line 149) gets populated by acquire() but only released when the decode resolves/re
- L68-124 **decodeTileWithWorker never times out — hung worker stalls the pool slot forever**
  - _Evidence:_ src/tiled-decode-pool.ts:68-124 — the Promise has no setTimeout / AbortController arm. Only message-with-id, 'error', and 'messageerror' resolve it. If the worker hangs in WASM, the promise never settles; the await in decodeTilesParallel coro (line 345) blocks indefinitely; relea
- L381-397 **parseJxtcHeader called on every decodeTiledViewportPooled invocation**
  - _Evidence:_ Confirmed: tiled-decode-pool.ts:381 calls parseJxtcHeader on every invocation; pyramid-decode.js:16 calls decodeTiledViewportPooled inside a closure that is re-created per decode request. The sibling decodeTiledViewport in decode-level.ts accepts a pre-parsed LevelSource. Real wa

**packages/jxl-pyramid/src/tiling.ts**
- L37-51 **parseJxtcHeader reads attacker-controlled uint32 dims with no range validation**
  - _Evidence:_ Verified at tiling.ts:42-50. Five uint32 fields read with no bounds checking and returned to createLevelSource (level-source.ts:17-25), which assigns header.imageW/imageH/tileSize verbatim to source.{width,height,tileSize}. Downstream allocations at decode-level.ts:65 and tiled-d
- L61-96 **tilesOverlappingRegion can produce unbounded tile-list growth from attacker-controlled imageW/H/tileSize**
  - _Evidence:_ Verified tiling.ts:61-96 has no cap on the (tyMax-tyMin+1)*(txMax-txMin+1) iteration count. decode-level.ts:136 confirms `roi = { x: 0, y: 0, w: source.width, h: source.height }` for null region. Whole-level decode path forces tile generation across the full image area. Chained w

**web/pyramid-gallery/image-store.js**
- L21-29 **No runtime schema validation at manifest.json boundary — JSON.parse cast directly to PyramidManifest**
  - _Evidence:_ Confirmed: image-store.js:26 does `const manifest = await res.json()` with no shape check. Confirmed via Glob + Grep that no schema.ts exists in pyramid-ingest/src (files: backends, cli, hash, index, ingest, ladder, manifest, quality, raw-backend, rgb16, shard) and grep for `prod


### Medium (39)

**packages/jxl-pyramid/src**
- L0-0 **No shared assertion/invariant utility — pyramid coord/level math sprawls without a check-once-per-boundary discipline**
  - _Evidence:_ Verified three independent clamp sites: decode-level.ts:100-103, tiled-decode-pool.ts:382-385, tiling.ts:68-71. Verified no byteLength assertion in either stitch function. Concrete evidence of need: logic-001 (16-bit worker corruption) would be mechanically caught by an assertDec

**packages/jxl-pyramid/src/choose-level.ts**
- L1-26 **No memo / pre-sort cache for pyramid level picker**
  - _Evidence:_ choose-level.ts:13 copies and sorts on every invocation. No WeakMap or module-level cache exists in the file. `levelRank` (line 19-21) is a pure function and is recomputed by `shouldUpgrade` on each call. A WeakMap memo on the levels array is a small, clean fit; PyramidLevel arra

**packages/jxl-pyramid/src/decode-level.ts**
- L89-122 **decodeTiledViewport does Promise.all fan-out with no concurrency cap on non-worker path**
  - _Evidence:_ Verified decode-level.ts:107-119. The parallel path (line 114) calls Promise.all over the full tiles array with no chunking or semaphore. tiles.length is itself unbounded (see security-c3d4e5f6). decodeRegion ultimately calls decodeTileContainerRegionRgba{8,16} which allocates a 
- L114-122 **Promise.all short-circuit leaks in-flight tile decodes on first failure**
  - _Evidence:_ Lines 114-119 use Promise.all with no per-tile .catch and no AbortSignal. CLAUDE.md confirms 'decoder.push() (WASM) is synchronous — cannot yield mid-push'. Sibling decode promises continue running and their rejections (if any) become unhandled. The contrast with tiled-decode-poo
- L75-80 **stitchTileDecodes allocates a Uint8Array subarray view per row in fallback path**
  - _Evidence:_ Lines 75-80 confirm per-row subarray() allocation; each row creates a new Uint8Array view object. Same code pattern exists at tiled-decode-pool.ts:51-55. The allocation overhead is real, though Uint8Array.prototype.set has no zero-alloc range-copy overload, so the proposed fix pa

**packages/jxl-pyramid/src/fixtures.ts**
- L14-56 **APPROVED_FIXTURES is re-exported as part of public surface but contains Windows absolute paths (c:\\Foo\\...) — leaks dev-machine paths into the package public API**
  - _Evidence:_ Confirmed: fixtures.ts:15-56 exports APPROVED_FIXTURES with hardcoded `c:\Foo\...` and `c:\995\...` paths. index.ts:7 re-exports it via `export * from "./fixtures.js"`. The const lives in src/ (not test/) so it ships in the public bundle and type definitions, leaking dev-machine 

**packages/jxl-pyramid/src/grid-layout.ts**
- L15-22 **layoutFromIndex divides by aspect with no guard against zero/NaN/negative**
  - _Evidence:_ src/grid-layout.ts:15-22 — entry.aspect comes from GalleryIndexEntry (manifest.ts:56-60) and is typed `number` with no runtime validation. If aspect is 0, rowSpan = Infinity. Math.round(Infinity) is Infinity (not NaN), and Math.max(1, Infinity) is Infinity. CSS grid will silently
- L21-21 **rowSpan formula collapses to 1/aspect — base cancels out, formula ignores column width**
  - _Evidence:_ Confirmed: `(base / aspect) / base` = `1 / aspect`. base is mathematically eliminated. The docstring says rows are scaled by columnWidthPx but the formula ignores it. For typical aspects (>=0.5), rowSpan is always 1 — visibly wrong layout for any non-square grid sizing. Either th

**packages/jxl-pyramid/src/level-source.ts**
- L9-28 **createLevelSource propagates unchecked JXTC header dims to LevelSource width/height**
  - _Evidence:_ Verified level-source.ts:9-25. The function signature even includes entry.w/h via Pick<PyramidLevel, 'w' | 'h' | 'tiled'> but ignores them for the tiled branch. Whole branch uses entry.w/h (line 27), tiled branch uses header.imageW/imageH (lines 21-22). No cross-validation. Inver

**packages/jxl-pyramid/src/manifest.ts**
- L35-46 **No runtime schema validation (Zod) for PyramidManifest / GalleryIndex at boundary**
  - _Evidence:_ Verified manifest.ts has only TypeScript interfaces, no Zod schemas. grep for 'zod' across the worktree returned no matches in jxl-pyramid (despite WU-1 zod adoption noted in CLAUDE.md for pyramid-ingest, that work hasn't reached this package). grid-layout.ts:21 confirms the aspe
- L17-46 **pyramid-ingest and jxl-pyramid define structurally-similar but separate manifest interfaces — no shared type, compile-time drift possible**
  - _Evidence:_ Confirmed: pyramid-ingest/src/manifest.ts:22-32 declares Manifest with `proxy?: true` (narrow literal), and jxl-pyramid/src/manifest.ts:36-46 declares PyramidManifest with `proxy?: boolean` (wider). pyramid-ingest's isUpToDate() (line 101) reads `existing.proxy !== true` so the f
- L36-46 **No runtime schema version check — schema:1 declared as literal type but never verified at parse**
  - _Evidence:_ Confirmed: PyramidManifest.schema and GalleryIndex.schema are literal `1` (manifest.ts:37, 64) but image-store.js:26 does plain JSON.parse and the package itself never checks schema version. No runtime version guard exists.

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L62-90 **WorkerReply.pixels typed as ArrayBuffer but worker posts a Uint8Array — `new Uint8Array(ab)` copies instead of wrapping**
  - _Evidence:_ Verified worker at web/lightbox/tiled-decode-worker.js line 10: `self.postMessage({ id, ok: true, pixels: out.pixels, ... }, [out.pixels.buffer])`. `out.pixels` is a Uint8Array; structured clone preserves the typed-array view (even when buffer transferred). On receiver, ev.data.p
- L261-273 **armIdleTimer arms only the just-released handle — handles enqueued earlier when idle count was below minIdle are never reaped**
  - _Evidence:_ Traced the logic: armIdleTimer only arms a timer on the just-released handle and only when idle.length > minIdle. Walkthrough with minIdle=2: release w1 (idle=1, no timer), release w2 (idle=2, no timer), release w3 (idle=3, timer on w3 only). w3 reaps after 5s, idle=2 again. Next
- L76-92 **Worker message handler trusts ev.data shape without validation**
  - _Evidence:_ Verified at tiled-decode-pool.ts:76-92. WorkerReply is TS-only (lines 62-64). The handler does no runtime shape/type checks. Compromised worker output flows directly into stitchTileDecodes (line 87-89 returns the raw width/height). Threat model treats workers as a trust boundary 
- L66-73 **Module-scoped nextWorkerId is shared across all pool callers and never reset — collision risk if module loaded twice (HMR / multiple bundles)**
  - _Evidence:_ Verified at tiled-decode-pool.ts:66 and 73. The id is module-scoped and never reset. Workers do persist across decode calls via the pool (workers are reused — see decodeTilesParallel coros at line 338), so HMR scenario is plausible. Worker handle does not track outstanding reques
- L304-321 **Module-scoped `pool` singleton is never destroyable — no exported shutdown(), and `pool['destroyed']` is never set to true**
  - _Evidence:_ Verified at tiled-decode-pool.ts:152 (`private destroyed = false;`) and grep for 'destroyed =' shows it is only ever set to false at declaration. No setter, no shutdown/dispose method. Line 304 module-scope `pool` variable has no export reset. Tests cannot tear it down between ru
- L306-321 **Pool singleton binds to the first-seen workerFactory — subsequent callers passing a different factory are silently ignored**
  - _Evidence:_ Verified at tiled-decode-pool.ts:306-321. The first call captures `factory` into the new PyramidWorkerPool constructor; subsequent calls hit the cache and ignore the passed factory. API contract gap is real: decodeTiledViewportPooled accepts workerFactory per call (line 378) but 
- L110-123 **worker.postMessage is not wrapped in try/catch — synchronous throw (DataCloneError, terminated worker) prevents promise from ever settling**
  - _Evidence:_ Verified at tiled-decode-pool.ts:110-123. The try/catch on lines 111-116 only guards the addEventListener calls (for test doubles), not the postMessage call at line 122. A synchronous postMessage throw escapes the Promise executor and leaves the promise pending forever. DataClone
- L186-214 **No backpressure / queue on acquire — pool at cap returns fewer workers and caller silently falls back to single-WASM decode**
  - _Evidence:_ Lines 186-214 show acquire() drains idle then spawns up to maxSize, then returns. No waiter queue. Lines 414-418 confirm the fallback to single-WASM decodeRegion when liveWorkers.length === 0. Pattern matches finding exactly; behavior is silently sub-optimal for concurrent ROI ba
- L234-250 **Permanent recycle listener is never removed — accumulates across worker lifetime; harmless per-worker but no removal on destroyHandle**
  - _Evidence:_ Lines 242-248 add 'error'/'messageerror' listeners. destroyHandle (lines 288-301) calls terminate() but never removeEventListener. The recycle() guard on line 253 (`if (!this.all.has(h)) return`) protects correctness, but the listener-removal omission is observable, as described.
- L192-214 **acquire() does not verify a warm idle worker is actually responsive — silent-fail workers stay in idle until they error**
  - _Evidence:_ Lines 192-201 only check h.terminated, h.bad, and this.all.has(h). decodeTileWithWorker (lines 68-124) has no timeout, so a wedged worker causes the promise to hang indefinitely. There is no liveness mechanism beyond worker-emitted error events (lines 244-245).
- L204-212 **spawn-on-demand uses try/catch around spawnOne, but a partial spawn (factory creates Worker that fails immediately) puts a bad handle into `active` then breaks the loop — caller never releases this handle**
  - _Evidence:_ The race is concrete: spawnOne at lines 234-250 returns a handle with permanent 'error'/'messageerror' listeners pointing to recycle (which calls destroyHandle, line 258, removing from all). If the worker errors before/during decodeTileWithWorker dispatch, recycle removes the han
- L117-123 **containerBytes is structured-cloned N times (once per tile) — N parallel postMessage of the same large buffer is a hidden N x copy cost**
  - _Evidence:_ Lines 117-122 contain an explicit acknowledgment from the codebase: 'bytes (full JXTC container) is structured-cloned here'. postMessage at line 122 has no transferable list. canUseParallelTileWorkers() in tiling.ts asserts SAB preconditions (per comment) but this code does not e
- L234-302 **No periodic health monitor — a worker that loaded WASM but later starts failing every tile sits in idle/active rotation until terminated by error event**
  - _Evidence:_ recycle() (lines 252-259) is only invoked from the worker error/messageerror events (lines 242-247). decodeTileWithWorker (lines 90-92) rejects on `ok:false` but does not propagate to the pool to mark the handle bad. A worker stuck returning ok:false would be returned to idle by 
- L204-213 **spawnOne failure is swallowed with no logging or escalation**
  - _Evidence:_ src/tiled-decode-pool.ts:204-212 — bare `catch { break; }` with no logging. Verified against jxl-scheduler/pool.ts which has spawnFailed metric and a console.warn for spawn timeout (line 388-393). This pool has none of that observability.
- L242-248 **Silent catch on lifecycle addEventListener disables worker recycling**
  - _Evidence:_ src/tiled-decode-pool.ts:243-248 — silent catch around addEventListener. In standard browsers Worker.addEventListener is safe; the catch only exists for test doubles. In production a real throw here would leave the handle without recycle wiring; the comment acknowledges the test-
- L304-321 **Module-level pool ignores subsequent workerFactory arguments**
  - _Evidence:_ src/tiled-decode-pool.ts:304-321 — module-level singleton, factory argument used only on first call. No identity check, no reset API, no log on mismatch. In production single-app flow this is fine; in HMR/test/scenarios where worker URL changes between calls, the stale factory wi
- L333-364 **decodeTilesParallel allocates results array sized to caller-supplied tiles.length**
  - _Evidence:_ src/tiling.ts:37-51 parses u32 dimensions with no upper bound. src/tiled-decode-pool.ts:333 calls `new Array(tiles.length)` — and tiles.length is driven by clamped viewport, but `tilesOverlappingRegion` iterates a double loop up to (txMax-txMin+1) * (tyMax-tyMin+1) (line 80-94) w
- L372-405 **decodeTiledViewport and decodeTiledViewportPooled have divergent signatures for the same logical operation**
  - _Evidence:_ Confirmed: decode-level.ts:89-95 declares decodeTiledViewport(source: LevelSource tiled variant, ...) while tiled-decode-pool.ts:372-380 declares decodeTiledViewportPooled(containerBytes: Uint8Array, ...). Both are exported via index.ts. The pooled variant calls parseJxtcHeader o
- L141-302 **PyramidWorkerPool has no public dispose() / isDestroyed() — leaked module-scope pool can't be cleanly torn down by callers**
  - _Evidence:_ Confirmed: class PyramidWorkerPool exposes only get size, prewarm, acquire, release (private spawnOne/recycle/armIdleTimer/clearIdleTimer/reap/destroyHandle). The `destroyed` flag is declared private (line 152) and read in destroy paths (lines 172, 187, 222, 235) but never writte
- L226-229 **release() does O(idle) Array.includes scan per worker returned**
  - _Evidence:_ Confirmed: tiled-decode-pool.ts:227 does `if (!this.idle.includes(h)) this.idle.push(h)` — O(idle) per worker. With maxSize=8 it's bounded but the check shouldn't be needed: acquire moves handles to active and removes from idle (lines 193-199), so a released handle is never alrea
- L40-60 **stitch() in tiled-decode-pool.ts duplicates stitchTileDecodes from decode-level.ts**
  - _Evidence:_ Direct side-by-side comparison: tiled-decode-pool.ts lines 40-60 implements `stitch` and decode-level.ts lines 60-83 implements `stitchTileDecodes`. Both build a destination Uint8Array, have an identical fast-path check (`decoded.width === viewport.w && dx === 0`), and identical 
- L117-123 **Documentation of transferable convention is in a comment, not enforced**
  - _Evidence:_ Verified web/lightbox/tiled-decode-worker.js:10 does `self.postMessage({...}, [out.pixels.buffer])` — transfer enforced by hand on the worker side. Sender side (tiled-decode-pool.ts:80-83) trusts this via comment. Out-of-tree workers could silently drop the transfer list and the 

**packages/jxl-pyramid/src/tiling.ts**
- L1-9 **No upper-bound cap on image/level dimensions before allocation**
  - _Evidence:_ Verified constants.ts and tiling.ts contain no MAX_IMAGE_DIMENSION / MAX_TILE_COUNT constants. The existing MASSIVE_* thresholds gate ingest tiling decisions, not decode-side input validation. Pairs naturally with security-a1b2c3d4 and security-c3d4e5f6 as a unified hardening poi
- L37-51 **parseJxtcHeader accepts arbitrary u32 dimensions without sanity bounds**
  - _Evidence:_ src/tiling.ts:37-51 reads five u32 dimension fields and only validates magic and version. No upper bound on imageW/imageH/tileSize or coherence check between (imageW, tileSize, tilesX). tileSize=0 is caught later in tilesOverlappingRegion line 67 but only inside that function — o
- L60-96 **tilesOverlappingRegion rebuilds tile grid every call; no cache by (imageW, imageH, tileSize)**
  - _Evidence:_ tiling.ts:61-96 confirmed: function always allocates a fresh `out` array and recomputes Math.floor/Math.min/Math.max for every tile in the visible subset. No cache exists. For pan-at-60Hz with dozens of tiles, the constant overhead is real. The opportunity self-rates 'worth a ben

**packages/jxl-pyramid/test**
- L0-0 **No fast-check / property-based tests for tilesOverlappingRegion, chooseLevelForTarget, or stitch geometry**
  - _Evidence:_ Verified test files in jxl-pyramid/test/ are single-shape only (choose-level.test.ts, tiling.test.ts use hardcoded inputs). Verified concrete value: a property test ∀ levels with mixed aspect ratios would surface logic-002 (the area-vs-longEdge sort mismatch) immediately. tilesOv

**packages/jxl-pyramid/test/pyramid.test.ts**
- L1-146 **No round-trip contract test: pyramid-ingest writes manifest → jxl-pyramid reads + decodes**
  - _Evidence:_ Confirmed: pyramid.test.ts contains only constant verification, preset enumeration, fixture path checks, and a compile-time-only structural test. No imports of buildManifest from pyramid-ingest, no round-trip JSON parse → chooseLevelForTarget → createLevelSource → decodeLevel tes


### Low (29)

**packages/jxl-pyramid/src**
- L0-0 **Region clamping is duplicated across decode-level.ts, tiled-decode-pool.ts, and tilesOverlappingRegion — extract clampRegionToImage(region, imageW, imageH)**
  - _Evidence:_ Verified three identical clamp blocks: decode-level.ts:100-103 (rx/ry/rw/rh on source.width/height), tiled-decode-pool.ts:382-385 (same on header.imageW/H), tiling.ts:68-71 (same on imageW/H). All three would change in lockstep for any boundary semantic shift. Trivial dedupe.

**packages/jxl-pyramid/src/choose-level.ts**
- L8-16 **chooseLevelForTarget silently accepts NaN/negative/zero targetLongEdge**
  - _Evidence:_ Lines 8-16 contain no Number.isFinite or >0 guard on targetLongEdge. NaN comparisons always return false in JS, so `.find()` returns undefined and the function returns the largest level (the fallback). For targetLongEdge=0 or negative, every level satisfies the predicate so the s

**packages/jxl-pyramid/src/decode-level.ts**
- L99-106 **decodeTiledViewport region.x/y/w/h not checked for finite/non-NaN before clamp arithmetic**
  - _Evidence:_ Verified by running `new Uint8Array(NaN)` — produces length 0, does not throw. NaN <= 0 is false (NaN comparisons all return false), so the guard at decode-level.ts:104 is bypassed for NaN inputs. Same gap exists in tiled-decode-pool.ts:382-386 (decodeTiledViewportPooled has iden
- L100-105 **NaN region dimensions bypass empty-check and allocate huge buffer**
  - _Evidence:_ Lines 100-104: NaN propagates through Math.min/Math.max. NaN < 0 is false, so the `rw <= 0 || rh <= 0` guard at line 104 fails to catch NaN. Subsequent flow uses viewport.w/h in stitchTileDecodes (line 65: `new Uint8Array(viewport.w * viewport.h * bpp)`) where NaN multiplication 
- L97-97 **decodeTiledViewport defends against undefined bitsPerSample on a non-nullable typed field**
  - _Evidence:_ Confirmed: level-source.ts:7 declares bitsPerSample: 8 | 16 as required on the tiled variant; decode-level.ts:97 uses `source.bitsPerSample ?? 8`. The fallback is unreachable under the declared type. The same pattern appears in tiled-decode-pool.ts:389 `const bits = header.bitsPe
- L125-138 **decodeLevel throws on region+kind=whole but silently defaults region for kind=tiled — asymmetric contract**
  - _Evidence:_ Confirmed: decode-level.ts:131-137 implements an asymmetric contract — region passed with whole throws, region omitted with tiled silently defaults to full ROI. The type signature `region?: ImageRegion` does not surface either constraint.
- L100-107 **Region clamping done twice: in caller and again inside tilesOverlappingRegion**
  - _Evidence:_ decode-level.ts lines 100-103 perform Math.min/Math.max clamping; tilesOverlappingRegion in tiling.ts lines 68-71 repeats the identical clamp on the already-clamped viewport. The same pattern appears in tiled-decode-pool.ts lines 382-385. The work is redundant but cheap; severity
- L20-45 **decodeWhole creates an IIFE async drain and awaits three independent promises**
  - _Evidence:_ decode-level.ts:29-42 confirms the IIFE drain pattern followed by four sequential awaits. The push/drain dataflow does naturally race (drain awaits events while push pumps them), but the chain of awaits adds microtask overhead. Self-rated low confidence and low severity since dec

**packages/jxl-pyramid/src/grid-layout.ts**
- L15-22 **rowSpan formula (base / aspect) / base simplifies to 1 / aspect — `base` (columnWidthPx) is dead and the formula is unit-incoherent**
  - _Evidence:_ Verified algebra: (base / aspect) / base = 1 / aspect. The `base` variable from columnWidthPx is dead in the rowSpan computation. Function signature accepts columnWidthPx but doesn't use it meaningfully. Concrete failure: caller passing different columnWidthPx values gets identic
- L15-23 **layoutFromIndex assumes entry.aspect is positive — divide-by-zero or NaN propagates to rowSpan**
  - _Evidence:_ Confirmed: grid-layout.ts:21 lacks any aspect-positivity guard; GalleryIndexEntry declares `aspect: number` with no refinement; combined with no manifest schema validation (contracts-004), aspect=0 or NaN from a bad index would propagate. Math.max(1, NaN) = NaN. The math bug susp

**packages/jxl-pyramid/src/index.ts**
- L1-14 **No deprecation-warning framework — backwards-incompatible changes to exported surface have no migration path**
  - _Evidence:_ Confirmed: index.ts is bulk star re-export with no JSDoc, no @deprecated annotations anywhere in src. Opportunity for a deprecation framework is valid but low severity; menu-listed gap.

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L141-321 **`destroyed` flag is checked in 4 places but never set — destroy() method missing, getOrCreatePool's guard is dead code**
  - _Evidence:_ Verified by reading the full file: `private destroyed = false;` (line 152). Checks at lines 172, 187, 222, 235, 307. No `this.destroyed = true` assignment anywhere in tiled-decode-pool.ts. Concrete consequence: in test / HMR / multi-tenant scenarios there's no recovery path; comb
- L40-60 **`stitch` in tiled-decode-pool.ts is byte-for-byte equivalent to `stitchTileDecodes` in decode-level.ts — divergence risk**
  - _Evidence:_ Verified by direct file comparison: tiled-decode-pool.ts:40-60 and decode-level.ts:60-83 have identical stitching logic — same fast-path condition (decoded.width === viewport.w && dx === 0), same per-row fallback with subarray copy. Divergence risk is real: any fix to one (e.g., 
- L66-124 **Global nextWorkerId is monotonic across all sessions; id reuse on overflow could mis-route worker replies**
  - _Evidence:_ Verified tiled-decode-pool.ts:66 and 73. ID is module-scoped and never reset. Each onMessage filters by `ev.data.id !== id`. Per-decode listeners are added (line 110), so multiple in-flight decodes on the same worker each see all messages — id uniqueness is the only routing guara
- L23-26 **Worker factory URL provenance is implicit; no allowlist defense if ever wired to manifest**
  - _Evidence:_ Verified tiled-decode-pool.ts:23-26 and 378. workerFactory is caller-supplied today (see pyramid-decode.js:18-22 — `new Worker(new URL('../lightbox/tiled-decode-worker.js', import.meta.url))` is a closed-over hard-coded URL). Severity is appropriately low (forward-looking hardeni
- L76-99 **onMessage handler does not check `settled` before resolving — late message after error path causes double-settle (benign but indicates contract gap)**
  - _Evidence:_ Verified at tiled-decode-pool.ts:76-95. onError guards on `if (settled) return;` (line 95) but onMessage does not (line 76-93). cleanup() at line 100-109 sets settled=true. The race is real but benign because JS promises ignore subsequent settle calls. The asymmetry is the real f
- L171-179 **prewarm() returns synchronously but worker WASM module load is asynchronous — first request after prewarm may still pay the cold-start cost without observable signal**
  - _Evidence:_ prewarm() (lines 171-179) is synchronous and the JSDoc explicitly states 'their top-level preloadJxlModule() runs' which is asynchronous. No readiness mechanism is exposed by the pool API. The semantics are exactly as described; the comment 'Re-warm on first use' at line 317 conf
- L323-364 **decodeTilesParallel hand-rolls a coroutine slicer; a structured TaskGroup-style helper would handle cancellation, partial failure, and AbortSignal uniformly**
  - _Evidence:_ decodeTilesParallel (lines 323-364) and decodeTiledViewport in decode-level.ts (lines 114-119) both implement coroutine/Promise.all parallel-tile patterns. Neither accepts AbortSignal nor exposes progress. The opportunity for a shared helper is real and evidenced by duplication; 
- L329-332 **decodeTilesParallel returns [] when workers.length === 0, but caller's stitch over [] yields a zero-filled viewport — silent visual corruption**
  - _Evidence:_ Lines 329-332 do return [] on empty workers. stitch() at line 40-60 over empty parts produces an all-zero Uint8Array (allocation only, no fills). decodeTilesParallel is module-internal and only called from decodeTiledViewportPooled where line 414 guards, so the path is unreachabl
- L293-300 **worker.terminate() exceptions swallowed without logging**
  - _Evidence:_ src/tiled-decode-pool.ts:293-300 — silent catch around terminate(). Low risk in practice (browser Worker.terminate is void) but no observability if a shim or future implementation throws. The finding is accurate at low severity.
- L307-318 **Private field accessed via bracket notation bypasses encapsulation and typing**
  - _Evidence:_ src/tiled-decode-pool.ts:152 initializes `destroyed = false`; grep confirms no reassignment anywhere in the file. The class has no destroy() method. So `pool["destroyed"]` is invariantly false at line 307, making the !destroyed branch dead code. `p["minIdle"]` (line 318) is also 
- L76-99 **onMessage runs cleanup() unconditionally even if onError already fired**
  - _Evidence:_ src/tiled-decode-pool.ts:76-99 — onMessage has no `if (settled) return` guard, while onError does (line 95). Cleanup happens to be idempotent and Promise resolve/reject after settlement is a no-op, so no functional bug. The asymmetric guard is a clarity / consistency issue, corre
- L186-214 **acquire() declared async but does no awaits — concurrent callers race against shared state without queueing**
  - _Evidence:_ src/tiled-decode-pool.ts:186-214 — acquire is `async` but has no awaits. The fallback at lines 414-418 (caller) silently degrades to single-WASM decode when liveWorkers is empty. Not a correctness issue, but the silent degradation matches the description. Reasonable info-level fi
- L420-425 **release() in finally can throw and mask the decode error**
  - _Evidence:_ src/tiled-decode-pool.ts:420-425 — release() is called bare in finally. release() loops setTimeout-arming over each worker; any throw inside replaces the original decode error per JS semantics. The probability is low (release is mostly safe operations) but the masking pattern is 
- L306-321 **getOrCreatePool reads private fields via ["destroyed"] / ["minIdle"] bracket access — bypasses TS access control**
  - _Evidence:_ Confirmed: tiled-decode-pool.ts:307 reads `pool["destroyed"]` and line 318 reads `p["minIdle"]`. Both fields are declared private (lines 145, 152). The bracket access compiles but is fragile to rename refactors. Note: the `destroyed` field is never set to true anywhere in the cla
- L306-321 **getOrCreatePool prewarms on first call — this is on the user's first interactive frame**
  - _Evidence:_ Code at tiled-decode-pool.ts:306-321 matches the description exactly. The pool is created lazily on first acquire, and `p.prewarm()` synchronously calls `spawnOne()` per worker (via `this.factory()`); web/lightbox/tiled-decode-worker.js imports and calls `preloadJxlModule()` at t

**packages/jxl-pyramid/src/tiling.ts**
- L104-109 **canUseParallelTileWorkers returns false when `crossOriginIsolated` is undefined — Node.js worker_threads contexts always lose parallel path**
  - _Evidence:_ Verified at tiling.ts:107-108: returns false when crossOriginIsolated is undefined. Verified at decode-level.ts:108: parallel gate uses canUseParallelTileWorkers. Verified test at decode-level.test.ts:60: passes parallel:true but Bun/Node lacks crossOriginIsolated → wantParallel=
- L73-78 **Tile index math uses Math.floor((rx+rw-1)/tileSize) — overflow at edge**
  - _Evidence:_ The author's own analysis confirms NaN propagates safely to empty array (degrades to no-op) and u32 max can't overflow Number.MAX_SAFE_INTEGER. The finding is low-priority defense-in-depth — caller-bug surfacing via Number.isFinite. Confirmed as info.
- L37-51 **JXTC container version is hardcoded to 1 in parser — no migration path documented or signaled**
  - _Evidence:_ Confirmed: tiling.ts:41 throws on `getUint32(4) !== 1`. JxtcHeader interface (line 12-21) carries no version field, so consumers can't route on version. The check is correct but offers no migration path or version metadata. Informational; low priority.


### Info (6)

**packages/jxl-pyramid/src/choose-level.ts**
- L15-15 **Trailing `?? null` is unreachable after non-empty length guard**
  - _Evidence:_ src/choose-level.ts:12 returns null when levels.length === 0, so sorted is non-empty afterward and sorted[sorted.length-1] is always defined. The trailing `?? null` on line 15 is unreachable. Strict TS noUncheckedIndexedAccess may need the fallback for type-safety, but at runtime
- L8-16 **chooseLevelForTarget re-sorts a readonly array on every call though manifest is already sorted ascending by ingest**
  - _Evidence:_ Confirmed: pyramid-ingest/src/manifest.ts:75 in buildManifest does `const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);` before writing. chooseLevelForTarget at choose-level.ts:13 re-sorts on every call. The PyramidManifest.levels type carries no ordering invar

**packages/jxl-pyramid/src/decode-level.ts**
- L1-138 **All failure modes throw generic Error — no taxonomy for callers to discriminate**
  - _Evidence:_ src/decode-level.ts lines 35, 43, 104, 132 all throw `new Error(...)`. src/tiled-decode-pool.ts:91 and 97 also throw `new Error(...)`. Callers cannot discriminate by class. The opportunity to introduce sentinel error classes is real and aligns with CLAUDE.md's emphasis on disting

**packages/jxl-pyramid/src/tiled-decode-pool.ts**
- L1-426 **Zero logging anywhere in the pool — spawn fail, recycle, fallback all silent**
  - _Evidence:_ Grep over src/tiled-decode-pool.ts for `console.` returns zero matches. Compare to jxl-scheduler/pool.ts which has console.warn (line 388, 585) and spawnFailed metric (line 22, 56, 306). This pool has no observability whatsoever. Reasonable info-level opportunity.
- L323-364 **No retry on transient worker failures — single failure aborts whole viewport**
  - _Evidence:_ src/tiled-decode-pool.ts:349-355 — first error sets `failed=true` and aborts all coros. The viewport-level call in decodeTiledViewportPooled (line 420-422) does not retry. For transient worker crashes, an opportunity to retry once on a fresh handle is reasonable. Info-level, opti
- L307-318 **Bracket-access of private fields defeats TypeScript and may inhibit JIT inlining**
  - _Evidence:_ tiled-decode-pool.ts:307 uses `pool["destroyed"]` and line 318 uses `p["minIdle"]` to bypass TS private-field visibility (declared at lines 152 and 145). Code-smell is real; the JIT-inlining concern is plausible but unverified. Severity 'info' is appropriate.


---

## Uncertain (deferred to QUESTIONS.md)

- `packages/jxl-pyramid/src/tiled-decode-pool.ts:333-364` **On first failure, sibling workers' in-flight WASM jobs continue and pollute next acquire**
  - _Why uncertain:_ The author's own analysis is internally inconsistent (concludes 'no in-flight job is orphaned in the literal sense' then speculates about a 'risk window' for stale replies). Each worker has only one in-flight Promise at a time (sequential await in the coro), and cleanup() removes
- `packages/jxl-pyramid/src/tiled-decode-pool.ts:338-357` **decodeTilesParallel mutates a sparse results array via late-binding indices**
  - _Why uncertain:_ Code structure matches the finding (lines 333-348). However, since `idx = next++` is monotonically increasing and writes complete (potentially out-of-order) at indices 0..N-1, the array is transiently holey but always fully populated before consumption. V8's elements-kind transit

---

## Detector counts

| Detector | Candidates | Confirmed | FP | Uncertain |
|----------|-----------:|----------:|---:|----------:|
| concurrency | 24 | 18 | 6 | 0 |
| contracts | 18 | 18 | 0 | 0 |
| errors | 24 | 22 | 1 | 1 |
| logic | 20 | 12 | 8 | 0 |
| performance | 14 | 12 | 1 | 1 |
| security | 11 | 11 | 0 | 0 |

---

## Workspace

Full per-candidate JSON (candidates → verified → plan): `.epiccodereview/20260609T103535Z/sections/000/`

- `findings/<role>.json` — raw finder output
- `verified_chunk_<NN>.json` — verifier verdicts + evidence
- `plan.json` — fix-task plan (93 pending, 2 deferred; all sonnet/workalone)
- `fix_briefs/<file>.json` — per-file extracts ready for fixers if you resume

## Next

Review halted at planning stage per user request. To resume:

1. Re-enter worktree: `git worktree list` → `C:\Fooaw-converter-wasm\.worktrees\jxl-pyramid-warm-pool`
2. Pick fix scope (recommend: critical + high + 16-bit propagation chain first)
3. Skill resume not native — dispatch fixers manually from `fix_briefs/*.json`

Stash carrying parked HANDOFF docs on the original branch: `stash@{0}: epiccodereview: park HANDOFF docs`

---

# Lens 1 — Strategic view + pipeline (2026-06-09)

**Files in memory:** `choose-level.ts` (26 LoC), `decode-level.ts` (138 LoC), `tiled-decode-pool.ts` (426 LoC).

## Pipeline + data passed

```
manifest.json[] → PyramidLevel[]
    ↓
choose-level.ts: chooseLevelForTarget(levels, targetLongEdge) → PyramidLevel
    ↓ (level-source.ts → LevelSource | raw containerBytes)
    ↓
    ├── decode-level.ts: decodeLevel(LevelSource, region?)
    │       whole  → decodeWhole(bytes)              [hardcoded rgba8 ← bug]
    │       tiled  → decodeTiledViewport()           [main-thread Promise.all]
    │                   stitchTileDecodes(viewport, parts, bpp)
    │
    └── tiled-decode-pool.ts: decodeTiledViewportPooled(containerBytes, region, opts)
            parseJxtcHeader(bytes) → {imageW, imageH, tileSize, bitsPerSample}
            pool.acquire(N) → workers
            decodeTilesParallel(bytes, tiles, workers)
               per-worker coroutine: postMessage({id, bytes, region}) → WorkerReply
            stitch(viewport, parts, bpp)
            pool.release(workers)

Both return: DecodedLevel { pixels: Uint8Array, width, height }
```

## Strategic observations (action items)

### L1-1. Sibling-decoder divergence
- **Category:** bug-prone, perf
- **Issue:** Two source-of-truth schemes: decode-level reads LevelSource.bitsPerSample, pool re-parses JXTC header every call. Two stitch impls (byte-for-byte identical), two clamp blocks, two pickRegionDecoder selections.
- **Fix:** Extract `clampRegion`, `stitch`, `pickRegionDecoder` to shared helper (tiling.ts or new decode-core.ts). Pool entry should accept pre-parsed header to skip re-parse.

### L1-2. Pool path bypasses LevelSource
- **Category:** perf + contract
- **Issue:** Pool takes raw bytes — caller already has bits/dims from manifest but pool re-discovers them via header parse on hot path.
- **Fix:** Add overload `decodeTiledViewportPooled(source: LevelSource, region, opts)` reusing manifest dims; keep raw-bytes overload for transitional callers.

### L1-3. choose-level re-sorts every viewport change
- **Category:** speed + efficiency
- **Issue:** `[...levels].sort(…)` allocates + O(n log n) on every pan/zoom/IntersectionObserver fire. Manifest is pre-sorted ascending by pyramid-ingest.
- **Fix:** Drop the sort (`levels.find(l => longEdge(l.w, l.h) >= target) ?? last ?? null`). If defensive sort wanted: memoize per-levels-identity via WeakMap.

### L1-4. `decodeTilesParallel` is a half-built scheduler
- **Category:** bug + missing feature
- **Issue:** Hand-rolled coroutine slicer with no cancellation, no per-tile timeout, no work-stealing replacement on failure. First failure orphans in-flight work.
- **Fix:** Thread `AbortSignal` through `decodeTiledViewportPooled → decodeTilesParallel → decodeTileWithWorker → onMessage/onError`. Add per-call timeout configured at pool construction.

### L1-5. Singleton pool ignores subsequent workerFactory
- **Category:** bug + missing feature
- **Issue:** `getOrCreatePool(factory)` binds first factory forever — test swaps, HMR, per-gallery factories no-op. `destroyed` flag read 4 places, written 0.
- **Fix:** Add `PyramidWorkerPool.destroy()` (sets destroyed, drains active+idle). Detect factory-identity change in `getOrCreatePool` and rebuild. Export `disposeWorkerPool()`.

### L1-6. decodeWhole hardcodes rgba8 — 16-bit whole-frame silently downsampled
- **Category:** critical bug
- **Issue:** `decodeWhole` (L22) → `createDecoder({ format: 'rgba8' })`. `LevelSource.kind='whole'` carries bitsPerSample but level-source.ts strips it via Pick.
- **Fix:** Thread `bits: 8|16` through `decodeWhole(bytes, bits)` → `format: bits===16 ? 'rgba16' : 'rgba8'`. Stop the `Pick` in level-source.ts.

### L1-7. Worker structured-clone amplification
- **Category:** perf
- **Issue:** `postMessage({bytes, region})` per tile per worker. 16 tiles × 4 workers = up to 64 copies of multi-MB JXTC container. Comment L117-121 acknowledges.
- **Fix:** Send container **once per worker** at acquire-time via `{type:'load', bytesId, bytes}`. Worker caches `bytesId → bytes`. Subsequent tile decodes send `{id, bytesId, region}` only. Worker.js protocol bump.

### L1-8. Pool fallback bypasses the pool
- **Category:** perf + missing feature
- **Issue:** When `liveWorkers.length === 0` (pool at cap), pool falls back to main-thread single `decodeRegion` (L417). Slower than queuing.
- **Fix:** Expose `pool.awaitOne()`: resolves when worker frees. Bounded wait; main-thread WASM only on timeout. Acquisition queue ≠ pixel-buffer pool (no transferable conflict).

### L1-9. Sort-key vs select-key mismatch in chooseLevelForTarget
- **Category:** bug
- **Issue:** `levelRank = w*h` but selection uses `longEdge`. With mixed aspect ratios, smallest-rank fails long-edge test → fall-through picks 'largest' rather than next-larger-by-long-edge.
- **Fix:** Sort by `longEdge` (or eliminate sort per L1-3) so `find(longEdge ≥ target)` is monotone.

### L1-10. No header memoization across pool calls
- **Category:** perf
- **Issue:** Each `decodeTiledViewportPooled` re-parses 32-byte header per ROI. Header is immutable per-level. Pan/zoom over same level → repeated parse.
- **Fix:** WeakMap<Uint8Array, JxtcHeader> cache keyed by `containerBytes` identity. Better still: thread `header` through caller (see L1-2).

### L1-11. CLAUDE.md crosscheck
- **Category:** info
- **Issue:** None of L1-1…L1-10 conflict with the rejected-claims list. Transferable + SAB constraints respected. Worker-input bytes pool is read-only — distinct from rejected pixel-buffer pool.


---

# Lens 2 — Hot-path allocations

Pan/zoom UI fires `chooseLevelForTarget` + `decodeTiledViewportPooled`/`decodeTiledViewport` at frame rate. Each per-call allocation is multiplied by FPS × tile-count.

### L2-1. `decodeRegion` arrow allocated per call (pool)
- **Category:** perf
- **Issue:** `tiled-decode-pool.ts` L390-395: when `options?.decodeRegion` absent, a fresh `async (bytes, r) => {...}` closure + branch object is allocated on every `decodeTiledViewportPooled` invocation. Same closure for the entire lifetime of a given level.
- **Fix:** Hoist to module scope: `const _decode8 = async (b,r) => ...; const _decode16 = async (b,r) => ...; const decodeRegion = options?.decodeRegion ?? (bits===16 ? _decode16 : _decode8);` — zero per-call alloc.

### L2-2. `[...levels].sort` per UI frame (choose-level)
- **Category:** efficiency + speed
- **Issue:** L13 allocates new array + comparator call per UI frame; cite L1-3 / perf-a1b2c3d4.
- **Fix:** Drop the sort (manifest pre-sorted). Final code: `return levels.find(l => longEdge(l.w, l.h) >= targetLongEdge) ?? levels[levels.length - 1] ?? null;` — zero alloc per call.

### L2-3. `Promise.all(tiles.map(async ...))` per ROI (decode-level)
- **Category:** perf
- **Issue:** L114-119 `tiles.map` allocates intermediate array of Promises + closure per tile + `{region, decoded}` object literal per tile. For 16-tile viewport: 16 closures + 16 promises + 16 literals + 1 intermediate array per ROI.
- **Fix:** Restructure as preallocated `parts = new Array(tiles.length)` with a coroutine-style for-await loop (same shape as pool's `decodeTilesParallel`). Eliminates the intermediate Promise array and `.map`'s allocator chain.

### L2-4. Per-row `subarray` view in stitch fallback path
- **Category:** perf (low)
- **Issue:** Both files: partial-width tiles take `decoded.pixels.subarray(srcOff, srcOff+srcStride)` per row → 24-byte view object per row. For 1024-tall viewport with mixed-width tiles: ~1k view allocs per stitch.
- **Fix:** Two options. (a) Compute `srcOff` and `dstOff` and call `pixels.set(decoded.pixels.subarray(srcOff, srcOff+srcStride), dstOff)` — same as now; can't avoid subarray for cross-buffer offset+offset copy. (b) Use a worker-side packer that writes directly into a shared output offset (out of scope here). Accept; mark info. The current fast-path branch already wins for the common case.

### L2-5. `setTimeout(() => ..., ms)` closure per `armIdleTimer`
- **Category:** perf (low)
- **Issue:** L268: each release into idle arms a fresh arrow closure capturing `h`. Bounded by `maxSize` (≤8) but every release triggers it.
- **Fix:** Use `setTimeout`'s 3rd-arg passthrough: `globalThis.setTimeout(this._reapBound, idleTimeoutMs, h)` with a pre-bound `_reapBound = (h) => { if (this.idle.includes(h) && ...) this.reap(h); }` on the instance. Single closure for the pool lifetime.

### L2-6. `idle.includes(h)` linear scan per release
- **Category:** perf
- **Issue:** L227: `if (!this.idle.includes(h)) this.idle.push(h)` — O(idle) per worker returned. Already perf-c3d4e5f6. With minIdle=2 + bursty release: O(maxSize) per call.
- **Fix:** Track idle membership on the handle itself: `h.inIdle: boolean`. Set true on push, false on shift/reap. `if (!h.inIdle) { h.inIdle = true; this.idle.push(h); }`. O(1).

### L2-7. `new Array(tiles.length)` sparse pre-size (pool)
- **Category:** perf (engine-dependent)
- **Issue:** L333: `new Array(N)` creates HOLEY array. V8 transitions to dictionary mode for large holey arrays. Coroutines fill in random order (work-stealing) → never becomes PACKED.
- **Fix:** Use `[]` then `results.length = tiles.length`? Worse. Best: `Array.from({length: tiles.length}, () => null)` — PACKED, all slots `null` initially. Per-tile write replaces null with `{region, decoded}`. Marginal but real for large tile counts.

### L2-8. `parseJxtcHeader(containerBytes)` repeated per ROI
- **Category:** perf
- **Issue:** L381: cite L1-10 / perf-b2c3d4e5. 32-byte parse per ROI. Same bytes across pan/zoom on same level.
- **Fix:** WeakMap-cache (see L1-10). For Lens-2 purposes: same root cause as L1-2 (pool ignores manifest-known dims). Either fix removes the alloc.

### L2-9. `decodeWhole` IIFE async drain (decode-level)
- **Category:** perf
- **Issue:** L20-45: `createDecoder({...})` per call (mandatory — stream decoder), plus `(async () => { for await ...})()` IIFE allocates Generator + Promise. Three sequential awaits.
- **Fix:** Use the streaming API the same way but reuse a module-level `createDecoder` config object literal (saves one alloc per call): hoist `const WHOLE_DECODER_OPTS = Object.freeze({ format: 'rgba8', ... })`. Minor but free.

### L2-10. FEATURE: per-level `DecodePlan` cache
- **Category:** feature opportunity
- **Issue:** Every pan/zoom recomputes: clamped viewport, tile list, header parse, decodeRegion selection. All deterministic on `(LevelSource, region)`.
- **Fix:** Introduce `prepareDecodePlan(source, region) → { viewport, tiles, header, decodeRegion }` cached on the LevelSource (WeakMap). decode-level + pool both consume the same plan. Eliminates ~5 distinct hot-path allocs in one shot. Pairs with L1-1 extract-helpers refactor.

### L2-11. FEATURE: stitch buffer reuse across pan
- **Category:** feature opportunity (constrained)
- **Issue:** Output `pixels` alloc dominates byte cost: `viewport.w * viewport.h * bpp`. For 2048×1024×4 = 8 MB per stitch. Pan throws old pixels away.
- **Fix:** Caller-owned buffer: `decodeTiledViewportPooled(bytes, region, { outBuffer?: Uint8Array, ... })`. Caller maintains a single recyclable Uint8Array sized to viewport max. CLAUDE.md rejects pixel-buffer pool because *transferred* buffers detach — this is caller-owned, not transferred. Safe if caller commits to ownership semantics. Document the contract.

### L2-12. INFO: `decodeTileWithWorker` per-tile closure cost
- **Category:** info
- **Issue:** L74: per tile allocates new Promise + onMessage + onError + cleanup closures + `settled` flag. Inevitable for the request-response promise pattern. Mention only — bytes payload dwarfs this.


---

# Lens 3 - Worker protocol

Scope: `WorkerReply` union (L62-64), `decodeTileWithWorker` (L68-124), spawn/recycle wiring (L234-250), `decodeTilesParallel` driver (L323-364), implicit `web/lightbox/tiled-decode-worker.js` contract.

### L3-1. Request shape carries no `format` - worker hardcoded rgba8
- **Category:** critical bug
- **Issue:** Pool's `postMessage({id, bytes, region})` (L122) has no bits field. Worker calls only `decodeTileContainerRegionRgba8` regardless of source format. 16-bit tiled levels silently corrupt (cite logic-001 critical + L1-6).
- **Fix:** Extend request to `{id, bytes, region, format: 'rgba8'|'rgba16'}`. Worker switches on `format`. Pool passes `format: bits===16 ? 'rgba16' : 'rgba8'` derived once per level (see L2-1). Worker.js needs the parallel rgba16 decode wired.

### L3-2. No runtime validation of `WorkerReply` shape
- **Category:** bug
- **Issue:** L76-92 trusts `ev.data` as the typed union. A buggy worker sending `{id, ok:true}` (no pixels) crashes at `new Uint8Array(undefined)`. Untrusted-worker case (per security-d4e5f6a7) is plausible: extension-injected workers, dev-mode hot-swaps.
- **Fix:** Validate inside `onMessage`: check `typeof ev.data.id === 'number'`, `typeof ev.data.ok === 'boolean'`, then ok-branch requires pixels (ArrayBuffer or Uint8Array) + numeric width/height. Reject with `Error('malformed worker reply')` instead of crashing.

### L3-3. `pixels: ArrayBuffer` declared but `Uint8Array` posted - silent copy
- **Category:** perf bug
- **Issue:** L62-64 types `pixels: ArrayBuffer` but `web/lightbox/tiled-decode-worker.js:10` posts `out.pixels` (a `Uint8Array` view) with transfer of `out.pixels.buffer`. L86: `new Uint8Array(ab)` interprets the view as a length, copying contents. ~1 MB memcpy per tile. Comment at L80-83 lies about zero-copy (cite logic-004 + verified evidence).
- **Fix:** Either: (a) widen reply type to `pixels: ArrayBuffer | Uint8Array` and branch at receive - `ev.data.pixels instanceof Uint8Array ? ev.data.pixels : new Uint8Array(ev.data.pixels)`. (b) change worker to post `out.pixels.buffer` directly. (a) is safer - touches one file.

### L3-4. Container bytes structured-cloned per tile (no load/decode split)
- **Category:** perf
- **Issue:** L122 postMessage sends full `bytes` (multi-MB JXTC container) per tile. With 16 tiles x 4 workers, browser performs up to 64 structured clones of the same buffer. Code comment L117-121 acknowledges. SAB is the only zero-copy answer for fan-out and is out of scope per file.
- **Fix:** Protocol bump: `{type:'load', bytesId, bytes}` ONCE per worker (sent at pool.acquire time or first decode). Worker caches `Map<bytesId, Uint8Array>` (LRU, cap=4). Subsequent `{type:'decode', id, bytesId, region, format}` carries only ~24 bytes. Pool tracks `bytesId to workers warmed with it`. Worker pool gains a hot/cold acquire distinction.

### L3-5. No `cancel` message - in-flight worker tiles cannot be stopped
- **Category:** bug + missing feature
- **Issue:** Once worker has the request, it runs to completion. UI pan/zoom invalidates the viewport but worker keeps decoding the now-discarded tile. Caller-side reject is cosmetic.
- **Fix:** Protocol `{type:'cancel', id}`. Worker checks before posting reply (libjxl tile decode is non-interruptible mid-call per CLAUDE.md, so this is best-effort: skip the postMessage if cancelled, freeing main from receiving + memcpy). Pairs with L1-4 AbortSignal.

### L3-6. No worker readiness signal - prewarm cold-start invisible
- **Category:** bug
- **Issue:** L171-179 `prewarm()` synchronously creates workers and arms idle timer. Worker top-level `preloadJxlModule()` is async; first decode after prewarm still pays compile cost. Pool acquires the worker as if warm. (cite concurrency-014.)
- **Fix:** Worker posts `{type:'ready'}` once `preloadJxlModule()` resolves. `WorkerHandle` gains `ready: boolean`. Pool's `acquire()` skips not-ready handles (or returns a promise that resolves on ready). Idle-timer arms only after ready.

### L3-7. `onMessage` missing `settled` guard - late reply re-settles
- **Category:** bug
- **Issue:** L76-92 resolves/rejects without checking `settled`. `onError` (L94-99) does check. Asymmetric. Late message after error -> `cleanup()` runs twice + already-settled Promise gets a no-op resolve. Benign now, fragile if state expands.
- **Fix:** Add `if (settled) return;` at the top of `onMessage`. Hoist `settled` into closure (already is). One-line fix.

### L3-8. Poisoned worker stays in pool after silent fail
- **Category:** bug
- **Issue:** If a worker mis-reports (e.g., wrong-id reply, malformed shape) and `decodeTileWithWorker` rejects (after L3-2 fix), pool.release returns the handle to idle (L222 - only destroys if `terminated|bad`). Next caller gets the same bad worker.
- **Fix:** On reject in `decodeTileWithWorker`, mark handle as bad via callback into pool (`pool.markBad(worker)`). Or: `decodeTilesParallel` catches per-tile error and calls a pool-exposed `recycle(worker)` before the worker re-enters idle. Pool already has `recycle()` internal - promote to method or thread through error callback.

### L3-9. Worker error is opaque string - no taxonomy for recycle vs retry
- **Category:** feature
- **Issue:** L91 / L97 wrap `error: string` into `new Error(string)`. Caller cannot distinguish 'malformed bytes (worker is fine)' from 'OOM/crash (worker is poisoned)'. Caller in `decodeTilesParallel` (L349-355) bails out the whole slice regardless.
- **Fix:** Reply gains `error: { code: 'JXTC_PARSE'|'OOM'|'BAD_REGION'|'INTERNAL', message }`. Pool gets a `shouldRecycleOnCode(code)` policy. JXTC_PARSE -> caller bug, keep worker. OOM/INTERNAL -> recycle. BAD_REGION -> caller bug, keep worker.

### L3-10. Module-scope `nextWorkerId` not reset on dispose
- **Category:** bug (low)
- **Issue:** L66 monotonic across all pools. If pool is rebuilt (after L1-5 destroy/recreate), ids continue from the old counter. Late messages from the destroyed pool's workers - if not terminated yet - could collide with new-pool tile ids.
- **Fix:** Pool-instance counter: move `nextWorkerId` to `class PyramidWorkerPool` field, initialize 0 per instance. Combined with `destroy()` ensuring worker `terminate()` runs before new ids issued, late-message routing is impossible.

### L3-11. No reply timeout in protocol; only host-side timeout possible
- **Category:** bug
- **Issue:** Protocol gives the worker no deadline. Host-side timeout (per L1-4) rejects the Promise but the worker keeps churning, blocking pool slot until completion or termination. Cite concurrency-003.
- **Fix:** Include `deadlineMs?: number` in request. Worker tracks via `Date.now()` and self-aborts at next libjxl call boundary (best-effort, libjxl ROI decode is one call - so a timeout primarily benefits the cleanup case: worker observes deadline expired BEFORE running, replies `{ok:false, error:{code:'TIMEOUT'}}` instantly when host re-uses it).

### L3-12. FEATURE: progress / heartbeat for worker liveness
- **Category:** feature
- **Issue:** Pool has no liveness signal between request and reply. A worker stuck in libjxl (rare but possible - pathological JXTC) is indistinguishable from a worker doing legitimate slow work. Health monitor (concurrency-023) needs an input signal.
- **Fix:** Optional `{type:'progress', id, percent}` from worker at coarse intervals (e.g., post-decode-before-encode). Pool's monitor (introduced separately) marks workers silent for >N seconds as suspect. Low priority but unlocks adaptive timeouts.


---

# Lens 4 - Lifecycle + cancellation

Scope: `PyramidWorkerPool` class state machine (L141-302), module singleton (L304), `getOrCreatePool` (L306-321), `prewarm`/`acquire`/`release` (L171-230), `recycle`/`destroyHandle` (L252-301), and the end-to-end abort path (none currently exists).

### L4-1. `destroyed` flag never set true - all four guards are dead branches
- **Category:** bug
- **Issue:** L152 `private destroyed = false;`. Read at L172, 187, 222, 235, 307 but never assigned `true` anywhere in the class. `getOrCreatePool` uses `pool['destroyed']` (L307) to detect torn-down pools but the condition can never fire. Cite logic-006, contracts-015.
- **Fix:** Precondition for L4-2 destroy(). On its own: useless guard. Fix as part of the destroy() implementation.

### L4-2. No public `destroy()` / `dispose()` - singleton leaks across tests + HMR
- **Category:** bug + missing feature
- **Issue:** Module-scope `let pool: PyramidWorkerPool | null = null` (L304). No exported teardown. Test reload, gallery dismount, route change all leave the pool with active workers. Combined with L4-1, even attempting `pool['destroyed'] = true` does not terminate workers.
- **Fix:** Add `destroy(): Promise<void>` method: set destroyed=true, drain idle (call destroyHandle on each), abort active (per L4-3), wait for active set to drain or hard-terminate after grace period, then null the `handleByWorker` WeakMap entries. Export `disposePyramidWorkerPool()` that nulls the module singleton and awaits destroy().

### L4-3. No AbortSignal threading viewport-end-to-end
- **Category:** bug + missing feature
- **Issue:** `decodeTiledViewportPooled` options (L376) has no `signal?: AbortSignal`. Likewise `decodeTilesParallel`, `decodeTileWithWorker`. Pan/zoom invalidates the viewport but in-flight worker tiles keep running, holding pool slots, racing to deliver pixels the UI will discard. Cite concurrency-009, L1-4.
- **Fix:** Thread `signal: AbortSignal` through all three. `decodeTileWithWorker`: on `signal.aborted` reject immediately; on `abort` event during in-flight, call `worker.postMessage({type:'cancel', id})` (L3-5) and reject with `AbortError`. `decodeTilesParallel`: AbortController internal, aborted on first failure OR external signal -> sets `failed=true`. Pool slot released regardless.

### L4-4. `armIdleTimer` only arms just-released handle - older idles never reaped
- **Category:** bug
- **Issue:** L261-273: when a worker is released, the timer is armed for THAT handle only, and the `idle.length > minIdle` check is evaluated at arm time. Earlier-enqueued idle handles, released when count was <= minIdle, never get a reaper armed. They stay warm forever (which is fine), but they also do not get reaped when later releases push count above minIdle. Cite logic-005.
- **Fix:** Re-arm reaper for ALL idle handles above the floor when the floor is crossed. Or: track a single `excessReaperTimer` for the pool; cycle the oldest idle handle when fired. Simpler: on every release, scan `idle.slice(0, idle.length - minIdle)` and ensure each has a timer. With max=8, scan is trivially cheap.

### L4-5. `getOrCreatePool` binds first-seen workerFactory forever
- **Category:** bug
- **Issue:** L306-321: subsequent calls with a different `workerFactory` are silently ignored - the existing singleton is returned. Tests inject mock factories that the first production call already overrode; second gallery using a different worker URL gets the wrong worker. Cite logic-003, L1-5.
- **Fix:** Detect factory-identity change: store `boundFactory` on the pool instance; if `getOrCreatePool(factory)` sees a different factory function reference AND the pool has zero active decodes, transparently call `destroy()` and rebuild. If active > 0, throw `Error('cannot swap workerFactory while pool is busy')` so callers see the conflict.

### L4-6. Worker terminated mid-decode hangs the in-flight promise
- **Category:** bug
- **Issue:** `recycle(h)` (L252-259) calls `destroyHandle(h)` which calls `worker.terminate()` (L296). If a tile decode is in flight and the worker has its `error` listener fire (recycling itself) OR another caller's `destroy()` runs, the in-flight `decodeTileWithWorker` Promise never settles - the message listener is removed by cleanup() but the worker is gone before the message ever arrived. Cite concurrency-002.
- **Fix:** Track in-flight requests per handle: `WorkerHandle.inflight = Set<{id, reject}>`. On `destroyHandle`, before `terminate()`, reject every in-flight request with `Error('worker terminated during decode')`. Then `cleanup()` in decodeTileWithWorker is idempotent (already settled).

### L4-7. Permanent recycle listener accumulation on long-lived workers
- **Category:** bug (low)
- **Issue:** L242-248 adds `error` + `messageerror` listeners at spawn but never removes them. `destroyHandle` calls `terminate()` which is a hard kill - listeners drop with the worker. So per-worker accumulation is OK. BUT: if `bad=true` is set externally and the handle is recycled in-place (some future change), listeners stack. Cite concurrency-011.
- **Fix:** Store the bound `recycle` reference on the handle: `h.recycleListener = recycle`. On any path that detaches the worker without terminating (none exists today; would be needed if pool ever supports worker handoff), call `removeEventListener`. Defensive but cheap.

### L4-8. `minIdle` floor not maintained after `destroyHandle` drop
- **Category:** bug
- **Issue:** If a worker errors and `recycle` -> `destroyHandle` removes it, idle count may fall below `minIdle`. Pool does not respawn to restore the floor. Next acquire spawns under cap (good) but the warm guarantee was silently broken between events.
- **Fix:** After `destroyHandle`, if `!destroyed` and `idle.length < minIdle && all.size < maxSize`, spawn replacement and push to idle. Defer if spawn fails.

### L4-9. No supersede semantics - newer ROI does not preempt older same-level
- **Category:** missing feature
- **Issue:** Pan generates a stream of ROI requests for the same level. Older request is still in flight when newer arrives. Pool has no notion of 'cancel all in-flight requests for level X'. UI must wait for the stale decode + the new one.
- **Fix:** Optional: tag requests with a `streamId` (per-viewport). Pool exposes `cancelStream(streamId)` that aborts in-flight + drops queued for that id. Implementation rides on L4-3 AbortController per stream. Owner remains the caller (UI).

### L4-10. FEATURE: per-context pool instead of module singleton
- **Category:** feature
- **Issue:** Module-scope singleton (L304) means: one pool per realm. Multiple galleries on one page share workers tied to whichever loaded first. Worker URL drift across galleries (L4-5) and no scoping to per-tab Worker quotas.
- **Fix:** Expose `createPyramidWorkerPool(opts)` factory. Keep `getOrCreatePool` for backward-compat with default config. Galleries get isolated pools; tests get fresh pools; production keeps the convenience singleton.

### L4-11. No worker liveness timeout - health monitor input gap
- **Category:** bug
- **Issue:** Pool has no notion of 'worker has not replied in N seconds'. Combined with L3-11 (no protocol deadline), the stuck-worker case is invisible to the pool. Cite concurrency-023.
- **Fix:** Pool config: `requestTimeoutMs?: number`. On `decodeTileWithWorker` enter, schedule `setTimeout(timeout, ms)`; on settle, clearTimeout. On fire, reject + mark handle bad + recycle. Distinct from request-side `deadlineMs` (L3-11): this is pool's enforcement, that is worker's self-awareness.

### L4-12. `spawnOne` partial-failure orphans handle in `all` set
- **Category:** bug
- **Issue:** L234-249: handle is added to `this.all` (L238) and `this.handleByWorker` (L239) BEFORE the lifecycle listener wiring at L243-248. If `worker.factory()` succeeded but `addEventListener` throws (some test doubles fail here), the try/catch swallows it and the handle is in `all` with no recycle listener - it cannot self-heal on error. Cite concurrency-018.
- **Fix:** Register handle to `all`/`handleByWorker` AFTER lifecycle wiring succeeds. Move L238-239 to after L246. Or: on the addEventListener catch, `terminate()` the worker + skip the handle. Either is a 4-line change.


---

# Lens 5 - Error propagation

Scope: every throw, reject, catch, and silent fallback across the three files. Cross-cutting: error taxonomy + observability are zero.

### L5-1. `decodeWhole` leaks WASM decoder on push/close/drain throw
- **Category:** high bug
- **Issue:** decode-level.ts L20-45: `decoder.dispose()` at L42 only runs after L39-41 (`push`, `close`, drain) all succeed. Any throw skips dispose; the WASM heap stays allocated and the JS-side decoder reference is GC'd without releasing libjxl state. Cite errors-dl-dispose-leak.
- **Fix:** Wrap in try/finally: `try { await decoder.push(bytes); await decoder.close(); await drain; } finally { await decoder.dispose().catch(() => {}); }`. dispose is idempotent per existing decoder contract.

### L5-2. `decodeWhole` drain IIFE rejection becomes unhandled
- **Category:** high bug
- **Issue:** decode-level.ts L29-37: the `(async () => { for await ... })()` IIFE is started but not awaited until L41. If push() throws synchronously OR close() throws BEFORE drain settles, the drain promise rejects independently with no observer - browser logs `Unhandled Promise Rejection`. Cite errors-dl-drain-unhandled-rejection.
- **Fix:** Capture the drain promise once: `const drainPromise = (async () => {...})();`. After try/finally on push+close, ALWAYS await drainPromise inside a `.catch()` or `Promise.allSettled([drainPromise, ...])` to consume the rejection.

### L5-3. NaN region dimensions bypass empty-check + over-allocate
- **Category:** low bug + security adjacent
- **Issue:** decode-level.ts L100-105 (and pool L382-385): `Math.min/Math.max` propagate NaN. `rw <= 0` is false when rw is NaN (NaN comparisons return false). Code proceeds with NaN-sized viewport. `new Uint8Array(NaN * NaN * 4)` is `new Uint8Array(0)` per ECMA spec (NaN ToInteger -> 0) which then silently produces a zero-pixel result. Cite errors-dl-nan-region-bypasses-clamp.
- **Fix:** Guard region inputs at entry: `if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) throw new Error('region values must be finite numbers');`. Single-line check at the top of decodeTiledViewport + decodeTiledViewportPooled.

### L5-4. `chooseLevelForTarget` silently accepts NaN/zero/negative target
- **Category:** low bug
- **Issue:** choose-level.ts L8-16: no validation of `targetLongEdge`. Negative or NaN -> `longEdge(l.w,l.h) >= targetLongEdge` is true for all l (or vacuously false for NaN); zero -> always picks smallest. Caller mis-passes a viewport metric and the picker silently delivers garbage. Cite errors-cl-divbyzero-zero-targetedge.
- **Fix:** `if (!Number.isFinite(targetLongEdge) || targetLongEdge <= 0) throw new RangeError('targetLongEdge must be a positive finite number');` at the top. Pair with L5-13 taxonomy if introduced.

### L5-5. `Promise.all` leaks in-flight tile decodes on first reject
- **Category:** high bug
- **Issue:** decode-level.ts L114-119: first rejecting tile aborts Promise.all but the other in-flight tile decodes continue racing to completion, consuming WASM heap until their final frame or dispose. No AbortSignal threading (cite L1-4, L4-3, concurrency-001).
- **Fix:** Replace Promise.all with the same coroutine pattern as pool's `decodeTilesParallel` (L323-364) and pre-wire AbortController. On first reject: signal.abort() -> subsequent iterations check signal.aborted before allocating + skip. Pairs with L4-3.

### L5-6. Four silent `catch {}` blocks in pool - failures invisible in prod
- **Category:** medium bug cluster
- **Issue:** tiled-decode-pool.ts L106-108, L114-116 (decodeTileWithWorker listener removal/attach), L246-248 (spawnOne listener attach), L209-211 (spawnOne factory call), L297-300 (terminate). All swallow without logging. Spawn-fail (logic-007, errors-tdp-spawn-fail-silent) is the most dangerous - pool silently degrades to fewer workers and caller hits the fallback path with no telemetry.
- **Fix:** Introduce a single `onError(scope: string, err: unknown)` hook on the pool, default = `console.warn`. Replace all 4 silent catches with `catch (e) { this.opts.onError?.('spawn-failed', e); }` etc. Caller can wire to Sentry / structured logger. Pairs with L5-12.

### L5-7. Worker error wraps a string - root cause discarded
- **Category:** medium bug
- **Issue:** tiled-decode-pool.ts L91: `reject(new Error(ev.data.error))`. The worker likely had a real Error with stack + name; serializing to string strips both. Caller's catch sees only the message; no programmatic discrimination possible. L97 has similar pattern (`ev?.message || ev || 'unknown'`).
- **Fix:** Worker should post `{ok:false, error:{code, message, stack?}}` (cite L3-9). Receiver constructs `Error` from message, attaches `code` + `cause`: `const err = new Error(ev.data.error.message); (err as any).code = ev.data.error.code; reject(err);`. Modern JS Error supports `cause` option: `new Error(msg, { cause: { code } })`.

### L5-8. `decodeTilesParallel` keeps only firstErr - others lost
- **Category:** low bug
- **Issue:** tiled-decode-pool.ts L335-355: `let firstErr: unknown = null;` records only the first failure. Other workers see `failed` flag and exit their slice without their errors propagating. If two workers fail near-simultaneously (e.g., cascading OOM), only one is reported.
- **Fix:** Aggregate via `AggregateError`: collect errors per-coroutine into `const errors: Error[] = []`. On Promise.all completion, if errors.length > 0 throw `new AggregateError(errors, 'tile decode failed')`. Match Node + modern browser API. Caller can inspect `.errors`.

### L5-9. `release()` in `finally` masks decode error
- **Category:** low bug
- **Issue:** tiled-decode-pool.ts L420-425: `try { ... await decodeTilesParallel(...); return stitch(...); } finally { p.release(liveWorkers); }`. If release() throws (synchronous mutation on this.idle/this.active - normally cannot, but could after future destroyed mutation), the thrown release error replaces the in-flight decode error. Cite errors-tdp-finally-release-mask-error.
- **Fix:** Wrap release in try/catch and surface via onError hook (L5-6): `} finally { try { p.release(liveWorkers); } catch (e) { p.opts.onError?.('release-failed', e); } }`. Decode error propagates cleanly.

### L5-10. Generic Error everywhere - no taxonomy
- **Category:** info opportunity (cross-file)
- **Issue:** Across all three files, every throw is `new Error(string)`. Callers cannot distinguish 'budget exceeded' from 'malformed bytes' from 'pool destroyed' from 'AbortError'. UI cannot decide retry vs surface vs ignore. Cite errors-opp-no-error-taxonomy.
- **Fix:** Introduce a tiny `errors.ts` with `class PyramidError extends Error { constructor(code: PyramidErrorCode, msg: string, cause?: unknown) { ... } }` + `type PyramidErrorCode = 'EMPTY_REGION'|'BAD_REGION'|'NO_FINAL_FRAME'|'WORKER_FAILED'|'POOL_DESTROYED'|'ABORTED'`. Replace all `new Error(...)` with `new PyramidError(code, msg)`. Caller switches on `err instanceof PyramidError && err.code === ...`.

### L5-11. Zero logging - pool degradation invisible
- **Category:** info opportunity
- **Issue:** tiled-decode-pool.ts has no `console.*` or logger anywhere. Spawn failure, factory rebind ignore, listener-attach failure, terminate failure all silent. In a customer report `pyramid feels slow' there is no trace evidence to triage. Cite errors-opp-no-structured-logging.
- **Fix:** Inject a logger interface at pool construction: `opts.logger?: { warn(msg, ctx), info(msg, ctx) }`. Default = no-op (no console noise). Wire to events: spawn-failed, recycled, prewarm-completed, fallback-to-single. Production wires to structured logger; tests assert on calls.

### L5-12. No retry on transient worker failures
- **Category:** info opportunity
- **Issue:** First tile failure aborts the whole viewport decode (L5-8). Some failures (transient WASM heap fragmentation, momentary OOM at large tile) succeed on retry with a fresh worker. Cite errors-opp-no-retry-utility.
- **Fix:** After L5-7 error taxonomy: `decodeTilesParallel` could re-queue tiles whose error code is `RETRYABLE` (OOM, INTERNAL) onto a fresh worker, up to N attempts per tile. Stop on `BAD_REGION` or `JXTC_PARSE` (caller-cause errors don't retry). Caller opt-in via `opts.retryPolicy?: {maxAttempts}`. Conservative default = no retry.

### L5-13. Asymmetric region contract in `decodeLevel`
- **Category:** low bug
- **Issue:** decode-level.ts L130-137: `kind='whole'` + region -> throw `'region decode requires a tiled level source'`. `kind='tiled'` + no region -> silently defaults to `{x:0, y:0, w:source.width, h:source.height}`. The two kinds have opposite tolerances for the same argument absence/presence. Cite contracts-013.
- **Fix:** Symmetrize: `kind='whole'` + region -> ignore region (default to full image, log via L5-11 logger) OR throw both directions. Picking one: if region is undefined OR full-image, accept; if a strict sub-region with kind=whole, throw. Document in JSDoc.


---

# Lens 6 - Memory + GC pressure

Scope: large allocations on hot path, persistent retention (pool handles, workers, WASM heap), structured-clone amplification across worker boundary, and detached-buffer semantics. CLAUDE.md rule respected: transferred output buffers cannot be pooled - only caller-owned (untransferred) buffers can.

### L6-1. Stitch output buffer = `viewport.w * viewport.h * bpp` per ROI
- **Category:** perf + efficiency
- **Issue:** decode-level.ts L65 and tiled-decode-pool.ts L41: a fresh Uint8Array is allocated per stitch. For a 2048x1024 viewport at rgba8 that is 8 MB; rgba16 is 16 MB. At 30 fps pan, that is ~240 MB/s churn of large buffers, putting heavy pressure on the GC's old-generation promotion.
- **Fix:** Caller-owned buffer (cite L2-11). decodeTiledViewport(Pooled) gains optional `outBuffer?: Uint8Array` arg sized to the largest viewport the caller intends to use. Caller maintains a single buffer per gallery, recycles across pan/zoom. Safe because the buffer is NOT transferred to a Worker (CLAUDE.md rejection applies only to transferred pools).

### L6-2. Worker-side memory spike from N-cloned container bytes
- **Category:** perf
- **Issue:** Per-tile `postMessage({bytes, region})` (L122) structured-clones the full JXTC container into the receiving worker's heap. For 4 workers x 16 tiles = up to 64 clones held simultaneously across worker heaps (each tile completes asynchronously). At 64 MB container that is up to 256 MB peak across worker process memory before tiles drain. Browser memory pressure events trigger before this happens, but pan latency spikes.
- **Fix:** L3-4 load/decode split eliminates this entirely - each worker receives the container ONCE and reuses across all its tiles. Memory becomes (workers x container) = 4 x 64 MB = 256 MB STEADY-STATE (vs same peak but spike). Better characteristic; bounded. Combined with worker LRU cap of 1 hot bytesId, can drop to 4 x 64 MB across pan. Worker can also cache only a region-of-interest slice when crop is small.

### L6-3. `parts[]` retains decoded tile pixels until stitch
- **Category:** perf
- **Issue:** tiled-decode-pool.ts L333 + L347: each `{region, decoded}` entry holds a per-tile Uint8Array (tile_w x tile_h x bpp bytes). Held in main-thread memory until decodeTilesParallel returns and stitch consumes. Peak = (viewport pixels) + (sum of tile pixels) = ~2x viewport memory.
- **Fix:** Stream-stitch: pass a `stitchSink(tile, region)` callback into decodeTilesParallel. As each tile resolves, write into outBuffer at the right offset and immediately drop the tile reference (`results[idx] = null` or skip storing entirely). Eliminates parts[] retention. Peak drops to (viewport pixels) + (1 tile at a time per worker) = viewport + few-MB.

### L6-4. `worker.terminate()` is async - spawn/destroy churn under pan can spike RSS
- **Category:** perf
- **Issue:** destroyHandle (L296) calls terminate(); the worker process/thread is reclaimed by the browser at an indeterminate time. Each worker carries ~10 MB WASM heap. Under pan-churn that triggers minIdle-floor violations + spawn-replacements (L4-8), resident memory can compound for hundreds of ms before terminated workers' memory is freed.
- **Fix:** Conservative: lengthen idleTimeoutMs from 5s to 30s so under bursty pan the floor is more stable. Aggressive: replace terminate with reuse - keep a 'cooldown' pool of bad-but-not-yet-discarded workers; reset their internal state via a `{type:'reset'}` message. Skip if reset is unreliable - JXL WASM state machine is not trivially resettable.

### L6-5. `new Uint8Array(typed)` is the copy constructor - silent memcpy per tile
- **Category:** perf bug
- **Issue:** L86: receiver does `new Uint8Array(ev.data.pixels)` where `ev.data.pixels` is a Uint8Array view (the worker posted the VIEW, transferred the BUFFER). Per ECMA spec, `new Uint8Array(typedArray)` allocates a new buffer and copies. ~1 MB extra per tile. The L80-83 comment explicitly claims zero-copy. Cite logic-004 / L3-3.
- **Fix:** Already covered in L3-3: widen WorkerReply.pixels to `Uint8Array | ArrayBuffer`; receive-side: `const px = ev.data.pixels instanceof Uint8Array ? ev.data.pixels : new Uint8Array(ev.data.pixels);`. Uint8Array passthrough is zero-copy (just structurally cloned bookkeeping).

### L6-6. `containerBytes` per-level retention is implicit
- **Category:** info opportunity
- **Issue:** Caller (pyramid-lightbox or similar) holds containerBytes for the active level. Multi-level prefetch can stack N levels' worth of containers in main heap. No coordination with the pool: pool does not know which containers are hot.
- **Fix:** Out of scope for this file cluster (lives in level-source.ts / caller). Note: combined with L3-4 bytesId protocol, the pool could expose a hint - `pool.notifyContainerHot(bytesId)` so workers' load-cache prioritizes. Architectural; ADR-worthy.

### L6-7. Sparse `new Array(N)` triggers V8 holey-array transitions
- **Category:** perf (engine-dependent)
- **Issue:** L333: `new Array(tiles.length)` creates a HOLEY array. Coroutines fill in arbitrary order (work-stealing) so the array stays holey throughout. V8 keeps holey arrays in a slower 'dictionary mode' representation for larger N. With tiles.length > 50 (mega-pano levels) this is observable.
- **Fix:** Cite L2-7. Use `Array.from({length: tiles.length}, () => null)` - PACKED initial state. Or, with the L6-3 stream-stitch fix, parts[] disappears entirely and this becomes moot.

### L6-8. Idle-timer closure retention is fine - confirm boundary
- **Category:** info
- **Issue:** L268: `setTimeout(() => {...}, idleTimeoutMs)` captures `h`. While timer is armed, h is reachable from the timer queue. On clearIdleTimer (called by acquire/destroyHandle/armIdleTimer itself), the timer is cancelled and the closure becomes unreachable. No leak. Confirm and move on.

### L6-9. `recycle` listener strongly couples handle <-> worker
- **Category:** info (intentional)
- **Issue:** L242-248: `recycle = () => this.recycle(h)` captures `h`. Worker holds `recycle` via addEventListener. h holds worker via h.worker. Bidirectional strong refs - but BOTH become unreachable simultaneously when destroyHandle removes h from all/idle/active sets AND terminates worker. No leak. Intentional. Worth a comment in the file so future-self does not 'fix' it.
- **Fix:** Annotate L234-249 with `// h <-> worker is a deliberate cycle, broken atomically by destroyHandle`. Defensive doc, no code change.

### L6-10. FEATURE: explicit pool memory budget
- **Category:** feature
- **Issue:** Pool sizes itself by hardwareConcurrency capped at 8 (L310). Independent of available RAM. On a 64-core machine with 4 GB RAM and 10 MB-per-worker WASM heap, 8 workers + idle ~80 MB; OK. But future tier-2 pool variants (denoise, color, etc.) compound. No mechanism for pool to throttle.
- **Fix:** Config: `opts.estimatedWorkerHeapBytes?: number`. Optional `opts.maxTotalHeapBytes?: number`. spawnOne checks budget before factory(). Falls back to single-thread WASM if over. Caller can wire to `navigator.deviceMemory` heuristic.

### L6-11. FEATURE: FinalizationRegistry for orphan in-flight detection
- **Category:** feature (low priority)
- **Issue:** If a caller's `decodeTiledViewportPooled(...)` Promise is dropped (await skipped, caller forgot, top-level throw), the in-flight decode finishes invisibly and the result is GC'd. Pool slot is held the whole time.
- **Fix:** Wrap returned Promise in a `FinalizationRegistry` that calls AbortController.abort() if the Promise's resolution box is GC'd. Niche - solves a usage error, not a library bug. Cost: one FR per call. Skip unless customer reports the antipattern.

### L6-12. FEATURE: explicit `containerBytes` reference release on AbortError
- **Category:** feature
- **Issue:** When a viewport decode is aborted (per L4-3), the in-flight `decodeTileWithWorker` Promises reject, but the `containerBytes` reference held inside the closure (worker.postMessage arg) is only released when each promise's closure is GC'd. Under high pan rate the abort path may have hundreds of zombie closures temporarily holding the buffer.
- **Fix:** On abort, explicitly null-out the captured `bytes` reference inside `decodeTileWithWorker` before reject. Setting closure-captured variable to null does drop the ref. Saves GC roundtrips during pan. Minor.


---

# Lens 6r - SharedArrayBuffer + browser-cooperation (second pass on memory/perf)

Premise: `canUseParallelTileWorkers()` already gates COOP/COEP (`crossOriginIsolated === true` per tiling.ts). That is the SAME gate SAB requires. The pool's parallel path runs ONLY when SAB is available. The L117-121 comment dismissing SAB as 'out of scope' is leaving the single largest perf win on the table. Browser-cooperation APIs (visibility, idle callback, scheduler) are likewise unused.

### L6r-1. SAB-backed container bytes - zero-copy fan-out to all workers
- **Category:** perf (large)
- **Issue:** Today: per-tile postMessage structured-clones full container into each worker's heap (cite L3-4, L6-2). After L3-4 fix: each worker receives the container once via structured clone. With SAB: container is allocated as SharedArrayBuffer once on main; workers receive a `Uint8Array` view over it on first acquire; ZERO copies ever. Single 64 MB container shared across 4 workers = 64 MB total (vs 64-256 MB with current/clone-once).
- **Fix:** 1) Caller allocates container as `new SharedArrayBuffer(jxtcSize)` and copies fetched bytes in once (one-time mandatory copy from non-shared fetch buffer). 2) Pool protocol gains `{type:'load', bytesId, sab: SharedArrayBuffer, byteLength}`. 3) Worker side: `const view = new Uint8Array(msg.sab, 0, msg.byteLength)`. libjxl WASM tile decoder reads from any Uint8Array; SAB-backed view works identically. 4) Fall back to regular ArrayBuffer when `canUseParallelTileWorkers()` returns false. The fallback path already exists for parallel = false.

### L6r-2. Pool prewarm at `requestIdleCallback` instead of synchronous
- **Category:** perf
- **Issue:** L171-179 prewarm() spawns workers synchronously inside `getOrCreatePool`. First call to `decodeTiledViewportPooled` blocks on N x `new Worker(url)` invocations. For minIdle=2 that is ~5-20 ms on cold cache - paid on the user's FIRST pan, the worst possible moment.
- **Fix:** Wrap spawn in `globalThis.requestIdleCallback?.(() => this.spawnOne())` with a setTimeout fallback. Caller-visible `prewarmAsync(): Promise<void>` resolves when workers have posted `{type:'ready'}` (cite L3-6). UI shell calls prewarmAsync on app mount, not on first viewport decode.

### L6r-3. Page visibility integration - drop idle workers when tab hidden
- **Category:** efficiency
- **Issue:** Singleton pool keeps minIdle=2 workers alive forever. When the gallery tab is backgrounded, those workers' WASM heaps (~10 MB each) remain resident for nothing - Chrome's background-tab throttling does not reclaim them.
- **Fix:** On pool construction: `document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.reapAllIdle(); else this.prewarm(this.minIdle); })`. `reapAllIdle()` is a one-shot that destroys every idle handle ignoring the minIdle floor. Returns workers + their WASM heaps to the browser. On visible: re-prewarm at idle. Net memory win in multi-tab usage; cost is 5-20 ms re-warm when user returns. Acceptable trade.

### L6r-4. `freeze`/`resume` Page Lifecycle events - abort + terminate in-flight on freeze
- **Category:** bug (mobile/PWA)
- **Issue:** Chrome/Edge fire `freeze` event when tab is going to bf-cache / mobile background. Worker execution may be paused indefinitely. Currently, an in-flight `decodeTileWithWorker` Promise on a frozen worker hangs forever; on resume the worker may continue, but the reply arrives long after viewport has moved. Pool has no awareness.
- **Fix:** Listen for `freeze` on document (Chrome ships, behind feature). On fire: AbortController.abort() any in-flight requests (per L4-3), terminate workers (full destroy), set `frozen = true`. On `resume`: prewarm fresh. Implementations of the freeze contract: store no permanent state in pool that can't be reconstructed.

### L6r-5. Adaptive `maxSize` based on `navigator.deviceMemory`
- **Category:** efficiency
- **Issue:** L309-310: `const hwc = rt.navigator?.hardwareConcurrency ?? 4; const maxSize = Math.min(hwc, 8);`. 8 workers x 10 MB WASM heap = 80 MB. On a 4 GB Chromebook with hwc=8 that is ~2% of device memory just for the pool; on an 8-core/64 GB workstation it is invisible. Workers are not free.
- **Fix:** If `navigator.deviceMemory` is available (Chrome, mostly): `const memHint = navigator.deviceMemory ?? 4; const maxSize = Math.min(hwc, 8, Math.max(2, Math.floor(memHint)))`. devicMemory is bucketed (0.25, 0.5, 1, 2, 4, 8) so this scales pool size by device class. Low end: 2 workers; high end: full 8.

### L6r-6. `scheduler.postTask` for tile-decode ordering (centroid-first)
- **Category:** perf
- **Issue:** `decodeTilesParallel` (L323-364) dispatches tiles in `tiles` array order = scan order. User attention is centered on the viewport's middle. Decoding center tiles first = perceived snap-in is faster even if total time identical.
- **Fix:** Caller reorders `tiles` by distance to viewport center before passing in. OR pool exposes `decodeOrder?: 'scan'|'centroid'` option that sorts internally. Bonus: `scheduler.postTask(fn, {priority:'user-visible'})` (Chrome native scheduler) for the coroutine bodies would let Chrome prioritize over background tasks.

### L6r-7. Worker `terminate()` ack via FinalizationRegistry
- **Category:** bug (low) + observability
- **Issue:** L296: `worker.terminate()` is fire-and-forget. Pool decrements `all.size` immediately; assumes worker is gone. Chrome may delay process kill; under spawn-storm the actual process count exceeds `maxSize` briefly. Hard to diagnose without explicit signal.
- **Fix:** On spawn: `const cleanup = (info) => this.opts.onWorkerGc?.(info); FINALIZATION_REGISTRY.register(worker, {handleId: h.id});`. Pool's onWorkerGc callback (default no-op) lets tests assert true reclaim. In production, attach to telemetry to detect 'workers terminated > workers GC'd' divergence (= memory leak warning).

### L6r-8. Document the SAB precondition path + reject non-isolated parallel
- **Category:** contract
- **Issue:** Today `canUseParallelTileWorkers()` returns true on both crossOriginIsolated AND structured-clone-only worlds. After L6r-1 SAB integration, the `parallel:true` codepath must FAIL CLOSED when SAB is unavailable - otherwise the worker waits for a SAB view it will not receive.
- **Fix:** Split the capability check: `canUseTileWorkers()` (basic Worker + COOP/COEP) and `canShareContainerBytes()` (SAB + crossOriginIsolated). Pool's `decodeTiledViewportPooled` consults both; falls back to single-WASM if SAB missing AND parallel was requested. Comment the precondition in `tiling.ts`.

### L6r-9. Refuse spawn when `navigator.userAgentData.mobile === true` and large minIdle
- **Category:** efficiency
- **Issue:** Mobile devices have stricter background-process budgets and aggressive worker throttling. Keeping 2 workers warm at 10 MB each is a much larger fraction of mobile RAM than desktop, and OS may kill the tab when backgrounded.
- **Fix:** Detect mobile via `navigator.userAgentData?.mobile` (standardized, Chrome/Edge). On mobile: cap minIdle = 0 (no permanent warm pool; spawn on demand). Acceptable cost is one cold-start per pan session. Pairs with L6r-3.

### L6r-10. OpenInputStream / ReadableStream input - drop bytes after dispatch
- **Category:** efficiency (architectural)
- **Issue:** Caller currently holds full `containerBytes` Uint8Array in main heap for the lifetime of the level. After L6r-1 SAB integration, the SAB is the canonical buffer and the original ArrayBuffer can be released. But if caller fetched via `await response.arrayBuffer()`, both buffers transiently coexist (~2x peak).
- **Fix:** Out of scope for the three files but architecturally: caller should `fetch().then(r => r.body)` (ReadableStream), allocate SAB sized via Content-Length header, and pipe stream into SAB without intermediate buffer. Document for the caller in ADR. (No code change here.)

### L6r-11. Cooperative back-off via `performance.measureUserAgentSpecificMemory()` heuristic
- **Category:** feature
- **Issue:** Pool has no signal that the host page is hitting heap pressure from OTHER consumers (e.g., huge gallery thumbnails, video). It will happily warm 8 workers regardless. `performance.measureUserAgentSpecificMemory()` (Chrome, behind CORS) gives a periodic snapshot.
- **Fix:** Pool config: `opts.memoryProbe?: () => Promise<{bytes:number, limit:number}>`. Called every prewarm decision. If `bytes/limit > 0.7`: drop minIdle to 0 and refuse new spawn. Caller wires the probe to whichever browser API is available; pool stays browser-agnostic.

