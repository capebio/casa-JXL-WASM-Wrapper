//! FableBraid — SIMD-rate lossless image/residual codec.
//!
//! Answer to the "Huffman challenge": lossless JXL decode spends ~93-100% of its
//! time in a serial per-pixel loop (one bit-position chains every prefix-coded
//! symbol; the predictor chains on the pixel to the left). FableBraid is a
//! bitstream designed so decode has *no* such chain:
//!
//!   * entropy — rANS (12-bit precision, 32-bit state, 16-bit renorm) *braided*
//!     across 8 independent lanes over one shared byte stream: 8 symbol decodes
//!     in flight per iteration, latency hidden by ILP (no SIMD gather needed —
//!     scalar-LUT lesson from the XYB pass applies here too);
//!   * prediction — mod-256 ring residuals (`cur − pred mod 256`), so
//!     reconstruction is one wrapping byte add over the whole row
//!     (auto-vectorizes to `vpaddb`), predictors are Zero / Top (row above) /
//!     External (same row of a caller-supplied plane, e.g. the previous video
//!     frame for temporal deltas);
//!   * per-row modes — COPY (residual all zero: row := prediction, ~free),
//!     RANS (entropy-coded), RAW (incompressible rows verbatim).
//!
//! Format (little-endian throughout):
//! ```text
//! image:  "FBR1" | u32 w | u32 h | u8 nplanes | u8 rct | nplanes × (u32 len | plane)
//! plane:  u8 predictor | u8 transform | h × u8 row-mode | u32 n_syms
//!         [n_syms>0: 256×u16 freqs | 8×u32 states | u32 rans_len | rans bytes]
//!         u32 raw_len | raw bytes
//! ```
//! transform 1 = left-delta on RANS-row residuals: the coded byte is
//! `res[x] − res[x−1] mod 256`. Combined with the Top predictor this makes the
//! coded symbol `cur − top − left + topleft mod 256` — the (unclamped) Gradient
//! residual — while reconstruction stays SIMD: a mod-256 prefix sum along the
//! row, then one wrapping add of the prediction row. The encoder picks the
//! cheaper of {none, left-delta} per plane by Shannon estimate.
//! rct 1 = subtract-green (R−=G, B−=G mod 256; plane order G, R', B').
//! The rANS byte segment includes 16 trailing pad bytes (branchless renorm may
//! overread; `rans_len` covers the pad). Decoder verifies every lane's final
//! state returns to the encoder's initial `RANS_L` — cheap whole-stream
//! integrity check, same spirit as libjxl's `CheckANSFinalState`.

const PREC: u32 = 12;
const TAB_SIZE: u32 = 1 << PREC; // 4096
const TAB_MASK: u32 = TAB_SIZE - 1;
const RANS_L: u32 = 1 << 16;
const LANES: usize = 8;
const RANS_PAD: usize = 16;
/// Rows whose estimated entropy cost exceeds this go RAW (bits per byte).
const RAW_THRESHOLD_BITS_PER_BYTE: f32 = 8.05;

const MODE_COPY: u8 = 0;
const MODE_RANS: u8 = 1;
const MODE_RAW: u8 = 2;

const PRED_ZERO: u8 = 0;
const PRED_TOP: u8 = 1;
const PRED_EXTERNAL: u8 = 2;

const TRANSFORM_NONE: u8 = 0;
const TRANSFORM_LEFT_DELTA: u8 = 1;

/// Prediction source for one plane.
#[derive(Clone, Copy)]
pub enum Predictor<'a> {
    /// Residuals are the samples themselves.
    Zero,
    /// Row above (row 0 predicts from zero).
    Top,
    /// Same row of an external plane (temporal delta); must be w×h bytes.
    External(&'a [u8]),
}

impl Predictor<'_> {
    fn id(&self) -> u8 {
        match self {
            Predictor::Zero => PRED_ZERO,
            Predictor::Top => PRED_TOP,
            Predictor::External(_) => PRED_EXTERNAL,
        }
    }
}

// ───────────────────────────── rANS core ─────────────────────────────

/// Normalize a byte histogram to frequencies summing to exactly `TAB_SIZE`,
/// every present symbol ≥ 1. With ≥ 2 present symbols every freq ≤ 4095, which
/// is what lets a decode-table entry pack freq into 12 bits. A single-symbol
/// histogram is rebalanced 4095/1 (the dummy slot range is never visited by a
/// stream that only encodes the real symbol).
fn normalize_freqs(hist: &[u64; 256]) -> Option<[u16; 256]> {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return None;
    }
    let mut freqs = [0u16; 256];
    // Single present symbol: 4095/1 split up front (the drift loop below has no
    // adjustable slot in that case — freq is capped at 4095 to keep table
    // entries 12-bit, and the dummy slot is never visited by a valid stream).
    if hist.iter().filter(|&&c| c > 0).count() == 1 {
        let s = hist.iter().position(|&c| c > 0).unwrap();
        freqs[s] = TAB_SIZE as u16 - 1;
        freqs[if s == 0 { 1 } else { 0 }] = 1;
        return Some(freqs);
    }
    let mut sum: i64 = 0;
    for i in 0..256 {
        if hist[i] > 0 {
            let f = ((hist[i] as u128 * TAB_SIZE as u128) / total as u128) as i64;
            let f = f.max(1).min(TAB_SIZE as i64 - 1);
            freqs[i] = f as u16;
            sum += f;
        }
    }
    // Redistribute drift against the largest buckets (they absorb rounding with
    // the least relative cost).
    while sum != TAB_SIZE as i64 {
        let step: i64 = if sum > TAB_SIZE as i64 { -1 } else { 1 };
        // index of the largest adjustable freq
        let mut best = usize::MAX;
        let mut best_f = 0u16;
        for i in 0..256 {
            let f = freqs[i];
            if f == 0 {
                continue;
            }
            if step < 0 && f <= 1 {
                continue; // keep present symbols ≥ 1
            }
            if step > 0 && f >= TAB_SIZE as u16 - 1 {
                continue;
            }
            if f >= best_f {
                best_f = f;
                best = i;
            }
        }
        if best == usize::MAX {
            return None; // cannot balance (can't happen with total>0)
        }
        freqs[best] = (freqs[best] as i64 + step) as u16;
        sum += step;
    }
    Some(freqs)
}

fn cum_table(freqs: &[u16; 256]) -> [u32; 257] {
    let mut cum = [0u32; 257];
    for i in 0..256 {
        cum[i + 1] = cum[i] + freqs[i] as u32;
    }
    cum
}

