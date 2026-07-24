# BLISS v3 Compression Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and flip-flop-test three independent BLISS/BLTV compression ideas: parametric rANS codebooks, motion-copy atlases, and edge-aware chroma islands.

**Architecture:** Keep every candidate opt-in and independently revertible. Codebooks extend modeled-stream serialization in `bliss-core`; motion atlases extend BLTV P-frames while reusing BLISS payloads; chroma islands remain an encoder-only prefilter feeding ordinary NEAR streams. Shared in-process benchmark helpers enforce rotated execution, excluded warmup, variance reporting, and exact/quality gates.

**Tech Stack:** Rust 2021, `bliss-core`, `bltv`, Rayon, AVX2/v128 rANS paths, raw-pipeline perceptual scorer, JSONL evidence, PNG/HTML visual artifacts.

## Global Constraints

- Baseline commit: BLISS `a38e304` from `fable/bliss-v2-jul23`; every claim uses a fresh same-run baseline.
- Implement all work in an isolated worktree created with `superpowers:using-git-worktrees` at execution time.
- Run shell commands through `rtk`; use `rtk proxy` when raw output matters.
- Keep BLSR v1/v2 and BLTV v1/v2 decode compatibility.
- Keep all new format modes opt-in until measured and explicitly approved.
- Lossless image and video verification compares every decoded byte.
- Lossy evidence reports Butteraugli, SSIM, PSNR, exact maximum channel error, bytes, encode time, and decode time.
- Native flip-flops use round rotation, round-zero warmup exclusion, at least eight measured rounds, and no concurrent benchmark process.
- Performance claims require at least 5% improvement and warm-run coefficient of variation below 10%.
- Lossy compression claims require a clear rate-quality Pareto point, normally at least 10% fewer bytes than the nearest baseline-quality point.
- Do not touch `packages/jxl-wasm/src/bridge.cpp` or alter progressive decode checkpoints.
- Preserve unrelated changes in `C:\Foo\raw-converter-wasm` and `C:\Foo\bliss`.

## File Map

- Create `bliss-bench/src/lib.rs`: rotated-index and warm-statistics helpers shared by native benchmark binaries.
- Create `bliss-core/src/codebook.rs`: deterministic parametric rANS tables and conservative selector.
- Create `bliss-core/src/perceptual.rs`: edge-aware chroma-island prefilter.
- Create `bltv/src/atlas.rs`: tile-map, atlas packing, and atlas scatter primitives.
- Create `bliss-bench/src/bin/v3still.rs`: fresh still-image A/B and quality ladder.
- Create `bliss-bench/src/bin/v3video.rs`: fresh BLTV A/B with frame-form telemetry.
- Create `bliss-bench/src/bin/v3visual.rs`: PNG crops and HTML visual index.
- Modify `bliss-core/src/{lib.rs,band.rs,band_near.rs,rans_avx2.rs,rans_wasm.rs}`: opt-in codebook wire mode and public chroma-island encode API.
- Modify `bltv/src/{lib.rs,container.rs,encode.rs,decode.rs}` and `bltv/tests/roundtrip.rs`: BLTV v3 atlas form, lossless/lossy reconstruction, seeking, corruption checks, fallback.
- Modify `bliss-bench/Cargo.toml`: register three campaign binaries.
- Create `docs/v3-*.jsonl` and `FableBlissV3Findings.md`: raw evidence and conclusions.

---

### Task 1: Isolate Work and Prove Baseline Health

**Files:**
- Read: `Cargo.toml`
- Read: `bliss-core/src/lib.rs`
- Read: `bltv/tests/roundtrip.rs`

**Interfaces:**
- Consumes: clean BLISS commit `a38e304`.
- Produces: isolated `codex/bliss-v3-experiments` worktree with green baseline tests.

- [ ] **Step 1: Create isolated worktree through required skill**

Use `superpowers:using-git-worktrees`. Target path:

```text
C:\Foo\raw-converter-wasm\.worktrees\bliss-v3-experiments
```

Branch:

```text
codex/bliss-v3-experiments
```

- [ ] **Step 2: Verify exact starting revision and cleanliness**

Run:

```powershell
rtk proxy git rev-parse --short HEAD
rtk proxy git status --short
```

Expected: revision `a38e304`; empty status.

- [ ] **Step 3: Run baseline tests before edits**

Run:

```powershell
rtk proxy cargo test -p bliss-core
rtk proxy cargo test -p bltv
```

Expected: both commands exit 0; all existing roundtrip, NEAR-bound, patched-frame, skip, and seek tests pass.

---

### Task 2: Build Trustworthy Native Flip Statistics

**Files:**
- Create: `bliss-bench/src/lib.rs`
- Modify: `bliss-bench/src/bin/v2bench.rs`
- Modify: `bliss-bench/src/bin/vidbench.rs`

**Interfaces:**
- Produces: `rotated_indices(n: usize, round: usize) -> Vec<usize>`.
- Produces: `WarmStats::from_seconds(Vec<f64>) -> WarmStats` with `median_s`, `stdev_s`, `cv`, and `trust_high`.
- Consumes later: `v3still` and `v3video` benchmark binaries.

