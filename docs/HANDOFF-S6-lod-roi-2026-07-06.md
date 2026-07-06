# HANDOFF — S6: LOD/ROI unification, 2026-07-06

Implements the SAFE, ADDITIVE subset of `docs/STRATEGIC-MAP-wave2-2026-07-06.md` §S6 on
branch `s6/wave2-overnight` (worktree `C:\Foo\rcw-s6`). K2 (encoder-emitted tier offsets)
has landed; this work adds the *addressing* layer on top of it without rewiring any
existing viewer.

## Goal

Three overlapping level-of-detail mechanisms exist, each with its own manifest shape and
decode path:

| Axis | Mechanism | Manifest | Byte addressing |
|---|---|---|---|
| Quality | progressive passes | `ProgressiveManifest.tiers[]` | cumulative prefix `[0, byteEnd)` of ONE codestream |
| Resolution | pyramid levels | `PyramidManifest.levels[]` | whole per-level blob, addressed by `contenthash` |
| Region (ROI) | JXTC tiles | JXTC container header + tile index | per-tile `[offset, offset+len)` inside the container |

S6 gives them **one request language** (`{level?, region?, quality?}`) and **one resolver**
that maps a request to concrete byte ranges per what the stored asset supports, plus a
Rust region entry point over the per-pixel RAW pipeline, plus the CASV-container-v2
scaffold (video's face of the same addressing story).

Hard rule for the whole item: **additive + back-compat.** v1 assets/manifests must still
parse and decode identically; existing viewers are untouched; the resolver sits *beside*
them.

## Landed (verified) vs Deferred

| # | Piece | State |
|---|---|---|
| 1 | Manifest schema v2 — progressive (per-tier pixel dims + capabilities, `version: 1\|2`) | **LANDED** |
| 1 | Manifest schema v2 — pyramid (per-level + asset `capabilities`, additive on schema 2) | **LANDED** |
| 2 | `lod-resolver` module: `{level?,region?,quality?}` → byte ranges across all three | **LANDED** |
| 3 | `process_region(rect, lod)` Rust entry over per-pixel pipeline + byte-exact test | **LANDED** |
| 4 | CASV container v2 (u64 offsets + I-frame seek table) — pure scaffold + version negotiation | **PARTIAL** (pure `casv_container` module + tests landed; encoder/decoder wiring DEFERRED — needs libjxl) |
| — | WASM `#[wasm_bindgen]` surface for `process_region` | **DEFERRED** (kept out of the large `src/lib.rs`; verified core lives in raw-pipeline) |

## Schema v2 shape (additive)

### Progressive (`packages/jxl-progressive/src/progressive-manifest.ts`)

- `ProgressiveManifest.version` widened `1` → `1 | 2`. `validateManifest` accepts **1 or 2**,
  rejects other numbers (`> 2` = newer-than-reader, following the pyramid reader pattern).
  v1 manifests parse unchanged. `PROGRESSIVE_MANIFEST_VERSION = 2`.
- `ManifestTier` gains optional `pixelWidth?`, `pixelHeight?` — the **intrinsic resolution**
  this tier reconstructs (encoder-provided; e.g. a DC prefix ≈ ceil(w/8)). Absent on v1 →
  reader default-fills with the source dims via `tierPixelDims(manifest, tier)`.
- `ProgressiveManifest` gains optional `capabilities?: AssetCapabilities`
  (`{ quality?, resolution?, region? }`).
- All new fields are validated only when present, so a v1 manifest (no new fields) is a
  valid v2-reader input; a v2 manifest round-trips through `JSON.stringify` → `validateManifest`.

### Pyramid (`packages/jxl-pyramid/src/manifest.ts` + `manifest-validate.ts`)

Pyramid was already schema-2 with per-level `w`/`h` and a `tiling` capability, and its
reader already tolerates v1 (normalizes 1 → 2). S6 adds, additively (no schema bump):

- `LodCapabilities = { quality?, resolution?, region? }`.
- `PyramidLevel.capabilities?` and `PyramidManifest.capabilities?`, validated only when
  present. Manifests without them parse unchanged.

## Resolver contract (`packages/jxl-progressive/src/lod-resolver.ts`)

Pure, dependency-free (structural interfaces — it does **not** import the pyramid package),
so it runs under `node --test`. Adapters (`fromProgressiveManifest`, `fromPyramidLevels`,
`fromJxtcContainer`) build a `LodAsset` from the real manifest/container shapes, which are
structurally compatible.

```
resolveLod(asset: LodAsset, req: LodRequest): ByteSource
```

- `ByteRange = { start, end }` — `start` inclusive, `end` **exclusive** (matches the
  manifest's `byteEnd` convention; `toHttpRange` emits `bytes=start-(end-1)`).
- `ByteSource = { mechanism, source, ranges: ByteRange[], width?, height?, tiles? }`.
- Request axes and their target mechanism:
  - `region`  → **jxtc** tiles overlapping the rect → one range per tile from the tile index.
  - `level`   → **pyramid** smallest level whose long edge ≥ target (else largest) → `[0, bytes)`.
  - `quality` → **progressive** prefix: a tier name, or a 0..1 fraction of the tiers, or the
    literal `"full"` → `[0, tier.byteEnd)`.
- **Precedence** when several axes are set and several mechanisms exist:
  `region` (spatial is the most specific) > `level` > `quality`; if the requested axis has
  no matching mechanism the resolver falls through to the next set axis, and finally to a
  documented default (progressive full → pyramid largest → jxtc whole-grid). Throws
  `LodResolveError` only when the asset supports **no** mechanism at all.

Contract test `test/lod-resolver.test.ts` asserts request → exact byte ranges for each of
the three mechanisms individually, the composed/precedence cases, and the adapters.

## `process_region` (`crates/raw-pipeline/src/pipeline.rs`)

```
pub struct RegionRect { pub x: usize, pub y: usize, pub w: usize, pub h: usize }
pub struct RegionResult { pub width: usize, pub height: usize, pub rgb8: Vec<u8> }
pub fn process_region(rgb16, full_w, full_h, rect, lod, params) -> RegionResult
```

- Runs over the **per-pixel tone/color stage** (`process`/`process_into`) — which has no
  spatial neighborhood, so the output of any rect is byte-for-byte the crop of the
  full-frame `process` output. (The spatial unsharp `texture`/`clarity` stage is a separate
  pre-pass and, exactly as when calling `process` directly, is not included here; haloed
  ROI sharpening reuses `stream_band` and is future work — see Deferred.)
- `lod >= 1` integer subsampling stride: output dims = `ceil(rect.w / lod) × ceil(rect.h / lod)`.
- Test `process_region_full_frame_equals_process` (in-crate): a full-frame rect at `lod = 1`
  is **byte-identical** to `pipeline::process(full, params)`; plus a sub-rect crop-equality
  test and an lod=2 subsample test.

## CASV container v2 (`crates/raw-pipeline/src/casv_container.rs`)

New **pure** module (no `jxl-codec`/libjxl dependency), so it compiles + tests under
`--no-default-features`. Defines the v2 container format that lifts the v1 4-GiB / 256-MiB
caps and adds an I-frame seek table, with a version-negotiation reader that also parses v1.
Format + rationale documented in the module header and mirrored below. The *encoder/decoder
wiring* into `casa_video.rs` (which pulls libjxl) is intentionally DEFERRED — see the
DEFERRED file.

- v1 index entry: `[u32 offset][u32 len|flags]` (8 B) → 4-GiB file cap, 256-MiB/frame cap,
  top nibble = flags.
- **v2 index entry**: `[u64 offset][u32 len][u32 flags]` (16 B) → 2^64 offset space, full u32
  len, dedicated flags word (no nibble-stealing).
- **v2 seek table**: appended array of `[u32 frame_index][u64 byte_offset]` for every
  I-frame (keyframe) → O(log n) seek without scanning P-frame chains.
- Version negotiation: the reader dispatches on the container version field; v1 bytes parse
  bit-identically through the v1 path.

## Verification (as run, 2026-07-07)

Rust (from `crates/raw-pipeline`, MSVC default toolchain, no libjxl):

- `cargo test --no-default-features --lib region_tests` → **4 passed** (full-frame region
  == `process(full)` byte-identical; sub-rect == crop of full; lod=2 subsample; zero-area).
- `cargo test --no-default-features --lib casv_container` → **5 passed** (v1 back-compat
  parse; v2 write/read round-trip + seek table; offset-cap lift; malformed rejection;
  casv-format.json single-source pin).
- `cargo test --no-default-features --lib` (whole crate) → **215 passed, 0 failed, 12
  ignored** (ignored = real-file integration tests, files absent on this machine). No
  regressions.

TypeScript:

- `node --test` (progressive) on `manifest.test.js`, `manifest-v2.test.js`,
  `lod-resolver.test.js`, `offsets-tiers.test.js` → **52 passed, 0 failed**.
- `bun test` (pyramid) on `manifest-capabilities.test.js`, `manifest-validate.test.js`,
  `manifest.test.js` → **38 passed, 0 failed**.

Pre-existing env caveats (NOT caused by this work): in the fresh worktree, `@casabio/*`
workspace deps and some devDeps (`fast-check`) are unlinked, so `scheduler.test`/
`stream.test` (progressive) and `choose-level.test` (pyramid) fail on
`ERR_MODULE_NOT_FOUND` before any assertion. Every test that imports only local `./`
modules — i.e. all the S6-touched files — passes. `tsc -p tsconfig.test.json` still emits
JS despite a `TS2688 'node'` type-def resolution error (same as baseline).

## Deferred / remaining (see `docs/WAVE2-QUESTIONS-DEFERRED.md` §S6)

- CASV v2 encoder/decoder wiring in `casa_video.rs` (needs libjxl build; format + scaffold ready).
- WASM `#[wasm_bindgen]` `process_region` export in `src/lib.rs`.
- Haloed spatial ROI (texture/clarity) via a rect variant of `stream_band`.
- Promote v2 capability defaults into the ingest/encoder emitters so producers actually
  write the new fields (readers already tolerate their absence).