/// Encode `syms` (forward order, lane = index & 7) into a braided rANS stream.
/// Returns (states after encoding = decoder's initial states, byte stream with
/// `RANS_PAD` trailing pad).
fn rans_encode(syms: &[u8], freqs: &[u16; 256]) -> ([u32; LANES], Vec<u8>) {
    let cum = cum_table(freqs);
    let mut x = [RANS_L; LANES];
    // Emissions are produced in reverse decode order; push hi-then-lo and
    // reverse the buffer at the end so the decoder reads little-endian u16s
    // forward.
    let mut rev = Vec::with_capacity(syms.len() / 2 + 16);
    for i in (0..syms.len()).rev() {
        let lane = i & (LANES - 1);
        let s = syms[i] as usize;
        let f = freqs[s] as u32;
        debug_assert!(f > 0);
        let xl = &mut x[lane];
        if *xl >= (f << 20) {
            rev.push((*xl >> 8) as u8);
            rev.push(*xl as u8);
            *xl >>= 16;
        }
        *xl = ((*xl / f) << PREC) + (*xl % f) + cum[s];
    }
    rev.reverse();
    rev.extend_from_slice(&[0u8; RANS_PAD]);
    (x, rev)
}

/// slot → freq(12b) << 20 | offset-within-symbol(12b) << 8 | sym(8b)
///
/// Fills a caller-owned scratch (16 KiB) so per-plane decode allocates nothing.
/// Callers verify `sum(freqs) == TAB_SIZE` first, so the slot loop writes every
/// entry; the resize zero-fill runs once per scratch lifetime.
fn build_decode_table_into(freqs: &[u16; 256], tab: &mut Vec<u32>) {
    if tab.len() != TAB_SIZE as usize {
        tab.resize(TAB_SIZE as usize, 0);
    }
    let mut slot = 0usize;
    for s in 0..256u32 {
        let f = freqs[s as usize] as u32;
        for k in 0..f {
            tab[slot] = (f << 20) | (k << 8) | s;
            slot += 1;
        }
    }
    debug_assert_eq!(slot, TAB_SIZE as usize);
}

/// Braided rANS decoder over one shared stream. Bounds-safety without a branch:
/// reads clamp to the last valid u16 (the encoder's pad); a corrupt stream can
/// only produce garbage bytes, which the final-state check rejects.
struct RansDecoder<'a> {
    x: [u32; LANES],
    buf: &'a [u8],
    pos: usize,
    end2: usize, // last valid u16 offset
    tab: &'a [u32],
}

impl<'a> RansDecoder<'a> {
    fn new(states: [u32; LANES], buf: &'a [u8], tab: &'a [u32]) -> Option<Self> {
        if buf.len() < 2 {
            return None;
        }
        Some(RansDecoder { x: states, buf, pos: 0, end2: buf.len() - 2, tab })
    }

    /// Decode the *entire* symbol sequence into `out` in one run (must be
    /// called exactly once; braiding assumes symbol index 0 starts at lane 0).
    /// Eight state chains stay in registers; the only cross-lane dependency is
    /// the stream cursor (one add). The clamped read keeps a corrupt stream
    /// memory-safe; `finish()` rejects its garbage.
    fn decode_all(&mut self, out: &mut [u8]) {
        let tab = self.tab;
        let buf = self.buf;
        let end2 = self.end2;
        let mut pos = self.pos;
        let [mut x0, mut x1, mut x2, mut x3, mut x4, mut x5, mut x6, mut x7] = self.x;

        // A chunk of 8 lanes consumes at most 16 stream bytes, so inside the
        // fast region (`pos + 16 <= end2 + 2`) reads need no bounds clamp.
        macro_rules! step_fast {
            ($x:ident, $dst:expr) => {{
                // SAFETY: slot index is masked to TAB_SIZE; fast region
                // guarantees pos+1 < buf.len() for every renorm in this chunk.
                let e = unsafe { *tab.get_unchecked(($x & TAB_MASK) as usize) };
                let nx = (e >> 20) * ($x >> PREC) + ((e >> 8) & 0xFFF);
                $dst = e as u8;
                let w = unsafe {
                    u16::from_le_bytes([*buf.get_unchecked(pos), *buf.get_unchecked(pos + 1)])
                } as u32;
                let need = nx < RANS_L;
                // Branchless: renorm probability tracks symbol entropy (~1 in
                // 6-8 here) with an irregular pattern — a select beats a
                // mispredicting branch in the 8-deep chain mix.
                $x = core::hint::select_unpredictable(need, (nx << 16) | w, nx);
                pos += (need as usize) << 1;
            }};
        }
        macro_rules! step_safe {
            ($x:ident, $dst:expr) => {{
                // SAFETY: slot index masked; idx clamped to end2 = len-2.
                let e = unsafe { *tab.get_unchecked(($x & TAB_MASK) as usize) };
                let nx = (e >> 20) * ($x >> PREC) + ((e >> 8) & 0xFFF);
                $dst = e as u8;
                let idx = if pos <= end2 { pos } else { end2 };
                let w = unsafe {
                    u16::from_le_bytes([*buf.get_unchecked(idx), *buf.get_unchecked(idx + 1)])
                } as u32;
                let need = nx < RANS_L;
                $x = core::hint::select_unpredictable(need, (nx << 16) | w, nx);
                pos += (need as usize) << 1;
            }};
        }

        let mut chunks = out.chunks_exact_mut(LANES);
        for c in &mut chunks {
            if pos + 16 <= end2 + 2 {
                step_fast!(x0, c[0]);
                step_fast!(x1, c[1]);
                step_fast!(x2, c[2]);
                step_fast!(x3, c[3]);
                step_fast!(x4, c[4]);
                step_fast!(x5, c[5]);
                step_fast!(x6, c[6]);
                step_fast!(x7, c[7]);
            } else {
                step_safe!(x0, c[0]);
                step_safe!(x1, c[1]);
                step_safe!(x2, c[2]);
                step_safe!(x3, c[3]);
                step_safe!(x4, c[4]);
                step_safe!(x5, c[5]);
                step_safe!(x6, c[6]);
                step_safe!(x7, c[7]);
            }
        }
        let rem = chunks.into_remainder();
        let mut xs = [x0, x1, x2, x3, x4, x5, x6, x7];
        for (k, slot) in rem.iter_mut().enumerate() {
            let mut xv = xs[k];
            step_safe!(xv, *slot);
            xs[k] = xv;
        }
        self.x = xs;
        self.pos = pos;
    }

