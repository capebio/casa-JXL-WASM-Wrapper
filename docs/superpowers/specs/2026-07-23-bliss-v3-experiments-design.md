# BLISS v3 Compression Experiments Design

Date: 2026-07-23

## Goal

Find a measured Pareto improvement in BLISS image compression or BLTV video
compression. At least three distinct ideas will be implemented and tested. A
result counts only when an interleaved flip-flop benchmark confirms it.

Lossy quality has no preselected acceptance threshold. The experiment will
produce rate-quality ladders and visual comparison sheets. Automated metrics
describe the trade; the user makes the final visual-quality decision.

## Starting Point

The baseline is BLISS commit `a38e304` on branch
`fable/bliss-v2-jul23`. Existing July measurements are historical context, not
acceptance evidence. Every result in this campaign will use a fresh same-run
baseline.

Relevant baseline modes are:

- lossless BLISS;
- uniform NEAR `n1`, `n2`, `n4`, and `n6`;
- context-adaptive NEAR `a2` and `a3`;
- BLTV v2 lossless GMC;
- BLTV v2 NEAR `n2` and `n4` GMC.

The existing lossless format, default presets, AVX2/v128 paths, and progressive
JPEG XL checkpoint behavior in `packages/jxl-wasm/src/bridge.cpp` remain
untouched unless a separately measured integration step later requires them.

## Experiment 1: Parametric rANS Codebooks

### Hypothesis

BLISS currently writes a 256-entry frequency table for each ordinary modeled
stream. This costs 512 bytes before rANS payload bytes. The cost is modest for
a large still, but material across many bands and every BLTV P-frame. Natural
prediction residuals are close to zero-centred, heavy-tailed distributions.
A tiny deterministic codebook can represent common distributions more cheaply
and can cache encoder/decoder lookup structures.

### Design

Add an experimental stream mode containing a one-byte codebook identifier
instead of 256 serialized frequencies. The codebook bank contains normalized
4096-count tables from a small grid of zero mass and tail-decay values. Every
symbol retains nonzero frequency. Lossless wrapped residual symbols use
`min(symbol, 256-symbol)` as signed magnitude; NEAR zigzag symbols use their
ordinary magnitude order.

The encoder already has a histogram for each stream. It computes cross-entropy
for each codebook and compares the best codebook estimate with the ordinary
explicit-table estimate. A conservative margin prevents borderline choices.
Explicit tables remain the fallback. The first implementation records both
estimated and actual stream sizes so selection error is visible.

Tables, packed decode LUTs, and SIMD encoder tables are initialized once per
codebook and reused. This can save both wire bytes and repeated setup work.

Codebook streams use a versioned experimental BLSR representation. Existing v1
and v2 streams remain decodable and byte semantics stay unchanged. The default
encoder keeps emitting v2 until the experiment wins and format promotion is
approved.

### Expected Outcomes

- Smaller BLTV P-frames where table overhead is a large fraction of payload.
- Smaller small-image and high-delta NEAR streams.
- Possible decode/setup speed gain from cached tables.
- Little or no gain on large high-entropy still streams; explicit fallback
  handles that case.

## Experiment 2: Motion-Copy Atlas for BLTV

### Hypothesis

After global motion compensation, BLTV still encodes a full-frame delta even
when most predicted pixels are exact. Entropy coding zeros is cheap in bits but
not free in tables, memory traffic, prediction, or rANS work. Encoding only the
changed regions should improve both density and throughput on pans, static
backgrounds, and overlays.

### Design

Add an experimental BLTV v3 P-frame mode:

1. Build the existing global-motion prediction.
2. Divide the frame into fixed tiles. Probe 8x8, 16x16, and 32x16 shapes.
3. Mark a tile changed when any channel differs in lossless mode. In lossy mode,
   mark it changed only when copying the prediction would violate the selected
   per-channel tolerance.
4. Copy unchanged tiles directly from the motion-compensated reference.
5. Pack changed-tile residuals into a raster-ordered atlas and encode only that
   atlas with BLISS lossless or NEAR.
6. Store tile shape, changed-tile bitset, atlas dimensions, and payload in the
   P-frame.
7. Decoder recreates the prediction, decodes the atlas, and scatters changed
   tiles into the output.

Partial edge tiles use explicit dimensions; padding never affects reconstructed
pixels. Lossless reconstruction must be byte-exact. Lossy copied tiles are
already within tolerance; changed tiles use the existing closed-loop
reconstruction and bound-patch mechanism.

A conservative changed-area gate selects atlas mode only for sparse frames.
Frames with broad motion, texture change, or scene cuts use the existing full
delta or I-frame path. Benchmark telemetry records changed-tile fraction,
bitset bytes, atlas bytes, and fallback decisions.

### Expected Outcomes

- Large compression and encode/decode work reduction on integer pans and
  partially static frames.