- [ ] **Step 1: Write failing statistics tests**

Create `bliss-bench/src/lib.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_covers_each_arm_once() {
        assert_eq!(rotated_indices(4, 0), vec![0, 1, 2, 3]);
        assert_eq!(rotated_indices(4, 1), vec![1, 2, 3, 0]);
        assert_eq!(rotated_indices(4, 5), vec![1, 2, 3, 0]);
    }

    #[test]
    fn warm_stats_exclude_first_sample() {
        let s = WarmStats::from_seconds(vec![9.0, 1.0, 1.1, 0.9, 1.0]);
        assert!((s.median_s - 1.0).abs() < 1e-12);
        assert!(s.cv < 0.10);
        assert!(s.trust_high);
    }
}
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
rtk proxy cargo test -p bliss-bench --lib
```

Expected: compile failure because `rotated_indices` and `WarmStats` do not exist.

- [ ] **Step 3: Implement exact helpers**

Add above the tests:

```rust
#[derive(Clone, Copy, Debug)]
pub struct WarmStats {
    pub median_s: f64,
    pub stdev_s: f64,
    pub cv: f64,
    pub trust_high: bool,
}

pub fn rotated_indices(n: usize, round: usize) -> Vec<usize> {
    (0..n).map(|i| (i + round) % n).collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    let m = v.len() / 2;
    if v.len() % 2 == 0 { (v[m - 1] + v[m]) * 0.5 } else { v[m] }
}

impl WarmStats {
    pub fn from_seconds(all: Vec<f64>) -> Self {
        assert!(all.len() >= 3, "warm statistics need warmup plus two samples");
        let warm = &all[1..];
        let median_s = median(warm.to_vec());
        let mean = warm.iter().sum::<f64>() / warm.len() as f64;
        let variance = warm.iter().map(|v| (v - mean).powi(2)).sum::<f64>()
            / (warm.len() - 1) as f64;
        let stdev_s = variance.sqrt();
        let cv = if median_s == 0.0 { f64::INFINITY } else { stdev_s / median_s };
        Self { median_s, stdev_s, cv, trust_high: cv < 0.10 }
    }
}
```

- [ ] **Step 4: Route existing benches through helpers**

In both benchmark loops, replace manual `(k + r) % nv` rotation with:

```rust
for vi in bliss_bench::rotated_indices(nv, r) {
    // existing variant body
}
```

Change default repetitions to nine: one warmup plus eight measured rounds. Replace median calls with `WarmStats::from_seconds`, emit `enc_cv`, `dec_cv`, and `trust_high`, and use `median_s` for throughput.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
rtk proxy cargo test -p bliss-bench --lib
rtk proxy cargo check -p bliss-bench --bins
```

Expected: tests pass; all benchmark binaries compile.

- [ ] **Step 6: Commit**

```powershell
rtk proxy git add bliss-bench/src/lib.rs bliss-bench/src/bin/v2bench.rs bliss-bench/src/bin/vidbench.rs
rtk proxy git commit -m "bench: harden BLISS native flip-flop statistics"
```

---

### Task 3: Deterministic Parametric rANS Codebook Bank

**Files:**
- Create: `bliss-core/src/codebook.rs`
- Modify: `bliss-core/src/lib.rs`

**Interfaces:**
- Produces: `CodebookKind::{Wrapped, Zigzag}`.
- Produces: `table(kind: CodebookKind, id: u8) -> Option<&'static Table>`.
- Produces: `choose(kind: CodebookKind, optimal: &Table, symbols: usize) -> Option<Choice>`.
- `Choice` contains `id: u8` and `estimated_saving_bytes: f64`.

- [ ] **Step 1: Write failing codebook tests**

Add to new module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_codebook_is_normalized_and_positive() {
        for kind in [CodebookKind::Wrapped, CodebookKind::Zigzag] {
            for id in 0..CODEBOOK_COUNT as u8 {
                let t = table(kind, id).unwrap();
                assert_eq!(t.freq.iter().map(|&v| v as u32).sum::<u32>(), PROB_SCALE);
                assert!(t.freq.iter().all(|&v| v > 0));
            }
        }
    }

    #[test]
    fn selector_accepts_laplace_and_rejects_uniform() {
        let skew: Vec<u8> = (0..10_000).map(|i| ((i * 17) % 13) as u8).collect();
        let oversized_mismatch: Vec<u8> =
            (0..100_000).map(|i| ((i * 17) % 13) as u8).collect();
        let uniform: Vec<u8> = (0..65_536).map(|i| i as u8).collect();
        assert!(choose(CodebookKind::Zigzag, &Table::build(&skew), skew.len()).is_some());
        assert!(choose(
            CodebookKind::Zigzag,
            &Table::build(&oversized_mismatch),
            oversized_mismatch.len(),
        ).is_none());
        assert!(choose(CodebookKind::Wrapped, &Table::build(&uniform), uniform.len()).is_none());
    }
}
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
rtk proxy cargo test -p bliss-core codebook
```

Expected: compile failure because module and interfaces do not exist.

- [ ] **Step 3: Implement deterministic integer-generated tables**

Implement `CODEBOOK_COUNT = 32`, zero multipliers `[2, 4, 8, 16]`, and Q15 tail ratios corresponding to decay grid `[0.015, 0.025, 0.04, 0.06, 0.09, 0.13, 0.20, 0.30]`. Build weights using integer recurrence, allocate one count to every symbol, distribute remaining `4096-256` counts proportionally, and assign remainder counts by descending fractional remainder then ascending symbol index.

Use this public shape:

```rust
use crate::rans::{Table, PROB_SCALE};
use std::sync::OnceLock;