    /// Whole-stream integrity: every lane must return to the encoder's initial
    /// state and reads must not have run past the payload.
    fn finish(&self) -> bool {
        self.x.iter().all(|&x| x == RANS_L) && self.pos <= self.buf.len()
    }
}

// ───────────────────────────── plane codec ─────────────────────────────

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.p..self.p + n)?;
        self.p += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.p)?;
        self.p += 1;
        Some(v)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
}

#[inline]
fn residual_row(res: &mut [u8], cur: &[u8], pred: &[u8]) {
    for i in 0..res.len() {
        res[i] = cur[i].wrapping_sub(pred[i]);
    }
}

/// Shannon cost in bits of a histogram (encoder-side model selection only).
fn shannon_bits(hist: &[u64; 256]) -> f64 {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return 0.0;
    }
    let mut bits = 0.0f64;
    for &c in hist {
        if c > 0 {
            bits += c as f64 * (total as f64 / c as f64).log2();
        }
    }
    bits
}

/// Encode one w×h plane. `plane.len()` must be `w*h`.
fn encode_plane(plane: &[u8], w: usize, h: usize, pred: Predictor, out: &mut Vec<u8>) {
    assert_eq!(plane.len(), w * h, "plane size");
    if let Predictor::External(p) = pred {
        assert_eq!(p.len(), w * h, "external predictor size");
    }
    out.push(pred.id());

    let zero_row = vec![0u8; w];
    let mut residuals: Vec<u8> = Vec::with_capacity(w * h);
    let mut modes = vec![MODE_RANS; h];
    let mut hist = [0u64; 256]; // plain residuals
    let mut hist_ld = [0u64; 256]; // left-delta of residuals
    // Pass A: residuals + COPY detection + both candidate histograms.
    {
        let mut res = vec![0u8; w];
        for y in 0..h {
            let cur = &plane[y * w..(y + 1) * w];
            let pr: &[u8] = match pred {
                Predictor::Zero => &zero_row,
                Predictor::Top => {
                    if y == 0 {
                        &zero_row
                    } else {
                        &plane[(y - 1) * w..y * w]
                    }
                }
                Predictor::External(p) => &p[y * w..(y + 1) * w],
            };
            residual_row(&mut res, cur, pr);
            if res.iter().all(|&b| b == 0) {
                modes[y] = MODE_COPY;
            } else {
                let mut prev = 0u8;
                for &b in &res {
                    hist[b as usize] += 1;
                    hist_ld[b.wrapping_sub(prev) as usize] += 1;
                    prev = b;
                }
                residuals.extend_from_slice(&res);
            }
        }
    }

    // Model selection: left-delta wins when its entropy is clearly lower (the
    // margin guards against paying a prefix-sum decode pass for noise-level wins).
    let transform = if shannon_bits(&hist_ld) < shannon_bits(&hist) * 0.995 {
        TRANSFORM_LEFT_DELTA
    } else {
        TRANSFORM_NONE
    };
    out.push(transform);
    if transform == TRANSFORM_LEFT_DELTA {
        hist = hist_ld;
        // Rewrite stored residual rows in place as their left-delta.
        for row in residuals.chunks_exact_mut(w) {
            let mut prev = 0u8;
            for b in row.iter_mut() {
                let d = b.wrapping_sub(prev);
                prev = *b;
                *b = d;
            }
        }
    }

    let freqs = normalize_freqs(&hist);
    // Pass B: RAW demotion by estimated cost under the global table.
    let mut syms: Vec<u8> = Vec::with_capacity(residuals.len());
    let mut raw: Vec<u8> = Vec::new();
    if let Some(fr) = &freqs {
        let mut bits = [0f32; 256];
        for i in 0..256 {
            if fr[i] > 0 {
                bits[i] = (TAB_SIZE as f32 / fr[i] as f32).log2();
            }
        }
        let mut off = 0usize;
        for y in 0..h {
            if modes[y] != MODE_RANS {
                continue;
            }
            let row = &residuals[off..off + w];
            off += w;
            let cost: f32 = row.iter().map(|&b| bits[b as usize]).sum();
            if cost > RAW_THRESHOLD_BITS_PER_BYTE * w as f32 {
                modes[y] = MODE_RAW;
                raw.extend_from_slice(row);
            } else {
                syms.extend_from_slice(row);
            }
        }
    }

    out.extend_from_slice(&modes);
    put_u32(out, syms.len() as u32);
    if !syms.is_empty() {
        let fr = freqs.expect("non-empty syms implies a table");
        for f in fr {
            out.extend_from_slice(&f.to_le_bytes());
        }
        let (states, stream) = rans_encode(&syms, &fr);
        for s in states {
            put_u32(out, s);
        }
        put_u32(out, stream.len() as u32);
        out.extend_from_slice(&stream);
    }
    put_u32(out, raw.len() as u32);
    out.extend_from_slice(&raw);
}