- No format-level losslessness compromise.
- Neutral fallback on globally changing frames.
- Honest limitation: the existing Gobabeb video corpus favors global motion.
  A deterministic local-motion/zoom stress corpus will test fallback behavior;
  no universal handheld-video claim will be made without real footage.

## Experiment 3: Edge-Aware Chroma Islands

### Hypothesis

At display quality, full-resolution photographic chroma carries more spatial
detail than viewers usually need, while BLISS currently preserves it almost as
strictly as luma. Locally flattening chroma where luma does not signal an edge
should reduce residual entropy at tiny compute cost. Keeping edge blocks at
full chroma resolution should avoid obvious colour bleeding.

### Design

Add an encoder-side perceptual prefilter before NEAR:

1. Convert each pixel conceptually to `G`, `Cr = R-G`, and `Cb = B-G` using
   signed arithmetic.
2. Process 2x2 cells. Measure green-channel edge activity and chroma spread.
3. When both values are below preset limits, replace each chroma component in
   the cell with its rounded cell mean. Green remains unchanged.
4. When either limit is exceeded, preserve the original chroma samples.
5. Reconstruct clamped RGB and pass it to existing uniform or adaptive NEAR.

The encoded stream remains an ordinary BLISS stream. Decode requires no new
filter, format, or compute. Presets form a ladder from conservative to
aggressive by changing green-edge and chroma-spread limits. Automated scoring
compares each point with the nearest baseline point in Butteraugli and SSIM,
not merely with the same NEAR delta.

Visual sheets include saturated flowers, fine foliage, flat gradients, noisy
regions, 4x crops, and amplified difference views. The prefilter cannot be
described as bounded near-lossless; max error is reported rather than promised.

### Expected Outcomes

- Meaningful size reduction at similar perceptual scores.
- No decode-speed regression because filtering is encoder-only.
- Small encode cost from one linear pass.
- Possible colour bleeding or false-colour loss; metrics and visual sheets make
  that failure explicit.

## Benchmark and Flip-Flop Protocol

Native Rust functions use an in-process harness derived from `abflip`, following
the repository flipflop discipline:

- load inputs once, outside timed regions;
- interleave variants for every file and rotate starting order each round;
- treat round zero as warmup and exclude it from warm medians;
- run at least eight measured rounds;
- measure encode and decode separately;
- report median, standard deviation, coefficient of variation, geometric-mean
  throughput, bytes, bpp, and peak working allocation where practical;
- mark timing evidence low-trust when warm-run coefficient of variation exceeds
  10%, then rerun after cooling;
- never run competing performance benchmarks concurrently.

Fresh comparisons use:

- ten Gobabeb 20.5 MP RGB8 stills;
- existing synthetic/fractal anchors;
- existing Gobabeb 720p, 1080p, and 4K pan/cut video corpora;
- a deterministic BLTV stress corpus with local motion, zoom, static overlays,
  noise change, and scene cuts.

Quality computation and visual artifact generation run outside timed regions.
Lossless rows decode and compare every byte. Lossy rows report Butteraugli,
SSIM, PSNR, exact maximum channel error, and rate. BLTV lossless verification
covers every frame, not a sample.

## Decision Rules

Each experiment receives one of three outcomes: adopt, retain as an optional
trade-off, or reject with evidence.

- Performance claim: stable flip-flop result of at least 5% on the named
  workload, with high-trust variance.
- Lossless compression claim: smaller bytes with exact reconstruction and no
  material throughput regression, or a clearly documented size/speed trade.
- Lossy compression claim: a clear rate-quality Pareto point, normally at least
  10% fewer bytes than the nearest baseline quality point or at least 10%
  faster at comparable size and quality.
- No aggregate headline may hide a severe per-file regression. Per-file rows
  remain available.
- Any candidate failing its intended axis is reverted from production defaults;
  its mechanism and measurements remain in the experiment report.

## Testing

Before benchmarking:

- run `cargo test -p bliss-core`;
- run `cargo test -p bltv`;
- add format parsing, malformed-input, old-stream compatibility, scalar/SIMD
  parity, lossless roundtrip, seek, and fallback tests for affected paths.

After each candidate, rerun the relevant unit tests and its dedicated
flip-flop. After all candidates, run the full workspace tests and a combined
baseline-versus-winners flip-flop to detect interactions.

## Outputs

The campaign produces:

- source and tests on an isolated BLISS experiment branch;
- append-only JSONL benchmark evidence with commit IDs and configuration;
- a concise Markdown findings report including negative results;
- visual comparison sheets for every retained lossy Pareto point;
- no default-format or application-wiring change without measured evidence and
  explicit approval.

## Implementation Order

1. Parametric rANS codebooks, because they exercise the shared image/video
   engine and have an explicit fallback.
2. Motion-copy atlas, because it has the largest expected BLTV gain.
3. Edge-aware chroma islands, because final acceptance is visually subjective.
4. Combined benchmark of independently retained winners.