pub const CODEBOOK_COUNT: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodebookKind { Wrapped, Zigzag }

#[derive(Clone, Copy, Debug)]
pub struct Choice {
    pub id: u8,
    pub estimated_saving_bytes: f64,
}

static WRAPPED: OnceLock<Vec<Table>> = OnceLock::new();
static ZIGZAG: OnceLock<Vec<Table>> = OnceLock::new();

pub fn table(kind: CodebookKind, id: u8) -> Option<&'static Table> {
    let bank = match kind {
        CodebookKind::Wrapped => WRAPPED.get_or_init(|| build_bank(kind)),
        CodebookKind::Zigzag => ZIGZAG.get_or_init(|| build_bank(kind)),
    };
    bank.get(id as usize)
}
```

`choose` computes ideal and candidate cross-entropy from `optimal.freq`, scales the entropy delta by `symbols`, and estimates bytes saved as the 511-byte table-to-id overhead reduction minus that coding penalty. It returns a codebook only when estimated saving is at least 64 bytes and at least 1% of estimated explicit-table stream size. Never ignore `symbols`: the 100,000-symbol mismatch must reject even though its 10,000-symbol counterpart wins.

- [ ] **Step 4: Export module and verify GREEN**

Add to `bliss-core/src/lib.rs`:

```rust
mod codebook;
```

Run:

```powershell
rtk proxy cargo test -p bliss-core codebook
```

Expected: both codebook tests pass.

- [ ] **Step 5: Commit**

```powershell
rtk proxy git add bliss-core/src/codebook.rs bliss-core/src/lib.rs
rtk proxy git commit -m "experiment(rans): deterministic parametric codebook bank"
```

---

### Task 4: Add Opt-In Codebook Wire Mode to Lossless and NEAR

**Files:**
- Modify: `bliss-core/src/lib.rs`
- Modify: `bliss-core/src/band.rs`
- Modify: `bliss-core/src/band_near.rs`
- Test: `bliss-core/src/lib.rs`

**Interfaces:**
- Adds `Opts::codebooks` at bit 6.
- Adds `encode_near_codebooks(rgb, w, h, bands, delta_y, delta_c)`.
- Adds stream mode 5 layout: `[5][symbol_count:u32][codebook_id:u8][word_count:u32][u16 words]`.
- BLSR version 3 is emitted only when codebooks are enabled; decode continues accepting v1/v2.

- [ ] **Step 1: Write failing roundtrip and compatibility tests**

Add to `lib.rs` tests:

```rust
#[test]
fn codebook_lossless_and_near_roundtrip() {
    let (w, h) = (256usize, 192usize);
    let img = synth_corr(w, h, 71);
    let opts = Opts { codebooks: true, ..Opts::default() };
    let ll = encode_opts(&img, w, h, 3, opts).unwrap();
    assert_eq!(ll[4], 3);
    assert_eq!(decode(&ll).unwrap().0, img);

    let near = encode_near_codebooks(&img, w, h, 3, 2, 2).unwrap();
    assert_eq!(near[4], 3);
    let back = decode(&near).unwrap().0;
    for (&a, &b) in back.iter().zip(&img) {
        assert!((a as i32 - b as i32).abs() <= 2);
    }
}

#[test]
fn codebook_bad_id_is_rejected() {
    let img = synth_corr(256, 192, 72);
    let mut blob = encode_near_codebooks(&img, 256, 192, 1, 2, 2).unwrap();
    let mode = blob.iter().position(|&b| b == 5).expect("mode-5 stream");
    blob[mode + 5] = 255;
    assert!(decode(&blob).is_err());
}
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
rtk proxy cargo test -p bliss-core codebook_lossless_and_near_roundtrip
```

Expected: compile failure because `Opts::codebooks` and `encode_near_codebooks` do not exist.

- [ ] **Step 3: Extend options and version parsing**

Add field and bit mapping:

```rust
pub codebooks: bool, // bit 6: parametric rANS codebook stream mode
```

Update `Default`, `to_bits`, and `from_bits` with bit `64`. Change `header_lanes` so versions 2 and 3 both accept lane counts 8 or 16. Existing encode APIs pass `codebooks=false`; opt-in paths emit header version 3.

- [ ] **Step 4: Encode and decode stream mode 5**

In both serialization loops, after `Table::build`, select the modeled table:

```rust
let optimal = Table::build(b);
let choice = codebooks.then(|| crate::codebook::choose(kind, &optimal, b.len())).flatten();
let model = choice
    .and_then(|c| crate::codebook::table(kind, c.id).map(|t| (c.id, t)))
    .map_or((None, &optimal), |(id, t)| (Some(id), t));