/// Decode one plane into `out`; `ext` must be Some(w*h bytes) iff the plane
/// was encoded with `Predictor::External`. `tab_scratch`/`resbuf`/`out` are
/// caller-owned buffers (reused across planes/frames — no per-plane
/// allocation once warm).
fn decode_plane_into(
    r: &mut Reader,
    w: usize,
    h: usize,
    ext: Option<&[u8]>,
    tab_scratch: &mut Vec<u32>,
    resbuf: &mut Vec<u8>,
    out: &mut Vec<u8>,
) -> Option<()> {
    let pred_id = r.u8()?;
    let transform = r.u8()?;
    if transform > TRANSFORM_LEFT_DELTA {
        return None;
    }
    let modes = r.take(h)?;
    let n_syms = r.u32()? as usize;

    // Decode the whole braided symbol sequence up front (one aligned run —
    // lane K owns symbol indices ≡ K mod 8); rows then slice it.
    resbuf.clear();
    if n_syms > 0 {
        if n_syms > w * h {
            return None;
        }
        let ftab = r.take(512)?;
        let mut freqs = [0u16; 256];
        let mut sum = 0u32;
        for i in 0..256 {
            freqs[i] = u16::from_le_bytes([ftab[2 * i], ftab[2 * i + 1]]);
            sum += freqs[i] as u32;
        }
        if sum != TAB_SIZE {
            return None;
        }
        let mut states = [0u32; LANES];
        for s in states.iter_mut() {
            *s = r.u32()?;
        }
        let rans_len = r.u32()? as usize;
        let stream = r.take(rans_len)?;
        build_decode_table_into(&freqs, tab_scratch);
        let mut dec = RansDecoder::new(states, stream, tab_scratch)?;
        // No zero-fill: decode_all writes every byte of the slice before any
        // byte is read (the chunks_exact_mut loop covers len − len%8, the
        // remainder loop writes the rest; every step is a pure store to the
        // output). Initialization-order proof: between set_len and decode_all
        // there is no read and no panic path (decode_all indexes fixed-size
        // chunks and uses masked table lookups — no bounds panic, no unwind).
        // Miri view: fresh capacity stays untyped until the stores in
        // decode_all initialize each byte; reused capacity is already
        // initialized. u8 has no drop glue, so error-path drops never read.
        resbuf.reserve(n_syms);
        unsafe { resbuf.set_len(n_syms) };
        dec.decode_all(resbuf);
        if !dec.finish() {
            return None;
        }
    }
    let raw_len = r.u32()? as usize;
    let mut raw = Reader { b: r.take(raw_len)?, p: 0 };

    match pred_id {
        PRED_EXTERNAL => {
            ext?;
        }
        PRED_ZERO | PRED_TOP => {}
        _ => return None,
    }

    // No zero-fill: the row loop below writes row y in full (copy_from_slice
    // in every mode arm) before anything reads it; the Top predictor reads
    // only rows < y, each fully written by an earlier iteration; COPY/External
    // predictions read `zero_row`/`ext`, never `out`. Error paths return
    // None; the caller-owned Vec keeps stale bytes it never exposes (u8 has
    // no drop glue, dealloc never reads).
    out.clear();
    out.reserve(w * h);
    unsafe { out.set_len(w * h) };
    let plane = &mut out[..];
    let zero_row = vec![0u8; w];
    let mut decoded_syms = 0usize;
    for y in 0..h {
        // Split at the current row so the Top predictor can borrow row y-1
        // while writing row y.
        let (done, rest) = plane.split_at_mut(y * w);
        let row = &mut rest[..w];
        let pr: &[u8] = match pred_id {
            PRED_ZERO => &zero_row,
            PRED_TOP => {
                if y == 0 {
                    &zero_row
                } else {
                    &done[(y - 1) * w..]
                }
            }
            _ => &ext.unwrap()[y * w..(y + 1) * w],
        };
        let seg: &[u8] = match modes[y] {
            MODE_COPY => {
                row.copy_from_slice(pr);
                continue;
            }
            MODE_RANS => {
                let s = resbuf.get(decoded_syms..decoded_syms + w)?;
                decoded_syms += w;
                s
            }
            MODE_RAW => raw.take(w)?,
            _ => return None,
        };
        // Fused reconstruction: each output byte is written exactly once
        // (no copy_from_slice + second read-modify-write pass).
        if transform == TRANSFORM_LEFT_DELTA {
            prefix_add_pred_from(row, seg, pr);
        } else {
            add_pred_from(row, seg, pr);
        }
    }
    if decoded_syms != resbuf.len() {
        return None;
    }
    Some(())
}

// ───────────────────────────── SIMD kernels ─────────────────────────────
// x86-64 SSSE3/SSE2 fast paths with byte-identical scalar fallbacks (used on
// wasm32 and pre-SSSE3). Runtime-dispatched; mod-256 ring arithmetic is exact
// in both, so outputs are bit-equal by construction.

#[cfg(target_arch = "x86_64")]
mod kernels {
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    /// pshufb masks for planar→interleaved RGB: output byte j of block k holds
    /// channel j%3, pixel j/3; other lanes are zeroed (0x80) and OR-combined.
    const fn interleave_masks(ch: usize) -> [[i8; 16]; 3] {
        let mut m = [[-128i8; 16]; 3];
        let mut k = 0;
        while k < 3 {
            let mut l = 0;
            while l < 16 {
                let j = 16 * k + l;
                if j % 3 == ch {
                    m[k][l] = (j / 3) as i8;
                }
                l += 1;
            }
            k += 1;
        }
        m
    }
    const MR: [[i8; 16]; 3] = interleave_masks(0);
    const MG: [[i8; 16]; 3] = interleave_masks(1);
    const MB: [[i8; 16]; 3] = interleave_masks(2);

    #[inline]
    unsafe fn loadm(m: &[i8; 16]) -> __m128i {
        _mm_loadu_si128(m.as_ptr() as *const __m128i)
    }

    /// Interleave 16 pixels with fused subtract-green undo: the RCT-undo adds
    /// (`r = r_sg + g`, `b = b_sg + g`) run on registers already loaded for the
    /// shuffle, deleting the standalone RCT pass over both planes — and leaving
    /// the input planes in subtract-green form for the session cache.
    #[target_feature(enable = "ssse3")]
    pub unsafe fn interleave3_rct_undo_ssse3(g: &[u8], r_sg: &[u8], b_sg: &[u8], out: &mut [u8]) {
        let n = g.len();
        debug_assert!(r_sg.len() == n && b_sg.len() == n && out.len() == n * 3);
        let mut i = 0;
        while i + 16 <= n {
            let vg = _mm_loadu_si128(g.as_ptr().add(i) as *const __m128i);
            let vr = _mm_add_epi8(_mm_loadu_si128(r_sg.as_ptr().add(i) as *const __m128i), vg);
            let vb = _mm_add_epi8(_mm_loadu_si128(b_sg.as_ptr().add(i) as *const __m128i), vg);
            let dst = out.as_mut_ptr().add(i * 3);
            let mut k = 0;
            while k < 3 {
                let o = _mm_or_si128(
                    _mm_or_si128(
                        _mm_shuffle_epi8(vr, loadm(&MR[k])),
                        _mm_shuffle_epi8(vg, loadm(&MG[k])),
                    ),
                    _mm_shuffle_epi8(vb, loadm(&MB[k])),
                );
                _mm_storeu_si128(dst.add(16 * k) as *mut __m128i, o);
                k += 1;
            }
            i += 16;
        }
        // scalar tail
        while i < n {
            let gi = g[i];
            out[3 * i] = r_sg[i].wrapping_add(gi);
            out[3 * i + 1] = gi;
            out[3 * i + 2] = b_sg[i].wrapping_add(gi);
            i += 1;
        }
    }

