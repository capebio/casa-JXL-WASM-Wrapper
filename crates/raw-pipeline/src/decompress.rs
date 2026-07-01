//! Olympus 12-bit raw decompression.
//!
//! Port of dcraw v9.28's `olympus_load_raw()` (David Coffin, public domain),
//! cross-checked against LibRaw 0.21.4 and the rawloader crate.
//! Algorithm: predictive variable-length encoding with a 12-bit Huffman prefix
//! table for the run-length "high" value, per-row state ("carry"), and a
//! context-dependent predictor using west / north / north-west neighbours.

/// Skip count before the bitstream begins (dcraw `fseek(ifp, 7, SEEK_CUR)`).
const HEADER_SKIP: usize = 7;

/// Cold, out-of-line constructor for the only error the decode hot-loop raises.
/// `#[cold]`/`#[inline(never)]` keep the `format!` machinery out of the per-pixel
/// inlined body so the hot loop stays dense in I-cache. (NB: the four per-pixel
/// truncation checks are intentionally NOT folded — see `dec_variant` bisect and
/// `docs/1 rejected optimizations.md` D9: folding them measured +13% on x86.)
#[cold]
#[inline(never)]
fn bitstream_exhausted(width: usize, nrows: usize) -> String {
    format!("decompress: bitstream exhausted before {}x{} pixels", width, nrows)
}

/// Decode one full row of `width` pixels into `cur_row` (len == width).
/// `north_row` is the row two above (same CFA parity), length == width, or `&[]`
/// for the first two rows. `acarry`/`west`/`north_west` are row-local and reset
/// here every call (dcraw resets carry per row). Byte-exact with the pre-refactor
/// inline loop; `#[inline(always)]` so `decompress_rows_into` codegen is unchanged.
#[inline(always)]
fn decode_row_into<const WIDE: bool>(
    br: &mut BitReader<'_, WIDE>,
    row: usize,
    width: usize,
    nrows: usize,
    north_row: &[u16],
    cur_row: &mut [u16],
) -> Result<(), String> {
    // acarry[parity] = [last_value, running_avg_signed, stable_counter]
    let mut acarry = [[0i32; 3]; 2];
    let mut west = [0i32; 2];
    let mut north_west = [0i32; 2];
    let cur_row_ptr = cur_row.as_mut_ptr();
    for col in 0..width {
        let parity = col & 1;
        let i = if acarry[parity][2] < 3 { 2 } else { 0 };
        // D2: leading_zeros equiv to the search loop (tested in D8(b)).
        let carry_lo = (acarry[parity][0] as u16) as u32;
        let bitlen = 32 - carry_lo.leading_zeros() as i32;
        let nbits = (2 + i as i32).max(bitlen - i as i32).min(16) as usize;

        // NB: per-read truncation checks are kept deliberately (NOT folded to
        // one). They break the BitReader state-dependency chain between reads,
        // letting truncation bookkeeping resolve off the inter-pixel critical
        // path; folding them measured +13% on x86 (rejected D9 — see bisect).
        let sb = br.read_bits(3);
        if br.truncated {
            return Err(bitstream_exhausted(width, nrows));
        }
        let low = (sb & 3) as i32;
        // arithmetic shift spreads top bit of the 3-bit field into a -1/0 mask
        let sign = (((sb as i32) << 29) >> 31) as i32;

        let high0 = br.read_huff();
        if br.truncated {
            return Err(bitstream_exhausted(width, nrows));
        }
        // Escape path reads (16 - nbits) bits — NOT a flat 16.  Then drop LSB.
        let high = if high0 == 12 {
            let extra = (16u32).saturating_sub(nbits as u32);
            (br.read_bits(extra) >> 1) as i32
        } else {
            high0 as i32
        };
        if br.truncated {
            return Err(bitstream_exhausted(width, nrows));
        }

        // carry[0] = (high << nbits) | nbits-bit literal.  `low` is NOT
        // OR'ed in here — it is applied to the diff when storing the pixel.
        acarry[parity][0] = (high << (nbits as u32)) | (br.read_bits(nbits as u32) as i32);
        if br.truncated {
            return Err(bitstream_exhausted(width, nrows));
        }
        let diff = (acarry[parity][0] ^ sign) + acarry[parity][1];
        // Running average uses the carry's OWN previous value (carry[1]),
        // not carry[0].  This is the dcraw / LibRaw / rawloader form.
        acarry[parity][1] = (diff * 3 + acarry[parity][1]) >> 5;
        acarry[parity][2] = if acarry[parity][0] > 16 {
            0
        } else {
            acarry[parity][2] + 1
        };

        // D1 predictor using delay lines (bit-exact with u16-masked re-reads).
        // D10: load this column's north sample ONCE (row>=2). The raw-pointer
        // store below defeats CSE of `north_row[col]`, so the old code reloaded
        // it (with a fresh bounds check) for the north_west update — fold to one.
        let north = if row >= 2 { north_row[col] as i32 } else { 0 };
        let pred = if row < 2 && col < 2 {
            0
        } else if row < 2 {
            west[parity]
        } else if col < 2 {
            north
        } else {
            // Branchless: flatten the nested data-dependent branches (every
            // pixel mispredicted) into precomputed candidates + cmov selects.
            // Bit-exact with the original gradient predictor.
            let w_ = west[parity];
            let n_ = north;
            let nw = north_west[parity];
            let awn = (w_ - nw).abs();
            let ann = (n_ - nw).abs();
            let between = ((w_ < nw) & (nw < n_)) | ((n_ < nw) & (nw < w_));
            let far = (awn > 32) | (ann > 32);
            let p_between = if far { w_ + n_ - nw } else { (w_ + n_) >> 1 };
            let p_else = if awn > ann { w_ } else { n_ };
            if between { p_between } else { p_else }
        };

        let v = (pred + ((diff << 2) | low)) & 0xFFFF;
        // SAFETY: cur_row_ptr from cur_row (len == width); col < width, so
        // cur_row_ptr.add(col) is in-bounds and exclusively owned; north_row is a
        // disjoint borrow. Same invariant as the pre-refactor inline loop.
        unsafe { *cur_row_ptr.add(col) = v as u16; }
        west[parity] = v;
        if row >= 2 {
            north_west[parity] = north;
        }
    }
    Ok(())
}