```

Encode rANS words once using `model.1`. Emit mode 5 plus `model.0` when selected; otherwise emit existing mode 2 or NEAR compact mode 4. Decode mode 5 by validating the ID, obtaining the deterministic table for the correct stream kind, applying existing renorm-safe padding, then using unchanged scalar/AVX2/v128 decode kernels.

- [ ] **Step 5: Verify all core modes**

Run:

```powershell
rtk proxy cargo test -p bliss-core
```

Expected: all old and new tests pass, including v1/v2 compatibility and SIMD parity.

- [ ] **Step 6: Commit**

```powershell
rtk proxy git add bliss-core/src/lib.rs bliss-core/src/band.rs bliss-core/src/band_near.rs
rtk proxy git commit -m "experiment(bliss): opt-in parametric rANS streams"
```

---

### Task 5: Flip-Flop Parametric Codebooks

**Files:**
- Create: `bliss-bench/src/bin/v3still.rs`
- Modify: `bliss-bench/Cargo.toml`
- Create: `docs/v3-codebooks.jsonl`

**Interfaces:**
- Consumes: baseline `ll`, `n2`, `n4` and matching codebook variants.
- Produces: per-file and aggregate JSONL with bpp, encode/decode MP/s, CV, trust, and exact/max-error verification.

- [ ] **Step 1: Register and implement benchmark binary**

Register `v3still` in `Cargo.toml`. Implement variant functions with this shape:

```rust
enum StillVariant { Ll, LlCodebook, N2, N2Codebook, N4, N4Codebook }