    /// Fused row reconstruction: undo left-delta (mod-256 prefix sum) over the
    /// coded segment and add the prediction row, writing each output byte once
    /// (replaces copy_from_slice + in-place pass). SSE2-only, so
    /// unconditionally available on x86-64.
    #[target_feature(enable = "sse2")]
    pub unsafe fn prefix_add_pred_from_sse2(out: &mut [u8], seg: &[u8], pred: &[u8]) {
        let n = out.len();
        debug_assert!(seg.len() == n && pred.len() == n);
        let mut carry = 0u8;
        let mut i = 0;
        while i + 16 <= n {
            let mut x = _mm_loadu_si128(seg.as_ptr().add(i) as *const __m128i);
            x = _mm_add_epi8(x, _mm_slli_si128(x, 1));
            x = _mm_add_epi8(x, _mm_slli_si128(x, 2));
            x = _mm_add_epi8(x, _mm_slli_si128(x, 4));
            x = _mm_add_epi8(x, _mm_slli_si128(x, 8));
            x = _mm_add_epi8(x, _mm_set1_epi8(carry as i8));
            // Running carry for the next block = last prefix byte (lane 15).
            carry = ((_mm_extract_epi16(x, 7) as u32) >> 8) as u8;
            let p = _mm_loadu_si128(pred.as_ptr().add(i) as *const __m128i);
            let y = _mm_add_epi8(x, p);
            _mm_storeu_si128(out.as_mut_ptr().add(i) as *mut __m128i, y);
            i += 16;
        }
        while i < n {
            carry = carry.wrapping_add(seg[i]);
            out[i] = carry.wrapping_add(pred[i]);
            i += 1;
        }
    }
}

/// Undo left-delta over `seg` and add prediction, writing into `out` (scalar
/// reference; also the wasm path).
#[inline]
fn prefix_add_pred_from_scalar(out: &mut [u8], seg: &[u8], pred: &[u8]) {
    let n = out.len();
    let (seg, pred) = (&seg[..n], &pred[..n]);
    let mut acc = 0u8;
    for i in 0..n {
        acc = acc.wrapping_add(seg[i]);
        out[i] = acc.wrapping_add(pred[i]);
    }
}

#[inline]
fn prefix_add_pred_from(out: &mut [u8], seg: &[u8], pred: &[u8]) {
    #[cfg(target_arch = "x86_64")]
    {
        // SSE2 is baseline on x86-64.
        unsafe { kernels::prefix_add_pred_from_sse2(out, seg, pred) };
        return;
    }
    #[allow(unreachable_code)]
    prefix_add_pred_from_scalar(out, seg, pred);
}

/// out = seg + pred, one pass (replaces copy_from_slice + in-place add).
/// Plain wrapping add; LLVM auto-vectorizes this shape to paddb.
#[inline]
fn add_pred_from(out: &mut [u8], seg: &[u8], pred: &[u8]) {
    let n = out.len();
    let (seg, pred) = (&seg[..n], &pred[..n]);
    for i in 0..n {
        out[i] = seg[i].wrapping_add(pred[i]);
    }
}

// ───────────────────────────── image container ─────────────────────────────

const MAGIC: &[u8; 4] = b"FBR1";
// rct id 0 (= none) is reserved in the format; every current path encodes in
// subtract-green space, including temporal deltas.
const RCT_SUBTRACT_GREEN: u8 = 1;

fn deinterleave3(rgb: &[u8], n: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut r = vec![0u8; n];
    let mut g = vec![0u8; n];
    let mut b = vec![0u8; n];
    for i in 0..n {
        r[i] = rgb[3 * i];
        g[i] = rgb[3 * i + 1];
        b[i] = rgb[3 * i + 2];
    }
    (r, g, b)
}

/// Scalar reference for the fused RCT-undo interleave (also the wasm path).
#[inline]
fn interleave3_rct_undo_scalar(g: &[u8], r_sg: &[u8], b_sg: &[u8], out: &mut [u8]) {
    for i in 0..g.len() {
        let gi = g[i];
        out[3 * i] = r_sg[i].wrapping_add(gi);
        out[3 * i + 1] = gi;
        out[3 * i + 2] = b_sg[i].wrapping_add(gi);
    }
}

/// Interleave subtract-green planes to RGB with the RCT-undo fused in
/// (`out[3i] = r_sg+g, out[3i+1] = g, out[3i+2] = b_sg+g`). The planes are
/// left untouched (still subtract-green) — that is what lets the decode
/// session cache them for the next P-frame.
fn interleave3_rct_undo(g: &[u8], r_sg: &[u8], b_sg: &[u8], n: usize) -> Vec<u8> {
    // No zero-fill: both kernels below write every byte of out (SIMD blocks
    // cover 16-pixel groups, the scalar tail the rest) before any read; u8 has
    // no drop glue. Initialization-order proof as in decode_plane.
    let mut rgb: Vec<u8> = Vec::with_capacity(n * 3);
    unsafe { rgb.set_len(n * 3) };
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("ssse3") {
        unsafe { kernels::interleave3_rct_undo_ssse3(g, r_sg, b_sg, &mut rgb) };
        return rgb;
    }
    interleave3_rct_undo_scalar(g, r_sg, b_sg, &mut rgb);
    rgb
}

fn image_header(w: u32, h: u32, nplanes: u8, rct: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(MAGIC);
    put_u32(&mut out, w);
    put_u32(&mut out, h);
    out.push(nplanes);
    out.push(rct);
    out
}

fn push_plane(out: &mut Vec<u8>, plane: &[u8], w: usize, h: usize, pred: Predictor) {
    let at = out.len();
    put_u32(out, 0);
    encode_plane(plane, w, h, pred, out);
    let len = (out.len() - at - 4) as u32;
    out[at..at + 4].copy_from_slice(&len.to_le_bytes());
}

/// Lossless intra encode of interleaved RGB8: subtract-green RCT, Top predictor.
pub fn encode_rgb8(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
    let n = w as usize * h as usize;
    assert_eq!(rgb.len(), n * 3, "rgb size");
    let (mut r, g, mut b) = deinterleave3(rgb, n);
    for i in 0..n {
        r[i] = r[i].wrapping_sub(g[i]);
        b[i] = b[i].wrapping_sub(g[i]);
    }
    let mut out = image_header(w, h, 3, RCT_SUBTRACT_GREEN);
    for plane in [&g, &r, &b] {
        push_plane(&mut out, plane, w as usize, h as usize, Predictor::Top);
    }
    out
}