pub fn decompress(compressed: &[u8], width: usize, height: usize) -> Result<Vec<u16>, String> {
    decompress_rows(compressed, width, height, height)
}

/// Decode only the first `max_rows` rows (full width); cost proportional to rows decoded.
pub fn decompress_rows(compressed: &[u8], width: usize, height: usize, max_rows: usize)
    -> Result<Vec<u16>, String>
{
    let nrows = max_rows.min(height);
    let n = width
        .checked_mul(nrows)
        .ok_or_else(|| format!("decompress: {}x{} overflows", width, nrows))?;
    // Reject impossibly-short payloads BEFORE the zero-fill alloc: a malformed tiny
    // input claiming a huge WxH would otherwise force a large allocation + full
    // memset only to fail inside `_into`. Floor = 6 bits/pixel (read_bits(3) +
    // >=1-bit unary "high" + >=2-bit literal) — a safe lower bound that can never
    // reject a valid stream, so the only behaviour change is a faster, alloc-free
    // failure with the identical error text. (Sub-HEADER_SKIP inputs fall through to
    // `_into`'s existing "input too short" message — semantics unchanged.)
    if n != 0 && compressed.len() > HEADER_SKIP {
        if let Some(min_bits) = n.checked_mul(6) {
            let min_bytes = (min_bits + 7) / 8;
            if compressed.len() - HEADER_SKIP < min_bytes {
                return Err(bitstream_exhausted(width, nrows));
            }
        }
    }
    let mut out = vec![0u16; n];
    let rows = decompress_rows_into(compressed, width, height, max_rows, &mut out)?;
    out.truncate(width * rows);
    Ok(out)
}

/// Decode `min(max_rows, height)` full-width rows directly into a caller-owned `out`.
///
/// # Return-value contract (read it — the result is the only signal of validity)
/// On success returns `rows`, the number of rows actually written. Exactly
/// `out[0 .. rows * width]` holds fresh decoded pixels; **the tail
/// `out[rows * width ..]` is left untouched** (it keeps whatever the caller put
/// there — typically stale data from a previous decode, or zero). This function
/// never clears the tail. Callers MUST use the returned `rows` to bound reads:
/// do not assume `out.len() / width` rows are valid, and do not ignore the count.
/// See [`decompress_rows`] for a wrapper that allocates and truncates for you.
///
/// `out` must be at least `width * min(max_rows, height)` long, else `Err`.
pub fn decompress_rows_into(
    compressed: &[u8],
    width: usize,
    height: usize,
    max_rows: usize,
    out: &mut [u16],
) -> Result<usize, String> {
    let nrows = max_rows.min(height);
    let n = width
        .checked_mul(nrows)
        .ok_or_else(|| format!("decompress: {}x{} overflows", width, nrows))?;
    if out.len() < n {
        return Err(format!("decompress: output too small ({} < {})", out.len(), n));
    }
    if nrows == 0 {
        return Ok(0);
    }
    if compressed.len() <= HEADER_SKIP {
        return Err(format!(
            "decompress: input too short ({} bytes, need > {})",
            compressed.len(), HEADER_SKIP
        ));
    }
    // A zero-width frame has no pixels; the row loop would otherwise spin `nrows`
    // times doing no reads/writes (a cheap DoS on adversarial height). The
    // contract (out[0..rows*width] valid) holds trivially for width 0.
    if width == 0 {
        return Ok(nrows);
    }
    let mut br = BitReader::<WIDE_FILL>::new(&compressed[HEADER_SKIP..]);

    for row in 0..nrows {
        let row_base  = row * width;
        let row2_base = if row >= 2 { (row - 2) * width } else { 0 };
        // D1: north_row borrows the row two above (disjoint from cur via split_at_mut);
        // the per-row decode + predictor lives in the shared `decode_row_into` helper.
        let (above, cur) = out[..n].split_at_mut(row_base);
        let north_row: &[u16] = if row >= 2 { &above[row2_base..row2_base + width] } else { &[] };
        decode_row_into::<WIDE_FILL>(&mut br, row, width, nrows, north_row, &mut cur[..width])?;
    }
    if br.truncated {
        return Err(bitstream_exhausted(width, nrows));
    }
    Ok(nrows)
}

/// A source of decoded raw rows, produced strictly top-to-bottom. The extension
/// seam for other decoders (LJPEG/DNG) — implemented only by ORF today.
pub trait RawRowSource {
    fn width(&self) -> usize;
    fn height(&self) -> usize;
    /// Decode the next row into `dst` (len >= width). Ok(true) = a row was written
    /// to dst[..width]; Ok(false) = end of image; Err = corrupt/truncated stream.
    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String>;
}

/// Streaming Olympus ORF row decoder. Holds only a 3-row ring (the predictor needs
/// row r-2), not the full frame. Yields rows byte-identical to `decompress_rows_into`.
pub struct OrfRowDecoder<'a> {
    br: BitReader<'a, WIDE_FILL>,
    width: usize,
    height: usize,
    row: usize,
    ring: Vec<u16>, // 3 * max(width,1); row r lives in slot (r % 3)
}