fn encode_variant(v: StillVariant, rgb: &[u8], w: usize, h: usize) -> Vec<u8> {
    let bands = bliss_core::default_bands(h);
    match v {
        StillVariant::Ll => bliss_core::encode(rgb, w, h, bands).unwrap(),
        StillVariant::LlCodebook => bliss_core::encode_opts(
            rgb, w, h, bands,
            bliss_core::Opts { codebooks: true, ..bliss_core::Opts::default() },
        ).unwrap(),
        StillVariant::N2 => bliss_core::encode_near(rgb, w, h, bands, 2, 2).unwrap(),
        StillVariant::N2Codebook => bliss_core::encode_near_codebooks(rgb, w, h, bands, 2, 2).unwrap(),
        StillVariant::N4 => bliss_core::encode_near(rgb, w, h, bands, 4, 4).unwrap(),
        StillVariant::N4Codebook => bliss_core::encode_near_codebooks(rgb, w, h, bands, 4, 4).unwrap(),
    }
}
```

Load Gobabeb files once, rotate six variants each round, run nine rounds, exclude round zero with `WarmStats`, verify bytes/bounds outside timed sections, and write `docs/v3-codebooks.jsonl` directly from the binary.

- [ ] **Step 2: Compile and run**

```powershell
rtk proxy cargo check -p bliss-bench --bin v3still
rtk proxy cargo run --release -p bliss-bench --bin v3still -- gobabeb10 --out docs/v3-codebooks.jsonl
```

Expected: exit 0; all lossless rows exact; NEAR max error at most 2/4; every timing row contains `trust_high`.

- [ ] **Step 3: Apply decision rule**

If codebooks win bytes without material throughput loss, retain mode. If no named workload improves, revert Tasks 3-4 code changes but retain benchmark evidence and summarize rejection mechanism in findings. Never enable codebooks by default in this task.

- [ ] **Step 4: Commit evidence and retained implementation**

```powershell
rtk proxy git add bliss-bench/Cargo.toml bliss-bench/src/bin/v3still.rs docs/v3-codebooks.jsonl
rtk proxy git commit -m "bench(bliss): flip-flop parametric rANS codebooks"
```

---

### Task 6: Motion-Atlas Geometry and BLTV v3 Container Contract

**Files:**
- Create: `bltv/src/atlas.rs`
- Modify: `bltv/src/lib.rs`
- Modify: `bltv/src/container.rs`
- Test: `bltv/src/atlas.rs`
- Test: `bltv/tests/roundtrip.rs`

**Interfaces:**
- Adds `VERSION_V3 = 3` and `FLAG_ATLAS = 4`.
- Produces `AtlasMap::build(cur, pred, w, h, tile_w, tile_h, tolerance)`.
- Produces `pack_delta(cur, pred, &AtlasMap, lossless) -> PackedAtlas`.
- BLTV v3 keeps 16-byte v2 index entries and existing footer fields.

- [ ] **Step 1: Write failing tile-map tests**

```rust
#[test]
fn map_marks_only_changed_tiles_and_honors_tolerance() {
    let (w, h) = (32usize, 16usize);
    let pred = vec![40u8; w * h * 3];
    let mut cur = pred.clone();
    cur[((5 * w + 20) * 3) + 1] = 43;
    let exact = AtlasMap::build(&cur, &pred, w, h, 16, 8, 0);
    assert_eq!(exact.changed_indices(), vec![3]);
    let tolerant = AtlasMap::build(&cur, &pred, w, h, 16, 8, 3);
    assert!(tolerant.changed_indices().is_empty());
}
```

- [ ] **Step 2: Verify RED**

```powershell
rtk proxy cargo test -p bltv atlas
```

Expected: compile failure because `AtlasMap` does not exist.

- [ ] **Step 3: Implement focused atlas module**

Use row-major bitset ordering. `AtlasMap` stores frame/tile geometry, bitset, and ordered changed indices. `pack_delta` selects square-ish atlas columns by increasing `cols` until `cols*cols >= changed_count`; padding pixels contain centred zero residual `128`. Real lossless atlas pixels use:

```rust
cur[src].wrapping_sub(pred[src]).wrapping_add(128)
```

Lossy atlas pixels use:

```rust
((cur[src] as i32 - pred[src] as i32).clamp(-127, 127) + 128) as u8
```

- [ ] **Step 4: Extend container version handling**

Add:

```rust
pub const VERSION_V3: u8 = 3;
pub const FLAG_ATLAS: u8 = 4;
```

`Footer::parse` accepts versions 1, 2, and 3. `entry_size()` returns v1 size only for version 1 and v2 size for versions 2/3. Reject atlas flag on versions below 3.

- [ ] **Step 5: Verify GREEN and old formats**

```powershell
rtk proxy cargo test -p bltv atlas
rtk proxy cargo test -p bltv
```

Expected: atlas unit tests and every existing v1/v2 test pass.

- [ ] **Step 6: Commit**

```powershell
rtk proxy git add bltv/src/atlas.rs bltv/src/lib.rs bltv/src/container.rs bltv/tests/roundtrip.rs
rtk proxy git commit -m "experiment(bltv): define v3 motion-atlas contract"
```

---

### Task 7: Lossless Motion-Atlas Encode, Decode, Seek, and Fallback

**Files:**
- Modify: `bltv/src/encode.rs`
- Modify: `bltv/src/decode.rs`
- Modify: `bltv/tests/roundtrip.rs`

**Interfaces:**
- Keeps public `EncoderOpts` unchanged so existing struct literals remain source-compatible.
- Adds `Encoder::with_atlas_tile(mut self, tile_w: u8, tile_h: u8) -> Self`; omitting the builder preserves current behavior.
- Atlas payload: `[tile_w:u8][tile_h:u8][atlas_cols:u16][changed_count:u32][bliss_len:u32][bitset][BLSR]`.
- Atlas selection gate: changed tile area must be at most 25% of frame area.

- [ ] **Step 1: Write failing lossless pan and fallback tests**

```rust
#[test]
fn v3_lossless_atlas_pan_is_exact_and_smaller() {
    let (w, h, n) = (160usize, 96usize, 12usize);
    let frames = pan_frames(w, h, n);
    let encode = |atlas_tile| {
        let opts = EncoderOpts {
            q_y: 1, q_c: 1, gop_len: 12, fps_num: 24, fps_den: 1,
            version: 3, gmc: true,
        };
        let mut e = Encoder::new(w, h, opts);
        if let Some((tile_w, tile_h)) = atlas_tile {
            e = e.with_atlas_tile(tile_w, tile_h);
        }
        for frame in &frames { e.push_frame(frame).unwrap(); }
        e.finish()
    };
    let atlas = encode(Some((16, 16)));
    let full = encode(None);
    assert!(atlas.len() < full.len());
    let mut d = Decoder::new(atlas).unwrap();
    for original in &frames {
        assert_eq!(d.decode_next().unwrap().unwrap(), *original);
    }
}