/// Rough Shannon cost (bits) of a plane under a predictor: histogram of the
/// mod-256 residuals, ignoring row modes. Good enough to rank predictors.
fn predictor_cost(plane: &[u8], w: usize, h: usize, pred: Predictor) -> f64 {
    let mut hist = [0u64; 256];
    let zero_row = vec![0u8; w];
    for y in 0..h {
        let cur = &plane[y * w..(y + 1) * w];
        let pr: &[u8] = match pred {
            Predictor::Zero => &zero_row,
            Predictor::Top => {
                if y == 0 {
                    &zero_row
                } else {
                    &plane[(y - 1) * w..y * w]
                }
            }
            Predictor::External(p) => &p[y * w..(y + 1) * w],
        };
        for i in 0..w {
            hist[cur[i].wrapping_sub(pr[i]) as usize] += 1;
        }
    }
    shannon_bits(&hist)
}

/// Lossless temporal-delta encode of interleaved RGB8 against the previous
/// decoded frame (mod-256 ring: exact for any pair of frames). Works in
/// subtract-green space like the intra path; each plane independently picks
/// the cheaper of {External (temporal), Top (spatial)} — high-motion planes
/// fall back to intra-style prediction instead of coding a noisy delta.
pub fn encode_rgb8_delta(cur: &[u8], prev: &[u8], w: u32, h: u32) -> Vec<u8> {
    let n = w as usize * h as usize;
    assert_eq!(cur.len(), n * 3, "cur size");
    assert_eq!(prev.len(), n * 3, "prev size");
    let (mut cr, cg, mut cb) = deinterleave3(cur, n);
    let (mut pr, pg, mut pb) = deinterleave3(prev, n);
    for i in 0..n {
        cr[i] = cr[i].wrapping_sub(cg[i]);
        cb[i] = cb[i].wrapping_sub(cg[i]);
        pr[i] = pr[i].wrapping_sub(pg[i]);
        pb[i] = pb[i].wrapping_sub(pg[i]);
    }
    let (wu, hu) = (w as usize, h as usize);
    let mut out = image_header(w, h, 3, RCT_SUBTRACT_GREEN);
    for (c, p) in [(&cg, &pg), (&cr, &pr), (&cb, &pb)] {
        let ext = Predictor::External(p);
        let pred = if predictor_cost(c, wu, hu, ext) <= predictor_cost(c, wu, hu, Predictor::Top)
        {
            ext
        } else {
            Predictor::Top
        };
        push_plane(&mut out, c, wu, hu, pred);
    }
    out
}

/// True iff every plane of a delta image is External-predicted with all-COPY
/// rows — i.e. the frame is byte-identical to its reference. Header-only scan.
fn delta_is_identity(bytes: &[u8], h: usize) -> Option<bool> {
    let mut r = Reader { b: bytes, p: 0 };
    if r.take(4)? != MAGIC {
        return None;
    }
    let _w = r.u32()?;
    let _h = r.u32()?;
    let nplanes = r.u8()?;
    let _rct = r.u8()?;
    if nplanes != 3 {
        return None;
    }
    for _ in 0..3 {
        let len = r.u32()? as usize;
        let blob = r.take(len)?;
        let mut pr = Reader { b: blob, p: 0 };
        let pred = pr.u8()?;
        let _transform = pr.u8()?;
        let modes = pr.take(h)?;
        if pred != PRED_EXTERNAL || modes.iter().any(|&m| m != MODE_COPY) {
            return Some(false);
        }
    }
    Some(true)
}

/// Parsed image container: header fields plus the three length-prefixed plane
/// blobs (validated bounds; dims guarded before any allocation).
struct PlaneBlobs<'a> {
    w: u32,
    h: u32,
    rct: u8,
    blobs: [&'a [u8]; 3],
}

fn split_container(bytes: &[u8]) -> Option<PlaneBlobs<'_>> {
    let mut r = Reader { b: bytes, p: 0 };
    if r.take(4)? != MAGIC {
        return None;
    }
    let w = r.u32()?;
    let h = r.u32()?;
    let nplanes = r.u8()?;
    let rct = r.u8()?;
    if w == 0 || h == 0 || nplanes != 3 {
        return None;
    }
    // Guard absurd dimensions before allocating.
    if w as usize * h as usize > (1usize << 31) / 4 {
        return None;
    }
    let mut blobs = [&bytes[0..0]; 3];
    for b in blobs.iter_mut() {
        let len = r.u32()? as usize;
        *b = r.take(len)?;
    }
    Some(PlaneBlobs { w, h, rct, blobs })
}

/// Per-plane decode scratch (rANS table + braided symbol buffer).
#[derive(Default)]
struct DecodeScratch {
    tab: Vec<u32>,
    res: Vec<u8>,
}

/// Streaming decode session for a chain of frames (I-frame, then temporal
/// deltas). Caches the previous frame's subtract-green planes so each P-frame
/// skips re-deriving them from interleaved RGB (deinterleave + 2n subtracts +
/// 3 allocs per frame) — the cached values are identical by mod-256 ring
/// construction (cached, not recomputed). Plane output buffers ping-pong, so a
/// warm session decodes frames with no per-frame plane allocation.
///
/// Contract: `decode_delta`'s `prev` must be the immediately preceding frame
/// of the same chain (what this session last returned). For arbitrary
/// references use the stateless [`decode_rgb8_delta`].
pub struct DeltaDecodeSession {
    /// Subtract-green planes (G, R−G, B−G) of the last decoded frame.
    planes: [Vec<u8>; 3],
    /// Decode destination for the next frame (last frame's discarded planes).
    spare: [Vec<u8>; 3],
    scratch: DecodeScratch,
    /// Dimensions the cached `planes` describe; None until the first decode.
    dims: Option<(u32, u32)>,
}

impl Default for DeltaDecodeSession {
    fn default() -> Self {
        Self::new()
    }
}

impl DeltaDecodeSession {
    pub fn new() -> Self {
        DeltaDecodeSession {
            planes: [Vec::new(), Vec::new(), Vec::new()],
            spare: [Vec::new(), Vec::new(), Vec::new()],
            scratch: DecodeScratch::default(),
            dims: None,
        }
    }

    /// Decode the three planes of `pb` (External-predicted against the cached
    /// planes iff `ext`), emit interleaved RGB with the RCT-undo fused in, and
    /// promote the freshly decoded planes to the session cache.
    fn decode_planes_into(&mut self, pb: &PlaneBlobs, ext: bool) -> Option<Vec<u8>> {
        let (w, h) = (pb.w as usize, pb.h as usize);
        let planes = &self.planes;
        let spare = &mut self.spare;
        let scratch = &mut self.scratch;
        for i in 0..3 {
            let mut pr = Reader { b: pb.blobs[i], p: 0 };
            let e = if ext { Some(planes[i].as_slice()) } else { None };
            decode_plane_into(&mut pr, w, h, e, &mut scratch.tab, &mut scratch.res, &mut spare[i])?;
        }
        let out = interleave3_rct_undo(&spare[0], &spare[1], &spare[2], w * h);
        std::mem::swap(&mut self.planes, &mut self.spare);
        self.dims = Some((pb.w, pb.h));
        Some(out)
    }