impl<'a> OrfRowDecoder<'a> {
    pub fn new(compressed: &'a [u8], width: usize, height: usize) -> Result<Self, String> {
        if compressed.len() <= HEADER_SKIP {
            return Err(format!(
                "decompress: input too short ({} bytes, need > {})",
                compressed.len(), HEADER_SKIP
            ));
        }
        Ok(Self {
            br: BitReader::<WIDE_FILL>::new(&compressed[HEADER_SKIP..]),
            width,
            height,
            row: 0,
            ring: vec![0u16; 3 * width.max(1)],
        })
    }
}

impl RawRowSource for OrfRowDecoder<'_> {
    fn width(&self) -> usize { self.width }
    fn height(&self) -> usize { self.height }

    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String> {
        if self.row >= self.height {
            return Ok(false);
        }
        let r = self.row;
        let w = self.width;
        if w == 0 {
            self.row += 1;
            return Ok(true); // zero-width: no pixels, matches decompress_rows_into contract
        }
        // north = row r-2 from the ring (immutable), a field disjoint from br/dst.
        let north: &[u16] = if r >= 2 {
            let s = ((r - 2) % 3) * w;
            &self.ring[s..s + w]
        } else {
            &[]
        };
        decode_row_into::<WIDE_FILL>(&mut self.br, r, w, self.height, north, &mut dst[..w])?;
        // Stash into the ring so rows r+2 can read it as north.
        let cs = (r % 3) * w;
        self.ring[cs..cs + w].copy_from_slice(&dst[..w]);
        self.row += 1;
        Ok(true)
    }
}

/// Pull rows from `src` into a reused `scratch` (strip_rows * width) and hand each
/// full strip — and the final partial strip — to `sink(first_row, n_rows, &band)`.
/// One `scratch` allocation for the whole decode. `strip_rows` should be even when
/// the consumer pairs rows (e.g. half-demosaic); this wrapper is parity-agnostic.
pub fn for_each_strip<S: RawRowSource>(
    src: &mut S,
    strip_rows: usize,
    scratch: &mut Vec<u16>,
    mut sink: impl FnMut(usize, usize, &[u16]) -> Result<(), String>,
) -> Result<(), String> {
    assert!(strip_rows > 0, "strip_rows must be > 0");
    let w = src.width();
    scratch.resize(strip_rows * w.max(1), 0);
    let mut first = 0usize;
    loop {
        let mut k = 0usize;
        while k < strip_rows {
            let dst = &mut scratch[k * w..(k + 1) * w];
            if !src.next_row_into(dst)? {
                break;
            }
            k += 1;
        }
        if k == 0 {
            break;
        }
        sink(first, k, &scratch[..k * w])?;
        first += k;
        if k < strip_rows {
            break;
        }
    }
    Ok(())
}

/// Native targets use the u64 wide-load refill; wasm keeps the byte loop (no
/// cheap byteswap there — see `docs`/Questions_deferred D-wide-refill).
#[cfg(not(target_arch = "wasm32"))]
const WIDE_FILL: bool = true;
#[cfg(target_arch = "wasm32")]
const WIDE_FILL: bool = false;

/// MSB-first bit reader.  No byte stuffing (Olympus does not set `zero_after_ff`).
/// `WIDE` selects the refill strategy (see [`BitReader::fill`]); it is a const
/// generic only so the `dec_variant` bisect can A/B wide-vs-byteloop in one binary.
struct BitReader<'a, const WIDE: bool> {
    data: &'a [u8],
    pos: usize,
    buf: u64,
    nbits: u32,
    // real_in_buf: count of high bits in buf that came from real data (for truncation detect)
    real_in_buf: u32,
    // set if any *consumed* bits (not just peek window) came from zero-pad
    truncated: bool,
}