#[test]
fn v3_atlas_falls_back_when_every_tile_changes() {
    let (w, h) = (96usize, 64usize);
    let frames = vec![make_frame(w, h, 1), make_frame(w, h, 99)];
    let opts = EncoderOpts {
        q_y: 1, q_c: 1, gop_len: 30, fps_num: 24, fps_den: 1,
        version: 3, gmc: true,
    };
    let mut e = Encoder::new(w, h, opts).with_atlas_tile(16, 16);
    for frame in &frames { e.push_frame(frame).unwrap(); }
    let d = Decoder::new(e.finish()).unwrap();
    assert_eq!(d.index[1].flags & bltv::container::FLAG_ATLAS, 0);
}
```

- [ ] **Step 2: Verify RED**

```powershell
rtk proxy cargo test -p bltv v3_lossless_atlas
```

Expected: compile failure because `with_atlas_tile` and atlas encode/decode paths do not exist.

- [ ] **Step 3: Implement encoder selection and payload**

Add private `atlas_tile: Option<(u8, u8)>` state to `Encoder`, initialized to `None`, and the public `with_atlas_tile` builder. After GMC prediction and before full delta creation, build `AtlasMap` with tolerance zero when that state is enabled. When changed area is nonzero and at most 25%, pack the atlas, encode it through `bliss_core::encode`, serialize payload header/bitset/blob, and set `FLAG_ATLAS`. Empty maps keep existing whole-frame `FLAG_SKIP` behavior. Larger maps fall through to existing full delta.

- [ ] **Step 4: Implement decoder scatter**

For `FLAG_ATLAS`, first build the shifted prediction as today. Parse and bounds-check every header multiplication/addition. Decode BLSR atlas. Verify decoded atlas dimensions equal `atlas_cols*tile_w` by `ceil(changed_count/atlas_cols)*tile_h`. For each real changed-tile pixel apply:

```rust
out[dst] = out[dst].wrapping_add(atlas[src].wrapping_sub(128));
```

Ignore padding. Reject count/bitset/dimension mismatches with `Error::BadIndex`.

- [ ] **Step 5: Test roundtrip, fallback, and seek**

Add a seek assertion at frame 9 to the pan test. Run:

```powershell
rtk proxy cargo test -p bltv
```

Expected: all v1/v2/v3 tests pass byte-exactly.

- [ ] **Step 6: Commit**

```powershell
rtk proxy git add bltv/src/encode.rs bltv/src/decode.rs bltv/tests/roundtrip.rs
rtk proxy git commit -m "experiment(bltv): lossless motion-copy atlas"
```

---

### Task 8: Lossy Atlas Bounds and Patch Compatibility

**Files:**
- Modify: `bltv/src/atlas.rs`
- Modify: `bltv/src/encode.rs`
- Modify: `bltv/src/decode.rs`
- Modify: `bltv/tests/roundtrip.rs`

**Interfaces:**
- Atlas map tolerance is `min(q_y, q_c)` for copied tiles.
- Changed atlas tiles use existing NEAR closed-loop reconstruction.
- `FLAG_ATLAS | FLAG_PATCH` is legal; patch indices remain full-frame pixel indices.

- [ ] **Step 1: Write failing unconditional-bound test**

```rust
#[test]
fn v3_near_atlas_bound_is_unconditional() {
    let (w, h, n) = (160usize, 96usize, 10usize);
    let frames = pan_frames(w, h, n);
    let opts = EncoderOpts {
        q_y: 2, q_c: 2, gop_len: 10, fps_num: 24, fps_den: 1,
        version: 3, gmc: true,
    };
    let mut e = Encoder::new(w, h, opts).with_atlas_tile(16, 16);
    for frame in &frames { e.push_frame(frame).unwrap(); }
    let mut d = Decoder::new(e.finish()).unwrap();
    for original in &frames {
        let got = d.decode_next().unwrap().unwrap();
        for (&a, &b) in got.iter().zip(original) {
            assert!((a as i32 - b as i32).abs() <= 2);
        }
    }
}
```

- [ ] **Step 2: Verify RED**

```powershell
rtk proxy cargo test -p bltv v3_near_atlas_bound_is_unconditional
```

Expected: test fails or exceeds bound because lossy atlas reconstruction is absent.

- [ ] **Step 3: Implement closed-loop lossy atlas**

Encode packed clamped deltas using `bliss_core::encode_near_recon`. Scatter returned reconstructed atlas into a clone of the prediction. Scan final reconstruction against original exactly as current full-P code does. Serialize any violations using existing LEB128 full-frame gap indices and RGB triples; set both flags. Decoder applies atlas first, then patches.

- [ ] **Step 4: Verify bounds and legacy patched frames**

```powershell
rtk proxy cargo test -p bltv v3_near_atlas_bound_is_unconditional
rtk proxy cargo test -p bltv v2_near_bound_unconditional_high_range
rtk proxy cargo test -p bltv v2_seek_over_patched_frames
```

Expected: all pass; v2 framing remains unchanged.

- [ ] **Step 5: Commit**

```powershell
rtk proxy git add bltv/src/atlas.rs bltv/src/encode.rs bltv/src/decode.rs bltv/tests/roundtrip.rs
rtk proxy git commit -m "experiment(bltv): bounded NEAR motion atlases"
```

---

### Task 9: Flip-Flop BLTV Atlas Across Pan and Stress Corpora

**Files:**
- Create: `bliss-bench/src/bin/v3video.rs`
- Modify: `bliss-bench/Cargo.toml`
- Create: `docs/v3-video-atlas.jsonl`

**Interfaces:**
- Compares v2 full P-frame against v3 atlas tile shapes 8x8, 16x16, and 32x16.
- Reports I/P/skip/atlas/patched counts, changed-area fraction, bpp, FPS, CV, trust, and maximum error.

- [ ] **Step 1: Add deterministic stress corpus in memory**

`v3video` loads existing `.rgb` corpora and also creates 96-frame 1080p stress sequence from a Gobabeb still with: static overlay, two independently moving rectangles, gradual integer zoom crop, deterministic low-amplitude noise change, and shot cut. Keep generation outside timed regions.

- [ ] **Step 2: Implement rotated benchmark variants**

Use:

```rust
enum VideoVariant { V2Full, Atlas8, Atlas16, Atlas32x16 }
```

Each variant uses identical GOP and quality settings; only `version` and the `with_atlas_tile` builder differ. Run lossless plus n2 in separate sweeps. Nine rounds total; round zero excluded. Verify every lossless frame and every lossy byte bound outside timing.

- [ ] **Step 3: Run all resolutions without competing jobs**

```powershell
rtk proxy cargo run --release -p bliss-bench --bin v3video -- "C:\Foo\raw-converter\tests\Gobabeb 10\720p video" --out docs/v3-video-atlas.jsonl
rtk proxy cargo run --release -p bliss-bench --bin v3video -- "C:\Foo\raw-converter\tests\Gobabeb 10\1080p video" --append docs/v3-video-atlas.jsonl
rtk proxy cargo run --release -p bliss-bench --bin v3video -- "C:\Foo\raw-converter\tests\Gobabeb 10\4K video" --append docs/v3-video-atlas.jsonl
rtk proxy cargo run --release -p bliss-bench --bin v3video -- --stress-1080p --append docs/v3-video-atlas.jsonl
```

Expected: all verification gates pass; each result includes warm CV and trust.

- [ ] **Step 4: Apply decision rule and commit**

Retain best tile shape only if it improves named workload by decision rules and stress fallback remains neutral. Keep v2 default regardless.

```powershell
rtk proxy git add bliss-bench/Cargo.toml bliss-bench/src/bin/v3video.rs docs/v3-video-atlas.jsonl
rtk proxy git commit -m "bench(bltv): flip-flop motion-copy atlases"
```

---

### Task 10: Edge-Aware Chroma-Island Prefilter

**Files:**
- Create: `bliss-core/src/perceptual.rs`
- Modify: `bliss-core/src/lib.rs`

**Interfaces:**
- Produces `ChromaIslands { green_edge: u8, chroma_spread: u16 }`.
- Produces `filter_chroma_islands(rgb, w, h, opts) -> Result<Vec<u8>, Error>`.
- Produces `encode_near_chroma_islands(rgb, w, h, bands, dy, dc, opts)`.

- [ ] **Step 1: Write failing filter tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_cell_shares_chroma_but_preserves_green() {
        let rgb = vec![52, 50, 47, 54, 50, 45, 56, 50, 43, 58, 50, 41];
        let out = filter_chroma_islands(
            &rgb, 2, 2,
            ChromaIslands { green_edge: 4, chroma_spread: 16 },
        ).unwrap();
        assert_eq!([out[1], out[4], out[7], out[10]], [50; 4]);
        let cr: Vec<i32> = out.chunks_exact(3).map(|p| p[0] as i32 - p[1] as i32).collect();
        assert!(cr.windows(2).all(|w| w[0] == w[1]));
    }

    #[test]
    fn green_edge_preserves_original_cell() {
        let rgb = vec![20, 20, 20, 30, 30, 30, 200, 200, 200, 210, 210, 210];
        let out = filter_chroma_islands(
            &rgb, 2, 2,
            ChromaIslands { green_edge: 8, chroma_spread: 8 },
        ).unwrap();
        assert_eq!(out, rgb);
    }
}
```