    /// Decode an intra frame, caching its planes for subsequent
    /// [`Self::decode_delta`] calls. Output identical to [`decode_rgb8`].
    pub fn decode_intra(&mut self, bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
        let pb = split_container(bytes)?;
        if pb.rct != RCT_SUBTRACT_GREEN {
            return None;
        }
        let (w, h) = (pb.w, pb.h);
        let out = self.decode_planes_into(&pb, false)?;
        Some((out, w, h))
    }

    /// Decode a temporal-delta frame against `prev` (the interleaved RGB8 this
    /// session returned for the previous frame). Output identical to
    /// [`decode_rgb8_delta`].
    pub fn decode_delta(&mut self, bytes: &[u8], prev: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
        let n = w as usize * h as usize;
        if prev.len() != n * 3 {
            return None;
        }
        // Identity fast path: every plane is External-predicted with all-COPY
        // rows (unchanged frame) → the reconstruction is exactly `prev`, no
        // plane work. Cached planes still describe the (identical) new frame.
        if delta_is_identity(bytes, h as usize) == Some(true) {
            return Some(prev.to_vec());
        }
        let pb = split_container(bytes)?;
        // Validate container dims against the caller's BEFORE decoding: the
        // External predictor slices w*h-sized planes (a mismatched container
        // must fail cleanly, not index out of bounds).
        if (pb.w, pb.h) != (w, h) || pb.rct != RCT_SUBTRACT_GREEN {
            return None;
        }
        if self.dims != Some((w, h)) {
            self.seed_from_rgb(prev, w, h);
        }
        self.decode_planes_into(&pb, true)
    }

    /// Derive the subtract-green planes of `prev` — identical values to what a
    /// previous decode would have cached (mod-256 ring is exact both ways).
    fn seed_from_rgb(&mut self, prev: &[u8], w: u32, h: u32) {
        let n = w as usize * h as usize;
        let (r, g, b) = deinterleave3(prev, n);
        let [pg, pr, pb] = &mut self.planes;
        *pg = g;
        *pr = r;
        *pb = b;
        for i in 0..n {
            pr[i] = pr[i].wrapping_sub(pg[i]);
            pb[i] = pb[i].wrapping_sub(pg[i]);
        }
        self.dims = Some((w, h));
    }
}

/// Decode an intra FableBraid image to interleaved RGB8.
pub fn decode_rgb8(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    DeltaDecodeSession::new().decode_intra(bytes)
}

/// Decode a temporal-delta FableBraid frame against `prev` (interleaved RGB8 of
/// the previous decoded frame). Returns the reconstructed frame. Stateless —
/// for frame chains prefer [`DeltaDecodeSession`], which caches the planar
/// form of `prev` between frames.
pub fn decode_rgb8_delta(bytes: &[u8], prev: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    DeltaDecodeSession::new().decode_delta(bytes, prev, w, h)
}