impl<'a, const WIDE: bool> BitReader<'a, WIDE> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            buf: 0,
            nbits: 0,
            real_in_buf: 0,
            truncated: false,
        }
    }

    #[inline(always)]
    fn fill(&mut self, need: u32) {
        if self.nbits >= need { return; }
        // Batch-fill to 56 bits so subsequent calls are usually no-ops.
        // Safe headroom: 56 + 8 (one more read_huff/read_bits) = 64 = u64 max.
        // The formula guarantees in_bounds*8 <= 56 - nbits, so the existing <=15
        // valid bits never shift past bit 55 — no u64 overflow.
        let in_bounds = self.data.len().saturating_sub(self.pos)
            .min(((56 - self.nbits.min(56)) / 8) as usize);
        if WIDE && in_bounds > 0 && self.pos + 8 <= self.data.len() {
            // Wide path: one unaligned big-endian u64 load instead of up to 7
            // dependent `(buf<<8)|byte` shifts on the inter-pixel critical path.
            // from_be_bytes puts data[pos] in the MSB; keeping the top `in_bounds`
            // bytes (>> the rest) reproduces the byte loop's MSB-first packing
            // EXACTLY. in_bounds is 1..=7, so the shift is 8..=56 (never 64/UB).
            let word = u64::from_be_bytes(
                self.data[self.pos..self.pos + 8].try_into().unwrap(),
            );
            let chunk = word >> ((8 - in_bounds) as u32 * 8);
            self.buf = (self.buf << (in_bounds as u32 * 8)) | chunk;
        } else {
            for i in 0..in_bounds {
                self.buf = (self.buf << 8) | self.data[self.pos + i] as u64;
            }
        }
        self.pos += in_bounds;
        self.nbits += (in_bounds as u32) * 8;
        self.real_in_buf += (in_bounds as u32) * 8;
        // Zero-pad if at end of stream. (truncation is decided at consume time via
        // real_in_buf, not here — so no separate `padded` flag is needed.)
        while self.nbits < need {
            self.buf <<= 8;
            self.nbits += 8;
            // pad bits appended low; real_in_buf (high real) unchanged
        }
    }

    #[inline(always)]
    fn read_bits(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        self.fill(n);
        let v = (self.buf >> (self.nbits - n)) & ((1u64 << n) - 1);
        // track if this consume crossed into pad bits
        if n > self.real_in_buf {
            self.truncated = true;
            self.real_in_buf = 0;
        } else {
            self.real_in_buf -= n;
        }
        self.nbits -= n;
        v as u32
    }

    /// Decode one Olympus "high" symbol. It is a **unary prefix code**, so no table
    /// is needed: from the original dcraw 4096-entry lookup, value = number of leading
    /// zero bits in the 12-bit peek (capped at 12 = escape) and the consumed length =
    /// value + 1 (capped at 12). One `leading_zeros` replaces a per-pixel 8 KB
    /// data-cache load on the inter-pixel critical path. `huff_lz_equiv_sweep` proves
    /// this closed form equals the canonical table for all 4096 indices.
    #[inline(always)]
    fn read_huff(&mut self) -> u32 {
        self.fill(12);
        let idx = ((self.buf >> (self.nbits - 12)) & 0xFFF) as u32;
        // idx < 4096 => at least 20 leading zeros in the u32, so `- 20` is in 0..=12.
        let value = idx.leading_zeros() - 20;
        let len = (value + 1).min(12);
        if len > self.real_in_buf {
            self.truncated = true;
            self.real_in_buf = 0;
        } else {
            self.real_in_buf -= len;
        }
        self.nbits -= len;
        value
    }
}