- [ ] **Step 2: Verify RED**

```powershell
rtk proxy cargo test -p bliss-core perceptual
```

Expected: compile failure because prefilter interfaces do not exist.

- [ ] **Step 3: Implement one-pass 2x2 filter**

For each complete 2x2 cell, compute `min/max(G)`, signed `Cr=R-G`, and signed `Cb=B-G`. Filter only when green range is at most `green_edge` and both chroma ranges are at most `chroma_spread`. Replace Cr/Cb with signed rounded means; keep each original G; reconstruct R/B with clamp. Leave incomplete edge cells unchanged.

Use exact signed rounding:

```rust
fn div4_round(v: i32) -> i32 {
    if v >= 0 { (v + 2) / 4 } else { (v - 2) / 4 }
}
```

Validate `rgb.len() == w*h*3`, nonzero dimensions, and even BLISS width. Public encode wrapper filters then calls existing `encode_near`.

- [ ] **Step 4: Verify GREEN and NEAR decode compatibility**

Add a wrapper test asserting ordinary `decode()` works, green error remains within `dy`, and output length/dimensions match. Run:

```powershell
rtk proxy cargo test -p bliss-core perceptual
rtk proxy cargo test -p bliss-core roundtrip_near
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
rtk proxy git add bliss-core/src/perceptual.rs bliss-core/src/lib.rs
rtk proxy git commit -m "experiment(bliss): edge-aware chroma islands"
```

---

### Task 11: Chroma Rate-Quality Ladder and Visual Sheets