// ───────────────────────────── tests ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic xorshift so tests need no rand dep.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn byte(&mut self) -> u8 {
            (self.next() >> 32) as u8
        }
    }

    fn photo_like(w: usize, h: usize, seed: u64) -> Vec<u8> {
        // smooth gradient + mild noise: exercises small residuals
        let mut rng = Rng(seed | 1);
        let mut v = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    let base = (x * 3 + y * 2 + c * 40) as u8;
                    v[(y * w + x) * 3 + c] = base.wrapping_add(rng.byte() & 7);
                }
            }
        }
        v
    }

    fn screen_like(w: usize, h: usize) -> Vec<u8> {
        // flat bands + occasional "text" rows of near-random ink
        let mut rng = Rng(0xF00D);
        let mut v = vec![0u8; w * h * 3];
        for y in 0..h {
            let texty = y % 7 == 3;
            for x in 0..w {
                for c in 0..3 {
                    v[(y * w + x) * 3 + c] = if texty {
                        rng.byte()
                    } else {
                        ((y / 10) * 30 + c * 5) as u8
                    };
                }
            }
        }
        v
    }

    #[test]
    fn rans_roundtrip_skewed() {
        let mut rng = Rng(42);
        let mut syms = Vec::new();
        for _ in 0..10_000 {
            // skewed: mostly 0, some small, rare large
            let r = rng.byte();
            syms.push(if r < 200 { 0 } else if r < 240 { r & 3 } else { r });
        }
        let mut hist = [0u64; 256];
        for &s in &syms {
            hist[s as usize] += 1;
        }
        let freqs = normalize_freqs(&hist).unwrap();
        let (states, stream) = rans_encode(&syms, &freqs);
        let mut tab = Vec::new();
        build_decode_table_into(&freqs, &mut tab);
        let mut dec = RansDecoder::new(states, &stream, &tab).unwrap();
        let mut out = vec![0u8; syms.len()];
        dec.decode_all(&mut out);
        assert!(dec.finish(), "final state check");
        assert_eq!(out, syms);
    }

    #[test]
    fn rans_roundtrip_single_symbol() {
        let syms = vec![7u8; 999];
        let mut hist = [0u64; 256];
        hist[7] = 999;
        let freqs = normalize_freqs(&hist).unwrap();
        let (states, stream) = rans_encode(&syms, &freqs);
        let mut tab = Vec::new();
        build_decode_table_into(&freqs, &mut tab);
        let mut dec = RansDecoder::new(states, &stream, &tab).unwrap();
        let mut out = vec![0u8; 999];
        dec.decode_all(&mut out);
        assert!(dec.finish());
        assert_eq!(out, syms);
    }

    #[test]
    fn image_roundtrip_edge_dims() {
        for (w, h) in [(1u32, 1u32), (1, 5), (5, 1), (3, 3), (17, 9), (64, 64)] {
            let src = photo_like(w as usize, h as usize, (w * 31 + h) as u64);
            let enc = encode_rgb8(&src, w, h);
            let (dec, dw, dh) = decode_rgb8(&enc).expect("decode");
            assert_eq!((dw, dh), (w, h));
            assert_eq!(dec, src, "roundtrip {w}x{h}");
        }
    }

    #[test]
    fn image_roundtrip_photo_and_screen() {
        for src in [photo_like(214, 120, 7), screen_like(214, 120)] {
            let enc = encode_rgb8(&src, 214, 120);
            let (dec, _, _) = decode_rgb8(&enc).expect("decode");
            assert_eq!(dec, src);
            assert!(enc.len() < src.len(), "should compress these inputs");
        }
    }

    #[test]
    fn image_roundtrip_random_noise() {
        // Incompressible: RAW rows must engage and stay exact.
        let mut rng = Rng(99);
        let (w, h) = (37usize, 23usize);
        let src: Vec<u8> = (0..w * h * 3).map(|_| rng.byte()).collect();
        let enc = encode_rgb8(&src, w as u32, h as u32);
        let (dec, _, _) = decode_rgb8(&enc).expect("decode");
        assert_eq!(dec, src);
    }

    #[test]
    fn delta_roundtrip() {
        let (w, h) = (60u32, 40u32);
        let prev = photo_like(w as usize, h as usize, 5);
        let mut cur = prev.clone();
        // move a block, tweak some pixels
        for i in 3000..4200 {
            cur[i] = cur[i].wrapping_add(13);
        }
        let enc = encode_rgb8_delta(&cur, &prev, w, h);
        let dec = decode_rgb8_delta(&enc, &prev, w, h).expect("decode");
        assert_eq!(dec, cur);
        // identical frame should be tiny (all COPY rows)
        let same = encode_rgb8_delta(&prev, &prev, w, h);
        assert!(same.len() < 400, "all-COPY delta should be near-empty, got {}", same.len());
    }

    #[test]
    fn simd_kernels_match_scalar() {
        let mut rng = Rng(0xBEEF);
        for n in [0usize, 1, 7, 15, 16, 17, 47, 48, 100, 854] {
            let res: Vec<u8> = (0..n).map(|_| rng.byte()).collect();
            let pred: Vec<u8> = (0..n).map(|_| rng.byte()).collect();
            let mut a = vec![0u8; n];
            prefix_add_pred_from(&mut a, &res, &pred);
            let mut b = vec![0u8; n];
            prefix_add_pred_from_scalar(&mut b, &res, &pred);
            assert_eq!(a, b, "prefix_add_pred_from n={n}");
            // scalar reference vs first principles (mod-256 prefix sum + pred)
            let mut acc = 0u8;
            for i in 0..n {
                acc = acc.wrapping_add(res[i]);
                assert_eq!(b[i], acc.wrapping_add(pred[i]));
            }
            let mut c = vec![0u8; n];
            add_pred_from(&mut c, &res, &pred);
            for i in 0..n {
                assert_eq!(c[i], res[i].wrapping_add(pred[i]), "add_pred_from n={n}");
            }

            let r: Vec<u8> = (0..n).map(|_| rng.byte()).collect();
            let g: Vec<u8> = (0..n).map(|_| rng.byte()).collect();
            let bl: Vec<u8> = (0..n).map(|_| rng.byte()).collect();
            let fast = interleave3_rct_undo(&g, &r, &bl, n);
            let mut slow = vec![0u8; n * 3];
            interleave3_rct_undo_scalar(&g, &r, &bl, &mut slow);
            assert_eq!(fast, slow, "interleave3_rct_undo dispatch n={n}");
            // scalar reference is itself checked against first principles
            for i in 0..n {
                assert_eq!(slow[3 * i], r[i].wrapping_add(g[i]));
                assert_eq!(slow[3 * i + 1], g[i]);
                assert_eq!(slow[3 * i + 2], bl[i].wrapping_add(g[i]));
            }
        }
    }

    #[test]
    fn delta_session_matches_stateless_and_rejects_dim_mismatch() {
        let (w, h) = (61u32, 33u32);
        let mut frames: Vec<Vec<u8>> = Vec::new();
        for i in 0..6u32 {
            let mut f = photo_like(w as usize, h as usize, 100 + i as u64);
            if i == 2 {
                f = frames[1].clone(); // identity frame
            }
            frames.push(f);
        }
        let mut encs: Vec<Vec<u8>> = vec![encode_rgb8(&frames[0], w, h)];
        for i in 1..frames.len() {
            encs.push(encode_rgb8_delta(&frames[i], &frames[i - 1], w, h));
        }
        // Session decode must equal the stateless functions frame by frame.
        let mut sess = DeltaDecodeSession::new();
        let (mut cur, dw, dh) = sess.decode_intra(&encs[0]).expect("intra");
        assert_eq!((dw, dh), (w, h));
        assert_eq!(cur, frames[0]);
        for i in 1..frames.len() {
            let stateless = decode_rgb8_delta(&encs[i], &cur, w, h).expect("stateless");
            cur = sess.decode_delta(&encs[i], &cur, w, h).expect("session");
            assert_eq!(cur, stateless, "frame {i} session == stateless");
            assert_eq!(cur, frames[i], "frame {i} byte-exact");
        }
        // A non-identity delta whose container dims disagree with the
        // reference must fail cleanly (None), not slice the External planes
        // out of bounds. (An identity delta short-circuits before the dims
        // check — pre-existing semantics, unchanged.)
        let bigger_a = photo_like(w as usize * 2, h as usize, 7);
        let bigger_b = photo_like(w as usize * 2, h as usize, 8);
        let bad = encode_rgb8_delta(&bigger_b, &bigger_a, w * 2, h);
        assert!(decode_rgb8_delta(&bad, &frames[0], w, h).is_none());
        assert!(DeltaDecodeSession::new().decode_delta(&bad, &frames[0], w, h).is_none());
        // 3n/8 syms per plane keeps lane alignment; also cover a fresh session
        // starting mid-chain (seeds from prev).
        let mut mid = DeltaDecodeSession::new();
        assert_eq!(mid.decode_delta(&encs[1], &frames[0], w, h).expect("mid-chain"), frames[1]);
    }

    #[test]
    fn truncated_input_returns_none() {
        let src = photo_like(32, 32, 11);
        let enc = encode_rgb8(&src, 32, 32);
        for cut in [0, 3, 11, enc.len() / 2, enc.len() - 1] {
            assert!(decode_rgb8(&enc[..cut]).is_none(), "cut at {cut}");
        }
        // corrupt a rans byte: must fail the final-state check, not crash
        let mut bad = enc.clone();
        let mid = bad.len() / 2;
        bad[mid] ^= 0x5A;
        if let Some((px, _, _)) = decode_rgb8(&bad) {
            assert_ne!(px, src, "corruption must not silently roundtrip");
        }
    }
}