/// Test-only bridge so sibling modules (e.g. `stream_preview`) can reuse the
/// deterministic synthetic ORF payload generator.
#[cfg(test)]
pub(crate) fn tests_synth_payload(width: usize, height: usize, seed: u64) -> Vec<u8> {
    tests::synth_payload(width, height, seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // D8(a) golden: small crop generated from original impl (real ORF crop equiv via model),
    // pins D1/D2 bit-exactness. 4x3 exercises delay lines (row>=2, col parity, NW/west/north paths).
    const GOLDEN_FULL: &[u8] = &[
        0,0,0,0,0,0,0, 0x52,0x15,0x15,0x15,0x73,0x36,0x15,0x15,0x50,0x50,0x50,0x50
    ];
    const GOLDEN_W: usize = 4;
    const GOLDEN_H: usize = 3;
    const GOLDEN_EXPECT: &[u16] = &[
        10,20,30,40,
        15,25,35,45,
        12,22,32,42,
    ];

    #[test]
    fn golden_vector_d1_d2() {
        let out = decompress(GOLDEN_FULL, GOLDEN_W, GOLDEN_H).unwrap();
        assert_eq!(out, GOLDEN_EXPECT);
        // also via rows full
        let out2 = decompress_rows(GOLDEN_FULL, GOLDEN_W, GOLDEN_H, GOLDEN_H).unwrap();
        assert_eq!(out2, GOLDEN_EXPECT);
    }

    // Parity-unroll micro, REJECT (ScannerBot 20-06-26, branch ScannerBotDecompressDotRs).
    // Hypothesis: unroll the column loop ×2 so even/odd columns get scalar
    // `acarry`/`west`/`nw` locals instead of `[[i32;3];2]` indexed by `col & 1`,
    // hoping the running-average chain stays in registers (asm showed stack traffic).
    // Built bit-exact (golden + random even/odd/width-1 parity all EXACT) and measured
    // via a 5239x600 synthetic-bitstream flipflop. Result: +6.7 / -2.6 / -2.6 / -1.3 /
    // +2.2 % across warm runs — mean ~+0.5%, sign-unstable, entirely inside this box's
    // ±4-6% thermal noise band. Sub-V2 (>=5%) and trust:low (V1). The decode is
    // latency-bound on the bit-serial stream + huff table-load; the [parity] spill is
    // not on the binding critical path (OoO hides it). ea3fca93's branchless predictor
    // remains the achievable single-thread win. Don't re-chase (cf. D3/D6 below).
    #[test]
    #[ignore]
    fn parity_unroll_reject() {
        let _ = decompress(GOLDEN_FULL, GOLDEN_W, GOLDEN_H);
    }

    // Provenance guard for the table-free `read_huff`: its `leading_zeros` closed form
    // must equal dcraw's canonical 4096-entry "high" table for EVERY index. Builds the
    // original table locally as the oracle (read_huff is a pure fn of the 12-bit peek ->
    // (value, consumed-len)). If anyone "fixes" the formula, this fails. (The table was
    // removed from production as a needless 8 KB per-pixel load — ScannerBot 20-06-26.)
    #[test]
    fn huff_lz_equiv_sweep() {
        // dcraw's olympus build_huff, kept here only as the reference oracle.
        let mut table = [0u16; 4096];
        let mut n = 0usize;
        table[0] = 0xc0c; // 12-bit lookup, escape value 12
        for i in (0..12).rev() {
            let len = 2048usize >> i;
            for _ in 0..len {
                n += 1;
                table[n] = (((i as u16) + 1) << 8) | (i as u16);
            }
        }

        for idx in 0u32..4096 {
            let entry = table[idx as usize];
            let len_tbl = (entry >> 8) as u32;
            let val_tbl = (entry & 0xff) as u32;

            // The exact closed form used by `read_huff`.
            let value = idx.leading_zeros() - 20;
            let len = (value + 1).min(12);

            assert_eq!((val_tbl, len_tbl), (value, len), "huff mismatch at idx={}", idx);
        }
    }

    // D8(b): D2 formula matches the original search loop for all u16 carry, i in {0,2}.
    #[test]
    fn d2_equivalence_sweep() {
        fn old_nbits(carry_lo: u32, i: i32) -> usize {
            let mut nbits = 2 + i;
            while nbits < 16 && carry_lo >> (nbits + i) > 0 {
                nbits += 1;
            }
            nbits as usize
        }
        fn new_nbits(carry_lo: u32, i: i32) -> usize {
            let bitlen = 32 - carry_lo.leading_zeros() as i32;
            (2 + i).max(bitlen - i).min(16) as usize
        }
        for carry in 0u32..=0xffff {
            for ii in [0i32, 2] {
                assert_eq!(
                    old_nbits(carry, ii),
                    new_nbits(carry, ii),
                    "mismatch carry={} i={}",
                    carry, ii
                );
            }
        }
    }

    // D8(c): truncated input (causes pad) -> Err, not silent garbage (D4).
    #[test]
    fn truncated_input_errors_d4() {
        let full = GOLDEN_FULL;
        // truncate inside the payload
        let short: Vec<u8> = full[..(7 + 5)].to_vec();
        let e = decompress(&short, GOLDEN_W, GOLDEN_H).unwrap_err();
        assert!(e.contains("decompress: bitstream exhausted before 4x3 pixels"));
        // also for rows prefix
        let e2 = decompress_rows(&short, GOLDEN_W, GOLDEN_H, 2).unwrap_err();
        assert!(e2.contains("decompress: bitstream exhausted before 4x2 pixels"));
    }

    // D8(d): decompress_rows(k) == first k rows of full decode.
    #[test]
    fn decompress_rows_prefix_matches_d5() {
        let full_out = decompress(GOLDEN_FULL, GOLDEN_W, GOLDEN_H).unwrap();
        for k in 0..=GOLDEN_H {
            let pref = decompress_rows(GOLDEN_FULL, GOLDEN_W, GOLDEN_H, k).unwrap();
            let want = &full_out[..k * GOLDEN_W];
            assert_eq!(pref, want, "k={}", k);
        }
        // >H returns full (clamped)
        let over = decompress_rows(GOLDEN_FULL, GOLDEN_W, GOLDEN_H, 99).unwrap();
        assert_eq!(over, full_out);
    }

    #[test]
    fn decompress_rows_into_prefix_matches_and_reports_rows_written() {
        let mut out = vec![999u16; GOLDEN_W * GOLDEN_H];
        let rows = decompress_rows_into(GOLDEN_FULL, GOLDEN_W, GOLDEN_H, 2, &mut out).unwrap();
        assert_eq!(rows, 2);
        assert_eq!(&out[..GOLDEN_W * 2], &GOLDEN_EXPECT[..GOLDEN_W * 2]);
        assert_eq!(out[GOLDEN_W * 2], 999);
    }

    #[test]
    fn decompress_rows_into_short_output_errors() {
        let mut out = vec![0u16; GOLDEN_W * 2 - 1];
        let err = decompress_rows_into(GOLDEN_FULL, GOLDEN_W, GOLDEN_H, 2, &mut out).unwrap_err();
        assert!(err.contains("decompress: output too small"));
    }

    // #2: an impossibly-short payload for a giant claimed frame must be rejected
    // BEFORE the output is allocated. n = 1e10 px would need a ~20 GB zero-filled
    // Vec; if the pre-alloc guard regressed, this test would OOM instead of pass.
    #[test]
    fn decompress_rows_rejects_giant_dims_without_alloc() {
        let tiny = vec![0u8; HEADER_SKIP + 16];
        let err = decompress_rows(&tiny, 100_000, 100_000, 100_000).unwrap_err();
        assert!(err.contains("bitstream exhausted before 100000x100000"), "got: {}", err);
    }

    // #3: zero-width frame decodes to zero pixels for any height without spinning
    // the row loop (out tail untouched; returns the row count).
    #[test]
    fn decompress_zero_width_is_noop() {
        let payload = synth_payload(1, 1, 1); // any >HEADER_SKIP payload
        let mut out: [u16; 0] = [];
        assert_eq!(decompress_rows_into(&payload, 0, 5, 5, &mut out).unwrap(), 5);
        assert_eq!(decompress(&payload, 0, 5).unwrap(), Vec::<u16>::new());
        // sub-header input for width 0 still reports "input too short" (unchanged)
        let err = decompress_rows_into(&[0u8; 3], 0, 5, 5, &mut out).unwrap_err();
        assert!(err.contains("input too short"), "got: {}", err);
    }

    #[test]
    fn decompress_errors_use_ascii_x() {
        let short: Vec<u8> = GOLDEN_FULL[..(7 + 5)].to_vec();
        let err = decompress(&short, GOLDEN_W, GOLDEN_H).unwrap_err();
        assert!(err.contains("4x3"), "got: {}", err);
        assert!(!err.contains('×'));
    }

    // D3 benchmark-gated: one fill(48) + unchecked. Existing batch-to-56 already near-free.
    // Measured via micro: on 10k decodes of golden, delta <0.5%. <3% threshold. REJECT D3.
    // (No change to hot path; would add unsafe + complexity for negligible/negative.)
    #[test]
    #[ignore]
    fn d3_one_fill_bench_reject() {
        // measurement: current batch fill makes 3 fill calls ~free; single 48 + get_unchecked
        // showed 0.3% on win x86 in timing harness (not committed). Rejected per policy.
        let _ = decompress(GOLDEN_FULL, GOLDEN_W, GOLDEN_H);
    }

    // D6 micro, likely reject: skip zero-init via MaybeUninit.
    // memset cost for vec![0u16; n] is paid, but every cell written before read; unsafe permanent.
    // For 4k*3k ~24M u16 ~48MB, memset few ms; not worth unsound surface per policy.
    // Record: small case 0 measurable; large synthetic loop showed ~2-4ms save on release but
    // rejected (no #[ignore] timing in prod, and WASM/audit risk).
    #[test]
    #[ignore]
    fn d6_skip_zero_init_reject() {
        // no MaybeUninit in hot path. vec![0] retained.
    }

    // ---- D9/D10 byte-exact oracle + A/B timing harness -------------------------
    //
    // Verbatim copy of the pre-D9/D10 decoder (four per-pixel `br.truncated`
    // checks; `north_row[col]` reloaded for the north_west update). Kept here as
    // the differential oracle: it must produce byte-identical pixels (and the
    // identical Err on truncation) to the production `decompress_rows_into`.
    fn decompress_rows_into_old(
        compressed: &[u8],
        width: usize,
        height: usize,
        max_rows: usize,
        out: &mut [u16],
    ) -> Result<usize, String> {
        let nrows = max_rows.min(height);
        let n = width
            .checked_mul(nrows)
            .ok_or_else(|| format!("decompress: {}x{} overflows", width, nrows))?;
        if out.len() < n {
            return Err(format!("decompress: output too small ({} < {})", out.len(), n));
        }
        if nrows == 0 {
            return Ok(0);
        }
        if compressed.len() <= HEADER_SKIP {
            return Err(format!(
                "decompress: input too short ({} bytes, need > {})",
                compressed.len(), HEADER_SKIP
            ));
        }
        // <false> = byte-loop refill: the true pre-optimisation baseline.
        let mut br = BitReader::<false>::new(&compressed[HEADER_SKIP..]);
        for row in 0..nrows {
            let mut acarry = [[0i32; 3]; 2];
            let row_base = row * width;
            let row2_base = if row >= 2 { (row - 2) * width } else { 0 };
            let (above, cur) = out[..n].split_at_mut(row_base);
            let north_row: &[u16] =
                if row >= 2 { &above[row2_base..row2_base + width] } else { &[] };
            let cur_row = &mut cur[..width];
            let mut west = [0i32; 2];
            let mut north_west = [0i32; 2];
            let cur_row_ptr = cur_row.as_mut_ptr();
            for col in 0..width {
                let parity = col & 1;
                let i = if acarry[parity][2] < 3 { 2 } else { 0 };
                let carry_lo = (acarry[parity][0] as u16) as u32;
                let bitlen = 32 - carry_lo.leading_zeros() as i32;
                let nbits = (2 + i as i32).max(bitlen - i as i32).min(16) as usize;
                let sb = br.read_bits(3);
                if br.truncated {
                    return Err(format!("decompress: bitstream exhausted before {}x{} pixels", width, nrows));
                }
                let low = (sb & 3) as i32;
                let sign = (((sb as i32) << 29) >> 31) as i32;
                let high0 = br.read_huff();
                if br.truncated {
                    return Err(format!("decompress: bitstream exhausted before {}x{} pixels", width, nrows));
                }
                let high = if high0 == 12 {
                    let extra = (16u32).saturating_sub(nbits as u32);
                    (br.read_bits(extra) >> 1) as i32
                } else {
                    high0 as i32
                };
                if br.truncated {
                    return Err(format!("decompress: bitstream exhausted before {}x{} pixels", width, nrows));
                }
                acarry[parity][0] = (high << (nbits as u32)) | (br.read_bits(nbits as u32) as i32);
                if br.truncated {
                    return Err(format!("decompress: bitstream exhausted before {}x{} pixels", width, nrows));
                }
                let diff = (acarry[parity][0] ^ sign) + acarry[parity][1];
                acarry[parity][1] = (diff * 3 + acarry[parity][1]) >> 5;
                acarry[parity][2] = if acarry[parity][0] > 16 { 0 } else { acarry[parity][2] + 1 };
                let pred = if row < 2 && col < 2 {
                    0
                } else if row < 2 {
                    west[parity]
                } else if col < 2 {
                    north_row[col] as i32
                } else {
                    let w_ = west[parity];
                    let n_ = north_row[col] as i32;
                    let nw = north_west[parity];
                    let awn = (w_ - nw).abs();
                    let ann = (n_ - nw).abs();
                    let between = ((w_ < nw) & (nw < n_)) | ((n_ < nw) & (nw < w_));
                    let far = (awn > 32) | (ann > 32);
                    let p_between = if far { w_ + n_ - nw } else { (w_ + n_) >> 1 };
                    let p_else = if awn > ann { w_ } else { n_ };
                    if between { p_between } else { p_else }
                };
                let v = (pred + ((diff << 2) | low)) & 0xFFFF;
                unsafe { *cur_row_ptr.add(col) = v as u16; }
                west[parity] = v;
                if row >= 2 {
                    north_west[parity] = north_row[col] as i32;
                }
            }
        }
        if br.truncated {
            return Err(format!("decompress: bitstream exhausted before {}x{} pixels", width, nrows));
        }
        Ok(nrows)
    }

    // Bisect vehicle: FOLD = D9 single truncation check; HOIST = D10 north load
    // hoist; WIDE = u64 wide refill. <false,false,false> == original OLD. Const
    // generics let each combo monomorphize to clean branch-free code for timing.
    fn dec_variant<const FOLD: bool, const HOIST: bool, const WIDE: bool>(
        compressed: &[u8],
        width: usize,
        height: usize,
        max_rows: usize,
        out: &mut [u16],
    ) -> Result<usize, String> {
        let nrows = max_rows.min(height);
        let n = width.checked_mul(nrows).ok_or_else(|| "ovf".to_string())?;
        if out.len() < n { return Err("small".into()); }
        if nrows == 0 { return Ok(0); }
        if compressed.len() <= HEADER_SKIP { return Err("short".into()); }
        let mut br = BitReader::<WIDE>::new(&compressed[HEADER_SKIP..]);
        for row in 0..nrows {
            let mut acarry = [[0i32; 3]; 2];
            let row_base = row * width;
            let row2_base = if row >= 2 { (row - 2) * width } else { 0 };
            let (above, cur) = out[..n].split_at_mut(row_base);
            let north_row: &[u16] =
                if row >= 2 { &above[row2_base..row2_base + width] } else { &[] };
            let cur_row = &mut cur[..width];
            let mut west = [0i32; 2];
            let mut north_west = [0i32; 2];
            let cur_row_ptr = cur_row.as_mut_ptr();
            for col in 0..width {
                let parity = col & 1;
                let i = if acarry[parity][2] < 3 { 2 } else { 0 };
                let carry_lo = (acarry[parity][0] as u16) as u32;
                let bitlen = 32 - carry_lo.leading_zeros() as i32;
                let nbits = (2 + i as i32).max(bitlen - i as i32).min(16) as usize;
                let sb = br.read_bits(3);
                if !FOLD && br.truncated { return Err("trunc".into()); }
                let low = (sb & 3) as i32;
                let sign = (((sb as i32) << 29) >> 31) as i32;
                let high0 = br.read_huff();
                if !FOLD && br.truncated { return Err("trunc".into()); }
                let high = if high0 == 12 {
                    let extra = (16u32).saturating_sub(nbits as u32);
                    (br.read_bits(extra) >> 1) as i32
                } else { high0 as i32 };
                if !FOLD && br.truncated { return Err("trunc".into()); }
                let literal = br.read_bits(nbits as u32) as i32;
                if br.truncated { return Err("trunc".into()); }
                acarry[parity][0] = (high << (nbits as u32)) | literal;
                let diff = (acarry[parity][0] ^ sign) + acarry[parity][1];
                acarry[parity][1] = (diff * 3 + acarry[parity][1]) >> 5;
                acarry[parity][2] = if acarry[parity][0] > 16 { 0 } else { acarry[parity][2] + 1 };
                let north = if HOIST {
                    if row >= 2 { north_row[col] as i32 } else { 0 }
                } else { 0 };
                let pred = if row < 2 && col < 2 {
                    0
                } else if row < 2 {
                    west[parity]
                } else if col < 2 {
                    if HOIST { north } else { north_row[col] as i32 }
                } else {
                    let w_ = west[parity];
                    let n_ = if HOIST { north } else { north_row[col] as i32 };
                    let nw = north_west[parity];
                    let awn = (w_ - nw).abs();
                    let ann = (n_ - nw).abs();
                    let between = ((w_ < nw) & (nw < n_)) | ((n_ < nw) & (nw < w_));
                    let far = (awn > 32) | (ann > 32);
                    let p_between = if far { w_ + n_ - nw } else { (w_ + n_) >> 1 };
                    let p_else = if awn > ann { w_ } else { n_ };
                    if between { p_between } else { p_else }
                };
                let v = (pred + ((diff << 2) | low)) & 0xFFFF;
                unsafe { *cur_row_ptr.add(col) = v as u16; }
                west[parity] = v;
                if row >= 2 {
                    north_west[parity] = if HOIST { north } else { north_row[col] as i32 };
                }
            }
        }
        if br.truncated { return Err("trunc".into()); }
        Ok(nrows)
    }

    // Deterministic synthetic payload. 4 bytes/pixel = 32 bits >= the 31-bit
    // per-pixel worst case (3 sign/low + 12 huff + 16 escape/literal), so a full
    // decode of this stream never truncates — every pixel is exercised.
    pub(crate) fn synth_payload(width: usize, height: usize, seed: u64) -> Vec<u8> {
        let nbytes = HEADER_SKIP + width * height * 4;
        let mut v = Vec::with_capacity(nbytes);
        let mut s = seed | 1;
        for _ in 0..nbytes {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            v.push((s >> 24) as u8);
        }
        v
    }

    #[test]
    fn stream_rows_equal_full_decode() {
        for (w, h, seed) in [(128usize, 96usize, 0x1234u64), (255, 64, 0xBEEF), (64, 255, 0xABCD), (3, 257, 0x55)] {
            let payload = synth_payload(w, h, seed);
            let mut full = vec![0u16; w * h];
            decompress_rows_into(&payload, w, h, h, &mut full).unwrap();

            let mut dec = OrfRowDecoder::new(&payload, w, h).unwrap();
            assert_eq!(dec.width(), w);
            assert_eq!(dec.height(), h);
            let mut streamed = Vec::with_capacity(w * h);
            let mut rowbuf = vec![0u16; w];
            while dec.next_row_into(&mut rowbuf).unwrap() {
                streamed.extend_from_slice(&rowbuf);
            }
            assert_eq!(streamed, full, "streamed != full for {}x{}", w, h);
        }
        // truncation surfaces as Err mid-stream
        let short = synth_payload(64, 64, 7)[..HEADER_SKIP + 40].to_vec();
        let mut dec = OrfRowDecoder::new(&short, 64, 64).unwrap();
        let mut rowbuf = vec![0u16; 64];
        let mut err = false;
        loop {
            match dec.next_row_into(&mut rowbuf) {
                Ok(true) => continue,
                Ok(false) => break,
                Err(_) => { err = true; break; }
            }
        }
        assert!(err, "truncated stream should error");
    }

    #[test]
    fn for_each_strip_reconstructs_full() {
        let (w, h) = (17usize, 20usize); // odd width, strip not dividing height
        let payload = synth_payload(w, h, 0xF00D);
        let mut full = vec![0u16; w * h];
        decompress_rows_into(&payload, w, h, h, &mut full).unwrap();

        let mut dec = OrfRowDecoder::new(&payload, w, h).unwrap();
        let mut scratch = Vec::new();
        let mut got = Vec::new();
        let mut strips = 0;
        for_each_strip(&mut dec, 6, &mut scratch, |first, k, band| {
            assert_eq!(first, got.len() / w);
            assert!(k <= 6 && k > 0);
            got.extend_from_slice(&band[..k * w]);
            strips += 1;
            Ok(())
        }).unwrap();
        assert_eq!(got, full);
        assert_eq!(strips, 4); // 6+6+6+2
    }

    // Differential byte-exact on non-trivial sizes (odd widths exercise parity
    // edges) — far stronger than the 4x3 golden. Always runs.
    #[test]
    fn decompress_old_vs_new_byteexact() {
        for (w, h, seed) in [(128usize, 96usize, 0x1234u64), (255, 64, 0xBEEF), (64, 255, 0xABCDEF), (3, 257, 0x55)] {
            let payload = synth_payload(w, h, seed);
            let mut a = vec![0u16; w * h];
            let mut b = vec![0u16; w * h];
            let ra = decompress_rows_into_old(&payload, w, h, h, &mut a);
            let rb = decompress_rows_into(&payload, w, h, h, &mut b);
            assert!(ra.is_ok(), "oracle truncated unexpectedly w={} h={}", w, h);
            assert_eq!(ra, rb, "rows/Err differ w={} h={}", w, h);
            assert_eq!(a, b, "pixels differ w={} h={}", w, h);
        }
        // Truncation parity: a short payload must yield the identical Err from both.
        let short = synth_payload(64, 64, 7)[..HEADER_SKIP + 40].to_vec();
        let mut a = vec![0u16; 64 * 64];
        let mut b = vec![0u16; 64 * 64];
        let ra = decompress_rows_into_old(&short, 64, 64, 64, &mut a);
        let rb = decompress_rows_into(&short, 64, 64, 64, &mut b);
        assert!(ra.is_err());
        assert_eq!(ra, rb, "truncation Err differs");
    }

    // Rule-9 A/B timing. Interleaved with per-iteration start rotation to cancel
    // thermal drift. Run: cargo test --release --lib decompress::decompress_ab_timing
    //                       -- --ignored --nocapture
    #[test]
    #[ignore]
    fn decompress_ab_timing() {
        use std::time::Instant;
        let (w, h) = (1024usize, 1024usize);
        let payload = synth_payload(w, h, 0x9E3779B97F4A7C15);

        // 4 variants: base / fold-only / hoist-only / both(==production path).
        type F = fn(&[u8], usize, usize, usize, &mut [u16]) -> Result<usize, String>;
        // base = original (byte-loop fill, 4 checks, dup north). hoist = +D10.
        // hst+wide = +D10 +u64 wide refill (isolates the fill win). fold = +D9
        // (rejected, kept for the record). PROD = the real shipped fn (cold helper
        // + D10 + WIDE_FILL on native). fold uses byte-loop fill to match base.
        let variants: [(&str, F); 6] = [
            ("base    ", dec_variant::<false, false, false>),
            ("fold    ", dec_variant::<true, false, false>),
            ("hoist   ", dec_variant::<false, true, false>),
            ("hst+wide", dec_variant::<false, true, true>),
            ("fld+h+wd", dec_variant::<true, true, true>),
            ("PROD    ", decompress_rows_into),
        ];

        // All variants must be byte-identical to the production fn and each other.
        let mut gold = vec![0u16; w * h];
        decompress_rows_into(&payload, w, h, h, &mut gold).unwrap();
        for (name, f) in &variants {
            let mut b = vec![0u16; w * h];
            f(&payload, w, h, h, &mut b).unwrap();
            assert_eq!(b, gold, "variant {} not byte-exact", name.trim());
        }

        let iters = 120u32;
        let nv = variants.len();
        let mut acc = vec![0u128; nv];
        let mut buf = vec![0u16; w * h];
        for k in 0..iters {
            // rotate start index each iter to cancel ordering/thermal drift
            let start = (k as usize) % nv;
            for j in 0..nv {
                let idx = (start + j) % nv;
                let t = Instant::now();
                let _ = (variants[idx].1)(&payload, w, h, h, &mut buf);
                acc[idx] += t.elapsed().as_nanos();
            }
        }
        let base_ms = acc[0] as f64 / iters as f64 / 1e6;
        println!("decompress {}-way {}x{} ({} iters):", nv, w, h, iters);
        for i in 0..nv {
            let ms = acc[i] as f64 / iters as f64 / 1e6;
            println!(
                "  {}: {:.3} ms  ({:+.2}% vs base)",
                variants[i].0, ms, (ms - base_ms) / base_ms * 100.0
            );
        }
    }
}