**Files:**
- Extend: `bliss-bench/src/bin/v3still.rs`
- Create: `bliss-bench/src/bin/v3visual.rs`
- Modify: `bliss-bench/Cargo.toml`
- Create: `docs/v3-chroma.jsonl`
- Create: `docs/v3-visual/index.html`

**Interfaces:**
- Sweeps green-edge `{4,8,16}` crossed with chroma-spread `{2,4,8}` at NEAR deltas 1, 2, and 4.
- Baselines: n1, n2, n4, a2, a3.
- Visuals: original, candidate, 4x crop, and 8x amplified absolute difference PNGs.

- [ ] **Step 1: Add candidate grid to still flip**

Represent candidate configuration as data, not 27 copied functions:

```rust
#[derive(Clone, Copy)]
struct ChromaVariant { edge: u8, spread: u16, delta: u8 }
```

For each delta, rotate its baseline and nine candidates within every file/round. Quality scoring runs once on final decoded images outside timed loops. Emit config fields separately in JSONL.

- [ ] **Step 2: Run rate-quality flip**

```powershell
rtk proxy cargo run --release -p bliss-bench --bin v3still -- gobabeb10 --chroma-grid --out docs/v3-chroma.jsonl
```

Expected: 27 candidate aggregates plus baselines; no lossless claim; metrics finite; trust recorded.

- [ ] **Step 3: Generate visual artifacts**

`v3visual` selects every automated Pareto candidate plus nearest baseline. Use `png::Encoder` with RGB8 output. Generate crops covering saturated flowers, fine foliage, flat gradients, and noisy backgrounds; HTML places original/baseline/candidate/difference side by side and labels bytes and metrics.

Run:

```powershell
rtk proxy cargo run --release -p bliss-bench --bin v3visual -- gobabeb10 docs/v3-chroma.jsonl docs/v3-visual
```

Expected: `docs/v3-visual/index.html` plus referenced PNG files; no missing images.

- [ ] **Step 4: Commit evidence and visual generator**

```powershell
rtk proxy git add bliss-bench/Cargo.toml bliss-bench/src/bin/v3still.rs bliss-bench/src/bin/v3visual.rs docs/v3-chroma.jsonl docs/v3-visual
rtk proxy git commit -m "bench(bliss): chroma-island rate-quality ladder and visuals"
```

---

### Task 12: Combined Verification, Findings, and Final Adoption Decisions

**Files:**
- Create: `FableBlissV3Findings.md`
- Modify only if retained: candidate source files from earlier tasks.

**Interfaces:**
- Consumes: `docs/v3-codebooks.jsonl`, `docs/v3-video-atlas.jsonl`, `docs/v3-chroma.jsonl`.
- Produces: final adopted/optional/rejected verdict for each experiment and combined winner benchmark.

- [ ] **Step 1: Run full correctness suite**

```powershell
rtk proxy cargo test --workspace
rtk proxy cargo check -p bliss-core --target wasm32-unknown-unknown
rtk proxy cargo check -p bltv --target wasm32-unknown-unknown
```

Expected: all commands exit 0.

- [ ] **Step 2: Run combined retained-winner flip-flops**

Run `v3still` and `v3video` with baseline plus retained candidates only, nine rounds, on every primary corpus. Do not combine two candidates unless each independently won; report interaction separately.

- [ ] **Step 3: Write findings without inflated claims**

`FableBlissV3Findings.md` must include:

- exact commits and commands;
- hardware and thread count;
- per-corpus bytes, bpp, encode/decode throughput, CV, and trust;
- quality metrics and links to visual sheets;
- exact roundtrip/error-bound verification;
- mechanism for each win or loss;
- pan-corpus limitation for BLTV;
- one verdict per experiment: adopted, optional trade-off, or rejected.

- [ ] **Step 4: Review diff and commit only campaign files**

```powershell
rtk proxy git diff --check
rtk proxy git status --short
rtk proxy git add FableBlissV3Findings.md
rtk proxy git commit -m "docs: report BLISS v3 compression campaign"
```

- [ ] **Step 5: Final verification evidence**

Re-run tests affected by any final cleanup and record their exact output in handoff. Never claim completion from earlier runs after source changed.

## Self-Review

- Spec coverage: all three approved experiments, fresh baselines, exact verification, lossy metrics, visual review, fallback behavior, stress corpus, and combined benchmark have explicit tasks.
- Type consistency: `Opts::codebooks`, `encode_near_codebooks`, `CodebookKind`, `AtlasMap`, `Encoder::with_atlas_tile`, `FLAG_ATLAS`, `ChromaIslands`, and `encode_near_chroma_islands` use one spelling and signature throughout.
- Compatibility: candidate formats are opt-in; v1/v2 decoders remain covered; BLTV v3 reuses v2 index width; default presets remain unchanged.
- Scope: each experiment ends in its own evidence commit and may be rejected without blocking later experiments.
- Placeholder scan: no deferred implementation markers or unspecified test commands remain.
