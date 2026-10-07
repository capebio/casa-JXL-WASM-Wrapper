//! Panasonic RW2 and Leica RWL, and Nikon NEF/NRW.
//!
//! Formats that this pipeline previously had no reader for, sharing a file
//! because they share a shape: a TIFF-ish container holding a single Bayer plane
//! that needs unpacking rather than decompressing. Everything here produces the
//! same `(raw: Vec<u16>, cfa_phase, black, white, wb)` the CR2 and DNG readers
//! produce, so `demosaic_bayer_mhc` and `pipeline::process_auto` are unchanged.
//!
//! **RWL is a rebadged Panasonic**, so the RW2 reader takes Leica for free —
//! confirmed on `leica_c-typ112`, which carries the identical tag set at TIFF
//! version 85.
//!
//! # Nikon coverage, and a correction
//!
//! This header used to say compressed NEF was "not here, deliberately… stays
//! with LibRaw". **That went stale and then misled a reader into planning a
//! decoder that already existed.** Nikon's compressed NEF (259 == 34713) IS
//! implemented below — Huffman-coded DPCM over two vertical predictors plus the
//! linearisation curve from MakerNote 0x0096 — and lossless, lossy-type-2 and
//! the Z-body modes all decode.
//!
//! What was actually missing until 2026-08-12 was **byte order**: Nikon's DSLR
//! line writes big-endian TIFF and this reader accepted only `II`, so it refused
//! every D-series body whatever its compression. Measured against a 34-file
//! fixture set (`raw-converter/tests/NEF Raws/`), that one gate accounted for 19
//! of 34 failures — far more than any compression mode.
//!
//! Two more layout facts the fixtures settled, both of which produce a plane
//! that decodes without error and is WRONG if guessed at:
//!
//! - **Two bytes a pixel means words, not packed bits, at any declared depth.**
//!   14-bit uncompressed measures exactly 2.000 B/px on the D3, D300 and D3S.
//!   Read as packed 14-bit it is noise.
//! - **The sensor is split across strips.** A D1H uses 407 of them; reading
//!   only `StripOffsets[0]` gives a 60 kB buffer where four megabytes are
//!   needed. Strips are checked for contiguity rather than assumed, so the
//!   reported payload range cannot silently swallow bytes lying between them.
//!
//! Nikon has written **two MakerNote shapes and two curve tags**, and the D1
//! series uses the older of each: no `Nikon\0` signature and no embedded TIFF
//! header (the value simply IS an IFD, file-relative, in the file's order), and
//! the curve at `0x008C` rather than `0x0096`. Both are handled.
//!
//! Still out: **CR3** (wraps CRX, a wavelet codec) and **CRW** (CIFF, not
//! TIFF). Within NEF, the **high-efficiency modes** on the newest Z bodies and
//! D810 small-raw: they carry only a 578-byte blob at 0x008C which is *not* a
//! linearisation table -- the same blob appears on a D3 and a D6 beside their
//! real 0x0096 -- so their table lives somewhere this does not yet look, and
//! they are refused rather than misread. COOLSCAN scanner NEFs are refused on
//! purpose: they are RGB, not a CFA plane.

use std::collections::HashMap;

#[derive(Debug)]
pub struct BayerImage {
    pub width: usize,
    pub height: usize,
    pub raw: Vec<u16>,
    /// `(x, y)` phase of the red pixel, matching `demosaic_bayer_mhc`.
    pub cfa_phase: (u8, u8),
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,
    pub make: String,
    pub model: String,
    /// Byte range of the sensor payload **within the original file**.
    ///
    /// An archiver needs this to carry everything else verbatim: without it the
    /// sidecar would have to be the whole file, and the archive would come out
    /// LARGER than the original. For RW2 it is the range the bit reader actually
    /// consumed rather than "offset to EOF", because guessing to EOF would swallow
    /// any trailing metadata into the strip and silently lose it.
    pub strip: std::ops::Range<usize>,
}

// ---- a minimal TIFF/IFD reader ---------------------------------------------
//
// `tiff.rs` exists but is built around the ORF/DNG tag world and assumes version
// 42. Panasonic uses version 85 with a private tag set, so this reads the raw IFD
// structure and lets each format name its own tags.

/// Byte order of a TIFF-ish structure.
///
/// **Not a formality: Nikon's DSLRs write big-endian.** Every classic body —
/// D1H, D1X, D2H, D2Hs, D3, D3S, D70, D70s, D100, D300, D300S — opens `MM`,
/// while the mirrorless Z line and the Nikon 1 series open `II`. A reader that
/// assumes little-endian refuses the entire DSLR range regardless of how its
/// sensor data is compressed, which is a far larger gap than any one
/// compression mode.
///
/// A file's order is not global, either: a Nikon MakerNote carries its own TIFF
/// header and may disagree with the file that contains it, so the order travels
/// with the structure rather than being read once.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum End {
    Le,
    Be,
}

impl End {
    /// Read a byte-order marker. `None` when it is neither `II` nor `MM`.
    fn of(b: &[u8]) -> Option<End> {
        match b.first().zip(b.get(1)) {
            Some((0x49, 0x49)) => Some(End::Le),
            Some((0x4d, 0x4d)) => Some(End::Be),
            _ => None,
        }
    }

    fn u16(self, b: &[u8]) -> u16 {
        let v = [b[0], b[1]];
        match self {
            End::Le => u16::from_le_bytes(v),
            End::Be => u16::from_be_bytes(v),
        }
    }

    fn u32(self, b: &[u8]) -> u32 {
        let v = [b[0], b[1], b[2], b[3]];
        match self {
            End::Le => u32::from_le_bytes(v),
            End::Be => u32::from_be_bytes(v),
        }
    }
}

struct Entry {
    typ: u16,
    count: u32,
    /// Inline bytes when the value fits in four, otherwise the bytes at the offset.
    val: Vec<u8>,
    /// The order the containing IFD was read in.
    ///
    /// Carried per entry so that `tag_u32` needs no extra argument — which is
    /// what keeps the twenty-odd RW2 tag reads below untouched by this.
    end: End,
    /// Where the value starts in the file.
    ///
    /// `val` is enough for a number; a MakerNote needs the *position*, because
    /// its own internal offsets are measured from it.
    voff: usize,
}

fn u16le(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}
fn u32le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 1,
    }
}

/// Read one IFD in the given byte order. Returns the tags and the next-IFD
/// offset.
fn read_ifd(d: &[u8], off: usize, end: End) -> Result<(HashMap<u16, Entry>, usize), String> {
    if off + 2 > d.len() {
        return Err("IFD offset past end of file".into());
    }
    let n = end.u16(&d[off..]) as usize;
    // A real IFD is tens of entries. A four-digit count means the offset is wrong,
    // and following it would read the file as a tag table.
    if n > 512 {
        return Err(format!("IFD at {} claims {} entries", off, n));
    }
    let ifd_end = off + 2 + n * 12;
    if ifd_end + 4 > d.len() {
        return Err("IFD runs past end of file".into());
    }
    let mut map = HashMap::with_capacity(n);
    for i in 0..n {
        let p = off + 2 + i * 12;
        let tag = end.u16(&d[p..]);
        let typ = end.u16(&d[p + 2..]);
        let count = end.u32(&d[p + 4..]);
        let size = type_size(typ).saturating_mul(count as usize);
        let (val, voff) = if size <= 4 {
            // **Big-endian inline values are LEFT-justified in the four-byte
            // field**, so a SHORT sits in the first two bytes on both orders and
            // slicing `size` from the start is right either way. This is the one
            // place the two layouts differ in a way that is easy to get wrong.
            (d[p + 8..p + 8 + size.min(4)].to_vec(), p + 8)
        } else {
            let vo = end.u32(&d[p + 8..]) as usize;
            if vo.saturating_add(size) > d.len() {
                (Vec::new(), vo) // out of range: keep the tag, drop the value
            } else {
                (d[vo..vo + size].to_vec(), vo)
            }
        };
        map.insert(tag, Entry { typ, count, val, end, voff });
    }
    Ok((map, end.u32(&d[ifd_end..]) as usize))
}

fn tag_u32(m: &HashMap<u16, Entry>, t: u16) -> Option<u32> {
    let e = m.get(&t)?;
    match e.typ {
        3 if e.val.len() >= 2 => Some(e.end.u16(&e.val) as u32),
        4 if e.val.len() >= 4 => Some(e.end.u32(&e.val)),
        _ => None,
    }
}

/// Every value of a tag, not just the first.
///
/// `tag_u32` returns element zero, which is right for a scalar and silently
/// wrong for `StripOffsets`/`StripByteCounts`: a D1H splits its sensor across
/// many strips, and reading one of them yields a 60 kB buffer where four
/// megabytes were needed.
fn tag_u32s(m: &HashMap<u16, Entry>, t: u16) -> Vec<u32> {
    let Some(e) = m.get(&t) else { return Vec::new() };
    let step = type_size(e.typ);
    if step == 0 {
        return Vec::new();
    }
    e.val
        .chunks_exact(step)
        .take(e.count as usize)
        .filter_map(|c| match e.typ {
            3 => Some(e.end.u16(c) as u32),
            4 => Some(e.end.u32(c)),
            _ => None,
        })
        .collect()
}

/// Unpack `bits`-wide samples, MSB-first, from a byte stream.
///
/// One pump for 8, 12, 14 and 16 bits rather than a branch per depth. The 12-bit
/// case is the three-bytes-to-two-pixels loop this replaces, and produces
/// identical output — the fixtures are what prove that, since a subtly wrong
/// unpacker still yields a plausible-looking image.
fn unpack_msb(src: &[u8], bits: u32, n: usize) -> Vec<u16> {
    let mut out = Vec::with_capacity(n);
    let mask = (1u64 << bits) - 1;
    let (mut acc, mut have) = (0u64, 0u32);
    for &b in src {
        acc = (acc << 8) | b as u64;
        have += 8;
        while have >= bits && out.len() < n {
            have -= bits;
            out.push(((acc >> have) & mask) as u16);
        }
        if out.len() == n {
            break;
        }
    }
    out.resize(n, 0);
    out
}

fn tag_str(m: &HashMap<u16, Entry>, t: u16) -> String {
    m.get(&t)
        .map(|e| {
            String::from_utf8_lossy(&e.val)
                .trim_end_matches('\0')
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

/// Hostile-dimension guard, same policy as the CR2/DNG readers (200 MP cap,
/// checked multiply): these dims come straight from file tags and size both
/// allocations and decode loops, so reject zero, implausible (> 65535 per
/// axis) and over-cap values before touching either. On wasm32 `w * h` is a
/// 32-bit multiply — unchecked it wraps and the undersized vec panics later.
fn check_dims(w: usize, h: usize, what: &str) -> Result<usize, String> {
    if w == 0 || h == 0 || w > 65535 || h > 65535 {
        return Err(format!("{what}: implausible dimensions {w}x{h}"));
    }
    let px = w
        .checked_mul(h)
        .ok_or_else(|| format!("{what}: {w}x{h} pixel count overflows"))?;
    if px > 200_000_000 {
        return Err(format!("{what}: {w}x{h} exceeds the 200 MP cap"));
    }
    Ok(px)
}

// ---- Panasonic RW2 / Leica RWL ---------------------------------------------

/// Panasonic's CFA enum (tag 0x0009) to a red-pixel phase.
///
/// 1 = RGGB is what the Leica C carries; 3 = the FZ80's layout. The mapping is
/// dcraw's and is what `demosaic_bayer_mhc` expects: `(x, y)` of the red sample.
fn pana_cfa_phase(cfa: u32) -> (u8, u8) {
    match cfa {
        1 => (0, 0), // RGGB
        2 => (1, 0), // GRBG
        3 => (0, 1), // GBRG
        4 => (1, 1), // BGGR
        _ => (0, 0),
    }
}

/// Panasonic's 12-bit bit reader.
///
/// **The buffer is read in 0x4000-byte pages and consumed BACKWARDS within each
/// page**, which is the part that looks like a bug and is not: `byte = vbits >> 3
/// ^ 0x3ff0` walks down from the top of the page. This is dcraw's `pana_bits`,
/// and the format is defined by it rather than by any published spec.
struct PanaBits<'a> {
    src: &'a [u8],
    pos: usize,
    load_flags: usize,
    buf: [u8; 0x4000 + 1],
    vbits: u32,
}

impl<'a> PanaBits<'a> {
    fn new(src: &'a [u8], load_flags: usize) -> Self {
        PanaBits { src, pos: 0, load_flags, buf: [0u8; 0x4000 + 1], vbits: 0 }
    }

    /// Refill one 0x4000 page. dcraw does **two** reads and lands the SECOND at
    /// `buf[0]`:
    ///
    /// ```c
    /// fread (buf+load_flags, 1, 0x4000-load_flags, ifp);
    /// fread (buf, 1, load_flags, ifp);
    /// ```
    ///
    /// Omitting the split still yields output that is *locally* smooth — adjacent
    /// samples differ by tens, because the DPCM predictor smooths whatever bits it
    /// is fed — so every self-consistency check passes while the picture is wrong.
    /// It took a reference image to catch: correlation against ImageMagick was
    /// 0.56 without the split and 0.90 with it.
    #[cold]
    #[inline(never)]
    fn fill(&mut self) {
        let lf = self.load_flags;
        // (Zeroing only the uncopied tail, OPF-31: ab NOISE, reverted.)
        self.buf[..0x4000].fill(0);
        let n1 = self.src.len().saturating_sub(self.pos).min(0x4000 - lf);
        self.buf[lf..lf + n1].copy_from_slice(&self.src[self.pos..self.pos + n1]);
        self.pos += n1;
        let n2 = self.src.len().saturating_sub(self.pos).min(lf);
        self.buf[..n2].copy_from_slice(&self.src[self.pos..self.pos + n2]);
        self.pos += n2;
    }

    #[inline(always)]
    fn get(&mut self, nbits: u32) -> u32 {
        if self.vbits == 0 {
            self.fill();
        }
        self.vbits = (self.vbits.wrapping_sub(nbits)) & 0x1ffff;
        let byte = ((self.vbits >> 3) ^ 0x3ff0) as usize;
        let lo = self.buf[byte] as u32;
        let hi = self.buf[byte + 1] as u32;
        ((lo | (hi << 8)) >> (self.vbits & 7)) & !(!0u32 << nbits)
    }

    /// The 128 bits below the cursor as one little-endian `u128`, when the cursor
    /// sits on a 16-byte chunk boundary inside a filled page (OPF-13). Bit `r` of
    /// the page lives at byte `(r >> 3) ^ 0x3ff0`, bit `r & 7`, so the positions
    /// `[p - 128, p)` are exactly the 16 bytes of one chunk, LE, bit `r & 127`.
    #[inline(always)]
    fn chunk(&self) -> Option<u128> {
        let p = self.vbits;
        if p == 0 || p & 127 != 0 {
            return None;
        }
        let at = (((p - 1) >> 3) ^ 0x3ff0) as usize & !15;
        Some(u128::from_le_bytes(self.buf[at..at + 16].try_into().unwrap()))
    }
}

/// [`pana_block`] for a full block whose two first codes (`nonz`) are nonzero,
/// from its 128-bit chunk (OPF-13). Then every field has a fixed place, top
/// down: 8+4, 8+4, then 2 before pixels 2, 5, 8, 11 and 8 per pixel = 128 bits,
/// so each is a constant shift of `u` and nothing waits on a moving cursor.
/// `false` (block untouched) when a first code is zero: its layout differs.
#[inline(always)]
fn pana_block_fixed(block: &mut [u16; 14], u: u128) -> bool {
    let f = |top: u32, n: u32| ((u >> (top - n)) as u32) & !(!0u32 << n);
    let (n0, n1) = (f(128, 8) as i32, f(116, 8) as i32);
    if n0 == 0 || n1 == 0 {
        return false;
    }
    let mut pred = [(n0 << 4) | f(120, 4) as i32, (n1 << 4) | f(108, 4) as i32];
    block[0] = pred[0].clamp(0, 65535) as u16;
    block[1] = pred[1].clamp(0, 65535) as u16;
    let (mut top, mut sh) = (104u32, 0u32);
    for i in 2..14 {
        if i % 3 == 2 {
            sh = 4 >> (3 - f(top, 2));
            top -= 2;
        }
        let j = f(top, 8) as i32;
        top -= 8;
        let k = i & 1;
        // (Branch-free `j != 0`, OPF-14: LOSS +5.1% cyc; RW2 mispredicts are
        // ~1-2.5 per 1000 branches, nothing to remove.)
        if j != 0 {
            pred[k] -= 0x80 << sh;
            if pred[k] < 0 || sh == 4 {
                pred[k] &= !((-1i32) << sh);
            }
            pred[k] += j << sh;
        }
        block[i] = pred[k].clamp(0, 65535) as u16;
    }
    true
}

/// One 14-pixel block (or a row's shorter tail block), fields from `get`. The
/// predictors reset per block, so a block decodes from its bit position alone.
#[inline(always)]
fn pana_block(block: &mut [u16], mut get: impl FnMut(u32) -> u32) {
    let (mut pred, mut nonz) = ([0i32; 2], [0i32; 2]);
    let mut sh = 0u32;
    for (i, o) in block.iter_mut().enumerate() {
        if i % 3 == 2 {
            sh = 4 >> (3 - get(2));
        }
        let k = i & 1;
        if nonz[k] != 0 {
            let j = get(8) as i32;
            if j != 0 {
                pred[k] -= 0x80 << sh;
                if pred[k] < 0 || sh == 4 {
                    pred[k] &= !((-1i32) << sh);
                }
                pred[k] += j << sh;
            }
        } else {
            nonz[k] = get(8) as i32;
            if nonz[k] != 0 || i > 11 {
                pred[k] = (nonz[k] << 4) | get(4) as i32;
            }
        }
        *o = pred[k].clamp(0, 65535) as u16;
    }
}

/// [`pana_block_fixed`] for 16 consecutive blocks at once (OPF-30): `src` is
/// their 16 chunks (256 bytes, block `b` at `16 * b`, which is how the page
/// lays out consecutive chunks), `dst` gets `16 * 14` pixels plus 2 scratch
/// samples past the end. One block per 16-bit lane: the predictors stay in
/// `0..=16287` (start <= 4095, six steps of at most `127 << 4`), so i16 lanes
/// hold them and the clamp is a no-op. `false` (dst untouched) when any block
/// has a zero first code.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn pana_group16(src: &[u8; 256], dst: &mut [u16; 16 * 14 + 2]) -> bool {
    use std::arch::x86_64::*;
    // Rows of 8 lanes in each 128-bit half -> lane j of row q, per half.
    #[inline]
    #[target_feature(enable = "avx2")]
    unsafe fn t8x8(a: [__m256i; 8]) -> [__m256i; 8] {
        let t = [
            _mm256_unpacklo_epi16(a[0], a[1]), _mm256_unpackhi_epi16(a[0], a[1]),
            _mm256_unpacklo_epi16(a[2], a[3]), _mm256_unpackhi_epi16(a[2], a[3]),
            _mm256_unpacklo_epi16(a[4], a[5]), _mm256_unpackhi_epi16(a[4], a[5]),
            _mm256_unpacklo_epi16(a[6], a[7]), _mm256_unpackhi_epi16(a[6], a[7]),
        ];
        let u = [
            _mm256_unpacklo_epi32(t[0], t[2]), _mm256_unpackhi_epi32(t[0], t[2]),
            _mm256_unpacklo_epi32(t[1], t[3]), _mm256_unpackhi_epi32(t[1], t[3]),
            _mm256_unpacklo_epi32(t[4], t[6]), _mm256_unpackhi_epi32(t[4], t[6]),
            _mm256_unpacklo_epi32(t[5], t[7]), _mm256_unpackhi_epi32(t[5], t[7]),
        ];
        [
            _mm256_unpacklo_epi64(u[0], u[4]), _mm256_unpackhi_epi64(u[0], u[4]),
            _mm256_unpacklo_epi64(u[1], u[5]), _mm256_unpackhi_epi64(u[1], u[5]),
            _mm256_unpacklo_epi64(u[2], u[6]), _mm256_unpackhi_epi64(u[2], u[6]),
            _mm256_unpacklo_epi64(u[3], u[7]), _mm256_unpackhi_epi64(u[3], u[7]),
        ]
    }
    let p = src.as_ptr() as *const __m128i;
    // Row b: chunk b in the low half, chunk b + 8 in the high half; after the
    // transpose, w[q] lane b (b + 8 high) = 16-bit word q of that chunk.
    let w = t8x8(std::array::from_fn(|b| {
        _mm256_inserti128_si256::<1>(_mm256_castsi128_si256(_mm_loadu_si128(p.add(b))), _mm_loadu_si128(p.add(b + 8)))
    }));
    // Field of `n` bits starting at chunk bit `lo` (bit 0 = LSB of the u128).
    let f = |lo: i32, n: i32| {
        let (q, off) = ((lo >> 4) as usize, lo & 15);
        let mut v = _mm256_srl_epi16(w[q], _mm_cvtsi32_si128(off));
        if off + n > 16 {
            v = _mm256_or_si256(v, _mm256_sll_epi16(w[q + 1], _mm_cvtsi32_si128(16 - off)));
        }
        _mm256_and_si256(v, _mm256_set1_epi16(((1u32 << n) - 1) as i16))
    };
    let zero = _mm256_setzero_si256();
    let (n0, n1) = (f(120, 8), f(108, 8));
    let z = _mm256_or_si256(_mm256_cmpeq_epi16(n0, zero), _mm256_cmpeq_epi16(n1, zero));
    if _mm256_testz_si256(z, z) == 0 {
        return false;
    }
    let mut pred = [
        _mm256_or_si256(_mm256_slli_epi16::<4>(n0), f(116, 4)),
        _mm256_or_si256(_mm256_slli_epi16::<4>(n1), f(104, 4)),
    ];
    let mut o = [zero; 16];
    o[0] = pred[0];
    o[1] = pred[1];
    // 1 << sh for the 2-bit field x: sh = 4 >> (3 - x) = 0, 1, 2, 4. The high
    // byte of each index is 0x80 so pshufb zeroes it.
    let m_lut = _mm256_setr_epi8(1, 2, 4, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    let hi80 = _mm256_set1_epi16(0x8000u16 as i16);
    let three = _mm256_set1_epi16(3);
    let one = _mm256_set1_epi16(1);
    let (mut m, mut keep, mut m128) = (zero, zero, zero);
    let mut top = 104;
    for i in 2..14 {
        if i % 3 == 2 {
            let x = f(top - 2, 2);
            top -= 2;
            m = _mm256_shuffle_epi8(m_lut, _mm256_or_si256(x, hi80));
            m128 = _mm256_slli_epi16::<7>(m);
            // Bits cleared when pred < 0 or sh == 4: everything above sh.
            keep = _mm256_andnot_si256(_mm256_sub_epi16(m, one), _mm256_cmpeq_epi16(x, three));
        }
        let j = f(top - 8, 8);
        top -= 8;
        let k = i & 1;
        let t = _mm256_sub_epi16(pred[k], m128);
        let clear = _mm256_or_si256(keep, _mm256_andnot_si256(_mm256_sub_epi16(m, one), _mm256_cmpgt_epi16(zero, t)));
        let t = _mm256_add_epi16(_mm256_andnot_si256(clear, t), _mm256_mullo_epi16(j, m));
        pred[k] = _mm256_blendv_epi8(t, pred[k], _mm256_cmpeq_epi16(j, zero));
        o[i] = pred[k];
    }
    // Back to block order: r[b] = pixels 0..8 of block b (b + 8 high), s[b] =
    // pixels 8..16 (14 and 15 are zero and land in the 2 scratch samples or
    // under the next block, which is stored after).
    let r = t8x8(std::array::from_fn(|i| o[i]));
    let s = t8x8(std::array::from_fn(|i| o[i + 8]));
    let d = dst.as_mut_ptr();
    for b in 0..8 {
        _mm256_storeu_si256(d.add(b * 14) as *mut __m256i, _mm256_permute2x128_si256::<0x20>(r[b], s[b]));
    }
    for b in 0..8 {
        _mm256_storeu_si256(d.add((b + 8) * 14) as *mut __m256i, _mm256_permute2x128_si256::<0x31>(r[b], s[b]));
    }
    true
}

/// Decode a Panasonic RW2 or Leica RWL.
pub fn decode_rw2(d: &[u8]) -> Result<BayerImage, String> {
    if d.len() < 8 || &d[0..2] != b"II" {
        return Err("not a little-endian TIFF-style file".into());
    }
    let ver = u16le(&d[2..]);
    if ver != 85 {
        return Err(format!("TIFF version {}, expected 85 for RW2/RWL", ver));
    }
    // RW2/RWL is little-endian by its own magic check above; no detection here.
    let (t, _) = read_ifd(d, u32le(&d[4..]) as usize, End::Le)?;

    let sensor_w = tag_u32(&t, 0x0002).ok_or("RW2: no SensorWidth")? as usize;
    let sensor_h = tag_u32(&t, 0x0003).ok_or("RW2: no SensorHeight")? as usize;
    let top = tag_u32(&t, 0x0004).unwrap_or(0) as usize;
    let left = tag_u32(&t, 0x0005).unwrap_or(0) as usize;
    let img_h = tag_u32(&t, 0x0006).unwrap_or(sensor_h as u32) as usize;
    let img_w = tag_u32(&t, 0x0007).unwrap_or(sensor_w as u32) as usize;
    let bits = tag_u32(&t, 0x000a).unwrap_or(12);
    let fmt = tag_u32(&t, 0x002d).unwrap_or(0);
    let raw_off = tag_u32(&t, 0x0118).ok_or("RW2: no raw offset (0x0118)")? as usize;
    let cfa = tag_u32(&t, 0x0009).unwrap_or(1);
    let white = tag_u32(&t, 0x000e).unwrap_or(4095) as u16;
    // Panasonic stores black as an offset above a 0 floor, per channel.
    let bl_r = tag_u32(&t, 0x0018).unwrap_or(0) as u16;
    let bl_g = tag_u32(&t, 0x0019).unwrap_or(0) as u16;
    let bl_b = tag_u32(&t, 0x001a).unwrap_or(0) as u16;
    let black = bl_r.max(bl_g).max(bl_b);
    // WB as raw multipliers against a 256 green.
    let wb_r = tag_u32(&t, 0x0024).unwrap_or(256) as f32 / 256.0;
    let wb_g = tag_u32(&t, 0x0025).unwrap_or(256) as f32 / 256.0;
    let wb_b = tag_u32(&t, 0x0026).unwrap_or(256) as f32 / 256.0;

    check_dims(sensor_w, sensor_h, "RW2 sensor")?;
    check_dims(img_w, img_h, "RW2 image")?;
    if left >= sensor_w || top >= sensor_h {
        return Err(format!(
            "RW2: crop origin ({left},{top}) outside sensor {sensor_w}x{sensor_h}"
        ));
    }
    if bits != 12 {
        return Err(format!("RW2: {}-bit is not supported (only 12)", bits));
    }
    if fmt != 4 {
        return Err(format!("RW2: RawFormat {} is not supported (only 4)", fmt));
    }
    if raw_off >= d.len() {
        return Err("RW2: raw offset past end of file".into());
    }

    // Decode the FULL sensor width, then crop — the bit stream is defined over
    // the sensor grid and the borders are part of it. One sensor row at a time
    // into a scratch row, and only its active-area span is kept (OPF-6,
    // 2026-10-07: the whole-sensor plane plus a crop copy was a second plane
    // of memory and page faults for nothing).
    //
    // Crop to the active area. The CFA phase is defined on the sensor grid, so
    // an odd border flips it — get this wrong and the image is colour-swapped
    // with no other symptom, which is exactly the silent failure this pipeline's
    // own avx2 module warns about for deinterleave.
    let (px, py) = pana_cfa_phase(cfa);
    let phase = ((px as usize + left) as u8 & 1, (py as usize + top) as u8 & 1);
    let mut raw = vec![0u16; img_w * img_h];
    let span = img_w.min(sensor_w - left);
    // + 2: scratch for the last block of a `pana_group16` store.
    let mut line = vec![0u16; sensor_w + 2];
    // load_flags is a function of RawFormat; 0x2008 is the value for format 4,
    // which is the only one accepted above.
    let mut bits_rd = PanaBits::new(&d[raw_off..], 0x2008);
    // Screening switch for OPF-13: every block through `PanaBits::get`.
    let chunked = std::env::var_os("BLIZZ_RW2_BLOCK_REF").is_none();
    // OPF-30: 16 blocks per AVX2 group (`BLIZZ_OPF30=0` turns it off).
    #[cfg(target_arch = "x86_64")]
    let group16 = chunked
        && std::env::var_os("BLIZZ_OPF30").map_or(true, |v| v != "0")
        && std::is_x86_feature_detected!("avx2");
    let full = sensor_w / 14;
    for row in 0..sensor_h {
        // A 14-pixel block resets the predictors; walking blocks removes the
        // per-pixel `col % 14`.
        let mut b = 0;
        // Blocks left to take one at a time after a group declined.
        let mut single = 0u32;
        while b * 14 < sensor_w {
            #[cfg(target_arch = "x86_64")]
            if group16 && single == 0 && b + 16 <= full && bits_rd.vbits >= 16 * 128 && bits_rd.vbits & 127 == 0 {
                // 16 chunks below the cursor, consecutive and ascending in the page.
                let at = ((bits_rd.vbits - 1) >> 3 ^ 0x3ff0) as usize & !15;
                let src: &[u8; 256] = bits_rd.buf[at..at + 256].try_into().unwrap();
                let dst: &mut [u16; 16 * 14 + 2] = (&mut line[b * 14..b * 14 + 16 * 14 + 2]).try_into().unwrap();
                // SAFETY: avx2 checked above.
                if unsafe { pana_group16(src, dst) } {
                    bits_rd.vbits -= 16 * 128;
                    b += 16;
                    continue;
                }
                single = 16;
            }
            single = single.saturating_sub(1);
            let block = &mut line[b * 14..(b * 14 + 14).min(sensor_w)];
            b += 1;
            // OPF-13: a full block with nonzero first codes is exactly one
            // 128-bit chunk with every field at a fixed place (on the bodies
            // here every block starts on a chunk boundary). Anything else goes
            // through `get`.
            if chunked {
                if let (Ok(b14), Some(u)) = (<&mut [u16; 14]>::try_from(&mut *block), bits_rd.chunk()) {
                    if pana_block_fixed(b14, u) {
                        bits_rd.vbits -= 128;
                        continue;
                    }
                }
            }
            pana_block(block, |n| bits_rd.get(n));
        }
        if (top..top + img_h).contains(&row) {
            let y = row - top;
            raw[y * img_w..y * img_w + span].copy_from_slice(&line[left..left + span]);
        }
    }

    // The bit reader's cursor is the honest end of the sensor payload. "Offset to
    // EOF" would swallow any trailing metadata into the strip and lose it, since
    // the sidecar is the file MINUS this range. Rounded up to the page the reader
    // works in, because it consumes whole 0x4000 pages.
    let consumed = bits_rd.pos.min(d.len() - raw_off);
    let strip = raw_off..raw_off + consumed;

    Ok(BayerImage {
        width: img_w,
        height: img_h,
        raw,
        cfa_phase: phase,
        black,
        white,
        wb_r,
        wb_g,
        wb_b,
        make: tag_str(&t, 0x010f),
        model: tag_str(&t, 0x0110),
        strip,
    })
}

// ---- Nikon NRW / NEF, UNCOMPRESSED only -------------------------------------

/// Decode a Nikon NEF/NRW whose raw SubIFD is uncompressed (tag 259 == 1).
///
/// The Coolpix B700's NRW is exactly this: 5200x3902 at 12 bits packed, and
/// `5200 * 3902 * 12 / 8 == 30 435 600`, which is the StripByteCounts to the byte.
/// **That arithmetic is the whole validation that the layout is packed rather
/// than padded**, and it is checked at runtime below rather than assumed.
///
/// Compressed NEF (259 == 34713) returns an error naming what it needs.
mod nikon_compressed;
use nikon_compressed::nikon_compressed;
#[cfg(test)]
use nikon_compressed::{make_decoder, NIKON_TREE};


/// The camera's own white balance from Nikon MakerNote `0x000C`, if it is there.
///
/// **`wb_r: 2.0, wb_g: 1.0, wb_b: 1.5` was a placeholder at three sites and it
/// is wrong by a lot.** Measured against the tag the files actually carry: a D3
/// is 1.6875 / 1.4688, a D500 2.2988 / 1.8101, and a Z 6 **1.1914 / 2.1191** —
/// where the hardcode claims 2.0 / 1.5, that last one is 68% out on red and 41%
/// out on blue. Any renderer using these numbers produces a colour cast that
/// looks like a decode fault and is a metadata fault, which is the same
/// confusion `tools/gallery.py`'s grey-world first draft caused from the other
/// direction.
///
/// `0x000C` is `WB_RBGGLevels`: four rationals in **R, B, G, G** order, already
/// normalised so green is 1.0. Older bodies do not carry it — a D100 has 32
/// MakerNote tags and none is `0x000C`, and a D1X has no signed MakerNote at all
/// — so this returns `None` there and the caller keeps the documented default
/// rather than inventing one.
///
/// The MakerNote is located exactly as the linearisation curve is, because it is
/// the same IFD; see the two-shapes comment in [`nikon_compressed`].
/// First `Nikon\0` MakerNote signature. memmem, not a `windows(6)` walk: a
/// signature-less body (D1X) scans the whole file, twice per decode.
fn nikon_sig(d: &[u8]) -> Option<usize> {
    memchr::memmem::find(d, b"Nikon\0")
}

fn nikon_wb(d: &[u8]) -> Option<(f32, f32, f32)> {
    let sig = nikon_sig(d)?;
    let base = sig + 10;
    if base + 8 > d.len() {
        return None;
    }
    let me = End::of(&d[base..])?;
    let mo = base + me.u32(&d[base + 4..]) as usize;
    if mo + 2 > d.len() {
        return None;
    }
    let n = me.u16(&d[mo..]) as usize;
    if n > 512 || mo + 2 + n * 12 > d.len() {
        return None;
    }
    for i in 0..n {
        let e = mo + 2 + i * 12;
        if me.u16(&d[e..]) != 0x000C {
            continue;
        }
        // RATIONAL (5), four of them: 32 bytes, always out of line.
        if me.u16(&d[e + 2..]) != 5 || me.u32(&d[e + 4..]) < 4 {
            return None;
        }
        let p = base + me.u32(&d[e + 8..]) as usize;
        if p + 32 > d.len() {
            return None;
        }
        let q = |k: usize| -> Option<f32> {
            let (num, den) = (me.u32(&d[p + k * 8..]), me.u32(&d[p + k * 8 + 4..]));
            (den != 0).then(|| num as f32 / den as f32)
        };
        let (r, b) = (q(0)?, q(1)?);
        // A zero or absurd multiplier is a misread, not a white balance. Refusing
        // keeps the documented default rather than shipping a black frame.
        return (r > 0.05 && r < 16.0 && b > 0.05 && b < 16.0).then_some((r, 1.0, b));
    }
    None
}

/// The red sample's `(x, y)` from a TIFF/EP `CFAPattern` (33422), if declared.
///
/// **Nikon is not all RGGB, and this reader assumed it was.** The comment on the
/// NEF plane said "Nikon Bayer is RGGB on every model in this corpus" and the
/// corpus disagrees: of 36 NEF/NRW fixtures, **27 declare RGGB, 4 declare BGGR,
/// 4 GBRG and 1 GRBG**. BGGR against a hardcoded RGGB is a red/blue transposition
/// in every consumer that demosaics; GBRG and GRBG are a one-sample shift, which
/// is wrong in a subtler and equally unrecoverable way.
///
/// The tag is the camera's own statement about its sensor, so reading it beats
/// any model table — and it was independently confirmed before being trusted:
/// on the D100 the pattern measured from the embedded preview (GRBG) is the
/// pattern the file declares (GRBG), and across the whole corpus measured and
/// declared agree on 47 of 47 files that state one.
///
/// Values are 0=R, 1=G, 2=B, row-major over the 2x2 site. Some writers prefix
/// the repeat dimensions as two shorts, which is why a 6+ byte value with a
/// leading `2,0`/`0,2` has four bytes skipped. Mapping matches
/// [`pana_cfa_phase`]: red at index `i` is `(i % 2, i / 2)`.
fn declared_cfa_phase(m: &HashMap<u16, Entry>) -> Option<(u8, u8)> {
    let e = m.get(&33422)?;
    let mut v = e.val.as_slice();
    if v.len() >= 6 && matches!(&v[..2], [2, 0] | [0, 2]) {
        v = &v[4..];
    }
    if v.len() < 4 {
        return None;
    }
    // A site with no red, or more than one, is not a Bayer pattern this
    // understands — refuse rather than default, because defaulting is the bug.
    let reds: Vec<usize> = (0..4).filter(|&i| v[i] == 0).collect();
    match reds[..] {
        [i] => Some(((i % 2) as u8, (i / 2) as u8)),
        _ => None,
    }
}


/// A NEF that declares compression 34713 and carries **uncompressed packed
/// samples**. `Some(plane)` when the strip is provably not a Huffman stream;
/// `None` leaves the compressed path untouched.
///
/// **The Nikon D100 declares 34713 and then stores no compressed data at all.**
/// Running the Huffman decoder over its packed samples produced a plane where
/// 99.9896% of samples sat at 16383 and only 14 of 2024 rows carried any
/// variation. Those live rows were *scattered* (946, 1639, 1660, ... 1998), not
/// a prefix, which is what rules out "the decoder lost state after row N" and
/// points at the payload not being a stream in the first place.
///
/// **The discriminator is structural, not a model string** — the same test
/// dcraw makes in `nikon_is_compressed()`. The samples sit in 16-byte blocks of
/// 15 data bytes plus one zero pad, so every 16th byte is zero; a Huffman
/// stream fills that byte like any other. Keying on the bytes rather than on
/// `model == "D100"` means a body nobody has a fixture for decodes for free,
/// and a D100 that ever ships a real stream still takes the normal path.
///
/// Measured over the whole corpus, so the check is known to be capable of
/// failing (00-COMMON invariant 3): on `12bit-compressed-other__D100.NEF` all
/// 615,296 pad bytes are zero — every block, not a sampled prefix — while the
/// three small-raw fixtures reach this test and are rejected by it loudly
/// (D810 1,691,319 of 1,694,640 pad bytes nonzero; D4s DX 315,218 of 319,200;
/// D4s FX 752,348 of 757,680). Every other 34713 fixture fails the shape tests
/// above it and never reaches the pad scan.
///
/// The layout follows from the arithmetic once the padding is known: 4,864
/// bytes per row is 304 blocks, 4,560 payload bytes, exactly 3,040 twelve-bit
/// samples MSB-first with no slack, of which the declared 3,034 are kept.
///
/// **Verified per sample against LibRaw, not against a preview.** This
/// unpacking reproduces `raw_image` over the full 2024 x 3037 visible frame
/// with **0 of 6,146,888 samples differing**; LSB-first differs on 6,145,142 of
/// them and correlates at -0.12. The last three columns the declared width
/// drops are real image data (means 436.7 / 385.8 / 438.0, which is why LibRaw
/// keeps them); columns 3037-3039 are the sensor's dark spares (means 0.8 /
/// 190.6 / 191.7) and LibRaw crops those too.
fn nikon_packed_in_disguise(
    d: &[u8],
    w: usize,
    h: usize,
    bits: u32,
    off: usize,
    len: usize,
) -> Option<Vec<u16>> {
    if h == 0 || len % h != 0 {
        return None;
    }
    let row_bytes = len / h;
    if row_bytes == 0 || row_bytes % 16 != 0 {
        return None;
    }
    let strip = d.get(off..off + len)?;
    // Every pad byte, not a prefix. dcraw samples because it is reading a file
    // handle; we hold the slice, and a whole-strip test cannot be fooled by a
    // stream that merely starts with zeros.
    if strip.chunks_exact(16).any(|b| b[15] != 0) {
        return None;
    }
    let per_row = row_bytes / 16 * 15 * 8 / bits as usize;
    if per_row < w {
        return None;
    }
    let mut raw = Vec::with_capacity(w * h);
    for row in strip.chunks_exact(row_bytes) {
        let payload: Vec<u8> = row.chunks_exact(16).flat_map(|b| b[..15].iter().copied()).collect();
        raw.extend_from_slice(&unpack_msb(&payload, bits, per_row)[..w]);
    }
    (raw.len() == w * h).then_some(raw)
}

pub fn decode_nef(d: &[u8]) -> Result<BayerImage, String> {
    if d.len() < 8 {
        return Err("NEF: too small to be a TIFF".into());
    }
    // **Both orders, because Nikon uses both.** The DSLR line writes `MM` and
    // the Z / Nikon 1 line writes `II`; refusing big-endian here refused every
    // classic body outright, whatever its compression.
    let e = End::of(&d[0..2]).ok_or("NEF: not a TIFF (no II/MM byte-order mark)")?;
    let (ifd0, _) = read_ifd(d, e.u32(&d[4..]) as usize, e)?;

    // The raw plane lives in a SubIFD, never in IFD0 — IFD0 is a thumbnail.
    let sub = ifd0.get(&330).ok_or("NEF: no SubIFDs")?;
    let mut offs = Vec::new();
    for k in 0..sub.count as usize {
        if (k + 1) * 4 <= sub.val.len() {
            offs.push(e.u32(&sub.val[k * 4..]) as usize);
        }
    }
    if offs.is_empty() && sub.val.len() >= 4 {
        offs.push(e.u32(&sub.val) as usize);
    }

    // Take the SubIFD with the most pixels: the others are previews. Area in
    // u64: these are unchecked file tags, and a 32-bit product can wrap.
    //
    // **It must also carry a strip offset.** The D80 has a larger SubIFD with no
    // 273 at all, so choosing purely on pixel count picked a directory that
    // describes no data and failed with "SubIFD has no strip offset" — a
    // confusing way to say "wrong SubIFD".
    let mut best: Option<(u64, HashMap<u16, Entry>)> = None;
    for so in offs {
        if let Ok((st, _)) = read_ifd(d, so, e) {
            if tag_u32(&st, 273).is_none() {
                continue;
            }
            let w = tag_u32(&st, 256).unwrap_or(0) as u64;
            let h = tag_u32(&st, 257).unwrap_or(0) as u64;
            if w * h > best.as_ref().map_or(0, |(n, _)| *n) {
                best = Some((w * h, st));
            }
        }
    }
    let (_, st) = best.ok_or("NEF: no SubIFD carries sensor data")?;

    let w = tag_u32(&st, 256).ok_or("NEF: SubIFD has no width")? as usize;
    let h = tag_u32(&st, 257).ok_or("NEF: SubIFD has no height")? as usize;
    let bits = tag_u32(&st, 258).unwrap_or(12);
    let comp = tag_u32(&st, 259).unwrap_or(0);
    let off = tag_u32(&st, 273).ok_or("NEF: SubIFD has no strip offset")? as usize;
    let len = tag_u32(&st, 279).unwrap_or(0) as usize;

    check_dims(w, h, "NEF")?;
    // **Declared, not assumed.** The sensor SubIFD carries CFAPattern on the
    // bodies that are not RGGB; ifd0 is the fallback for writers that put it
    // there. RGGB remains the default only for files that declare nothing.
    let cfa_phase =
        declared_cfa_phase(&st).or_else(|| declared_cfa_phase(&ifd0)).unwrap_or((0, 0));
    let wb = nikon_wb(d).unwrap_or((2.0, 1.0, 1.5));
    if comp == 34713 {
        // **Nikon reuses 34713 for High Efficiency, and an HE strip is not a
        // Huffman-DPCM stream at all** — it is an intoPIX TicoRAW (JPEG XS)
        // codestream, so it opens with the SOC marker `FF 10`.
        //
        // Measured before trusting the marker, because the lesson that started
        // this thread is that 34713 itself turned out not to mean what it
        // says. Over all 45 NEF/NRW files in the corpus, exactly 7 strips begin
        // `FF 10` and all 7 are HE or HE* bodies (Z 50 II, Z 5 II, Z 6 III and
        // four Z 9 HE/HE* files); the other 38 begin with 38 different byte
        // pairs, none of them `FF 10`. In particular the D810 small-raw file
        // that shares the linearisation-table refusal below begins `11 E1` and
        // is NOT diverted here.
        if len >= 2 && off + 2 <= d.len() && d[off] == 0xFF && d[off + 1] == 0x10 {
            return crate::nikon_he::decode(
                d,
                off,
                len,
                w,
                h,
                tag_str(&ifd0, 271),
                tag_str(&ifd0, 272),
                cfa_phase,
                wb,
            );
        }
        // dcraw's trees exist only for 12/14 bits; anything else would shift
        // out of range building `max` below.
        if bits != 12 && bits != 14 {
            return Err(format!(
                "NEF: compressed with {bits} bits is not supported (only 12/14)"
            ));
        }
        // The strip must be declared and lie inside the file — the bit reader
        // zero-pads past EOF, so without this a crafted header decodes w*h
        // symbols out of nothing.
        if len == 0 || off.checked_add(len).map_or(true, |end| end > d.len()) {
            return Err("NEF: compressed strip length out of range".into());
        }
        // **The tag is the thing that is wrong, so it is caught before the
        // decoder runs.** Decoding first and judging the output afterwards is
        // exactly how this file archived a blank plane at exit 0.
        if let Some(raw) = nikon_packed_in_disguise(d, w, h, bits, off, len) {
            return Ok(BayerImage {
                width: w,
                height: h,
                raw,
                cfa_phase,
                black: 0,
                white: ((1u32 << bits) - 1).min(u16::MAX as u32) as u16,
                wb_r: wb.0,
                wb_g: wb.1,
                wb_b: wb.2,
                make: tag_str(&ifd0, 271),
                model: tag_str(&ifd0, 272),
                strip: off..off + len,
            });
        }
        return nikon_compressed(d, &ifd0, w, h, bits, off, len, e, cfa_phase);
    }
    if comp != 1 {
        return Err(format!("NEF: compression {} is not supported", comp));
    }
    if !matches!(bits, 8 | 12 | 14 | 16) {
        return Err(format!("NEF: {}-bit uncompressed is not supported", bits));
    }
    // A scanner NEF can be RGB rather than CFA. Refusing is the honest answer:
    // this returns a Bayer plane, and handing three interleaved channels to a
    // Bayer consumer produces a picture that is wrong in a way nothing
    // downstream can detect.
    if let Some(spp) = tag_u32(&st, 277) {
        if spp != 1 {
            return Err(format!(
                "NEF: {spp} samples per pixel — this is an RGB image, not a CFA sensor plane"
            ));
        }
    }

    // **Strips, plural.** The classic DSLRs split the sensor across many, and
    // reading only the first gave a buffer two orders of magnitude short.
    let s_offs = tag_u32s(&st, 273);
    let s_lens = tag_u32s(&st, 279);
    let (off, len, strip_span) = if s_offs.len() > 1 {
        if s_lens.len() != s_offs.len() {
            return Err(format!(
                "NEF: {} strip offsets but {} byte counts",
                s_offs.len(),
                s_lens.len()
            ));
        }
        // Contiguity is checked rather than assumed. If the strips had gaps, the
        // span below would swallow the bytes between them into the sensor
        // payload, and an archiver using that range would silently drop whatever
        // lived there.
        let mut at = s_offs[0] as usize;
        for (o, l) in s_offs.iter().zip(&s_lens) {
            if *o as usize != at {
                return Err(format!(
                    "NEF: strips are not contiguous (expected {at}, found {o}) — refusing rather \
                     than guessing which bytes are sensor data"
                ));
            }
            at += *l as usize;
        }
        let total: usize = s_lens.iter().map(|l| *l as usize).sum();
        (s_offs[0] as usize, total, s_offs[0] as usize..at)
    } else {
        (off, len, off..off + len)
    };
    // **Coolpix NRW has THREE layouts, and the strip length picks between them.**
    // Keying on the declared byte count rather than a model-string table is both
    // simpler and what LibRaw's own A1000 branch effectively does.
    let packed = w * h * bits as usize / 8;
    let unpacked = w * h * 2;
    let model = tag_str(&ifd0, 272);

    let raw: Vec<u16> = if len == unpacked {
        // **Two bytes a pixel means words, not packed bits — at ANY declared
        // depth.** LibRaw's own test (tiff.cpp: `data_size == raw_width *
        // raw_height * 2 -> unpacked_load_raw`), and it is the rule for far more
        // than the Coolpix A1000 it was first written for: **14-bit
        // uncompressed NEF measures exactly 2.000 B/px** on the D3, D300 and
        // D3S, so the samples are 14-bit values sitting in 16-bit words.
        //
        // Treating those as packed 14-bit produced a plane that decoded without
        // error and was noise — mean |dx| 5607 against a 1365 threshold. The
        // noise check is the only thing that caught it, which is the argument
        // for having one.
        //
        // checked_add: on wasm32 `off + len` can wrap 32-bit usize and pass.
        if off.checked_add(unpacked).map_or(true, |end| end > d.len()) {
            return Err("NEF: strip runs past end of file".into());
        }
        d[off..off + unpacked].chunks_exact(2).map(|c| e.u16(c)).collect()
    } else if len == packed && bits != 12 {
        // Genuinely packed at a depth with no exotic layout: one MSB-first pump.
        if off + packed > d.len() {
            return Err("NEF: strip runs past end of file".into());
        }
        unpack_msb(&d[off..off + packed], bits, w * h)
    } else if len == packed {
        if off.checked_add(packed).map_or(true, |end| end > d.len()) {
            return Err("NEF: strip runs past end of file".into());
        }
        let src = &d[off..off + packed];
        // **"coolpixmangled": 12-bit MSB-first, but the byte stream is chunked
        // into 32-bit LITTLE-ENDIAN words.** dcraw spells this `load_flags = 24`,
        // which makes `packed_load_raw` refill its bit buffer 4 bytes at a time
        // with byte i at bit 8*i; RawSpeed calls it BitOrder::MSB32.
        //
        // This is what the period-4 structure in the raw stream was. Read as
        // plain packed 12-bit the plane is NOISE: no bit-plane correlates above
        // r = 0.24 with a reference. Byte-swapping each aligned 4-byte group
        // first takes correlation against ImageMagick from 0.60 to 0.9532.
        let mangled = model.starts_with("COOLPIX B")
            || (model.starts_with("COOLPIX P") && w != 4032);
        let mut raw = vec![0u16; w * h];
        if mangled {
            // The 12-bit fields do not realign per row, so the whole strip is one
            // pump. Both dcraw and RawSpeed only agree while w*12 is a multiple of
            // 32; refuse anything else rather than guess which is right.
            if w % 8 != 0 {
                return Err(format!(
                    "NEF: mangled Coolpix layout with width {w} is not 8-aligned"
                ));
            }
            let mut acc: u64 = 0;
            let mut nbits: u32 = 0;
            let mut out = 0usize;
            for chunk in src.chunks_exact(4) {
                acc = (acc << 32) | u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as u64;
                nbits += 32;
                while nbits >= 12 && out < raw.len() {
                    nbits -= 12;
                    raw[out] = ((acc >> nbits) & 0xFFF) as u16;
                    out += 1;
                }
            }
        } else {
            let mut i = 0usize;
            for px in raw.chunks_exact_mut(2) {
                let a = src[i] as u16;
                let b = src[i + 1] as u16;
                let c = src[i + 2] as u16;
                px[0] = (a << 4) | (b >> 4);
                px[1] = ((b & 0x0f) << 8) | c;
                i += 3;
            }
        }
        raw
    } else {
        return Err(format!(
            "NEF: {w}x{h} at {bits} bits needs {packed} packed or {unpacked} unpacked, strip              declares {len}"
        ));
    };

    Ok(BayerImage {
        width: w,
        height: h,
        raw,
        cfa_phase,
        black: 0,
        // `1u16 << 16` overflows; the widest legal white is u16::MAX.
        white: ((1u32 << bits) - 1).min(u16::MAX as u32) as u16,
        wb_r: wb.0,
        wb_g: wb.1,
        wb_b: wb.2,
        make: tag_str(&ifd0, 271),
        model: tag_str(&ifd0, 272),
        strip: strip_span,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `End` is the whole of the big-endian fix, so pin it without needing a
    /// file. `II`/`MM` are the only legal markers and everything else must be a
    /// refusal rather than a default, because defaulting to little-endian is
    /// precisely the bug this replaced.
    #[test]
    fn byte_order_marks_decide_the_order() {
        assert_eq!(End::of(b"II*\0"), Some(End::Le));
        assert_eq!(End::of(b"MM\0*"), Some(End::Be));
        assert_eq!(End::of(b"XX"), None, "an unknown mark must not default");
        assert_eq!(End::of(b"I"), None, "a truncated mark must not panic");
        assert_eq!(End::of(b""), None);

        let b = [0x12u8, 0x34, 0x56, 0x78];
        assert_eq!(End::Le.u16(&b), 0x3412);
        assert_eq!(End::Be.u16(&b), 0x1234);
        assert_eq!(End::Le.u32(&b), 0x7856_3412);
        assert_eq!(End::Be.u32(&b), 0x1234_5678);
    }

    /// The MSB-first pump must agree with the hand-rolled 12-bit loop it
    /// generalises, or every 12-bit file silently changes.
    #[test]
    fn unpack_msb_matches_the_three_byte_twelve_bit_loop() {
        let src: Vec<u8> = (0..=255u8).cycle().take(300).collect();
        let n = src.len() / 3 * 2;
        let mut want = vec![0u16; n];
        let mut i = 0;
        for px in want.chunks_exact_mut(2) {
            px[0] = ((src[i] as u16) << 4) | (src[i + 1] as u16 >> 4);
            px[1] = ((src[i + 1] as u16 & 0x0f) << 8) | src[i + 2] as u16;
            i += 3;
        }
        assert_eq!(unpack_msb(&src, 12, n), want);

        // And the trivial depths, where packing is identity.
        assert_eq!(unpack_msb(&[1, 2, 3], 8, 3), vec![1, 2, 3]);
        // Short input pads rather than panicking: lengths are file-controlled.
        // One byte is eight bits and never completes a 12-bit sample, so the
        // whole plane is the pad -- not a truncated first pixel.
        assert_eq!(unpack_msb(&[0xff], 12, 3), vec![0, 0, 0]);
        assert_eq!(unpack_msb(&[0xff, 0xf0], 12, 3), vec![0xfff, 0, 0]);
    }

    /// **The white balance is the camera's, and the placeholder it replaced was
    /// wrong by up to 68%.**
    ///
    /// `wb_r: 2.0, wb_g: 1.0, wb_b: 1.5` sat at three NEF construction sites and
    /// was never read from a file. Against MakerNote `0x000C`: a D3 is
    /// 1.6875/1.4688 and a Z 6 is **1.1914/2.1191**, so the placeholder overstated
    /// the Z 6's red by 68% and understated its blue by 29%. Any renderer using
    /// those numbers shows a cast that reads as a decode fault.
    ///
    /// The last case is the one that keeps the default honest: a D100 carries 32
    /// MakerNote tags and none is `0x000C`, so it must fall back rather than
    /// invent a value.
    #[test]
    fn the_white_balance_comes_from_the_file_where_the_file_has_one() {
        for (name, want) in [
            ("12bit-lossless__D3", Some((1.6875f32, 1.46875f32))),
            ("12bit-compressed-other__Z_6", Some((1.1914063, 2.1191406))),
            ("12bit-compressed-other__D100", None), // no 0x000C: documented default
        ] {
            let p = format!(r"C:\Foo\raw-converter\tests\NEF Raws\{name}.NEF");
            let Ok(d) = std::fs::read(&p) else {
                eprintln!("skipped: {p} not present");
                continue;
            };
            let b = decode_nef(&d).unwrap_or_else(|e| panic!("{name} must decode: {e}"));
            match want {
                Some((r, bl)) => {
                    assert!((b.wb_r - r).abs() < 1e-4, "{name}: wb_r {} want {r}", b.wb_r);
                    assert!((b.wb_b - bl).abs() < 1e-4, "{name}: wb_b {} want {bl}", b.wb_b);
                }
                None => assert_eq!(
                    (b.wb_r, b.wb_g, b.wb_b),
                    (2.0, 1.0, 1.5),
                    "{name} has no 0x000C and must keep the documented default"
                ),
            }
            assert_eq!(b.wb_g, 1.0, "{name}: green is the reference and stays 1.0");
        }
    }

    /// **The Nikon HE path used to carry its own hardcoded white balance.**
    ///
    /// `nikon_he::decode` built its `BayerImage` with `wb_r: 1.7051, wb_g: 1.0,
    /// wb_b: 1.5449` — one file's as-shot values, `nikon_z9_he`'s, frozen into
    /// the source. Every other HE body inherited them, which is the same defect
    /// as the `2.0 / 1.0 / 1.5` placeholder this reader carried at three sites,
    /// just narrower.
    ///
    /// The HE* files are the ones that expose it: they record **1.546875** where
    /// the hardcode claims 1.544921875. The difference is small and that is
    /// exactly why it survived — nothing downstream can see a 0.13% white
    /// balance error, and nothing would see a large one either.
    ///
    /// This calls `nikon_wb` rather than `decode_nef` on purpose: an HE decode is
    /// ~45 s a file, and what needs pinning is that the caller has a value to
    /// pass, not the synthesis below it.
    #[test]
    fn the_he_bodies_have_their_own_white_balance_to_read() {
        for (p, want_r, want_b) in [
            (r"C:\Foo\raw-converter\tests\raw-pixls\nikon_z9_hestar.NEF", 1.705078125f32, 1.546875f32),
            (r"C:\Foo\raw-converter\tests\raw-pixls\nikon_z9_he.NEF", 1.705078125, 1.544921875),
        ] {
            let Ok(d) = std::fs::read(p) else {
                eprintln!("skipped: {p} not present");
                continue;
            };
            let name = p.rsplit(std::path::MAIN_SEPARATOR).next().unwrap();
            let wb = nikon_wb(&d).unwrap_or_else(|| panic!("{name} carries 0x000C"));
            assert_eq!((wb.0, wb.1, wb.2), (want_r, 1.0, want_b), "{name}");
        }
        // The two must differ, or this test would pass against a hardcode.
        let a = std::fs::read(r"C:\Foo\raw-converter\tests\raw-pixls\nikon_z9_hestar.NEF");
        let b = std::fs::read(r"C:\Foo\raw-converter\tests\raw-pixls\nikon_z9_he.NEF");
        if let (Ok(a), Ok(b)) = (a, b) {
            assert_ne!(nikon_wb(&a), nikon_wb(&b), "HE and HE* must not share one value");
        }
    }

    /// **Nikon is not all RGGB, and this reader used to say it was.**
    ///
    /// Of the NEF/NRW fixture set, 27 declare RGGB, 4 BGGR, 4 GBRG and 1 GRBG.
    /// A BGGR plane handed over as RGGB is a red/blue transposition in every
    /// consumer that demosaics it, and nothing downstream can detect it.
    ///
    /// Each expectation here is the value the FILE declares in CFAPattern, and
    /// each was independently confirmed against the camera's own embedded
    /// preview before being written down.
    #[test]
    fn the_cfa_phase_comes_from_the_file_not_from_an_assumption() {
        // (fixture, declared pattern, red sample (x, y))
        for (name, pat, want) in [
            ("12bit-uncompressed__D1H", "BGGR", (1u8, 1u8)),
            ("12bit-uncompressed__D2H", "GBRG", (0, 1)),
            ("12bit-compressed-other__D100", "GRBG", (1, 0)),
            ("12bit-lossless__D3", "RGGB", (0, 0)),
        ] {
            let p = format!(r"C:\Foo\raw-converter\tests\NEF Raws\{name}.NEF");
            let Ok(d) = std::fs::read(&p) else {
                eprintln!("skipped: {p} not present");
                continue;
            };
            let b = decode_nef(&d).unwrap_or_else(|e| panic!("{name} must decode: {e}"));
            assert_eq!(b.cfa_phase, want, "{name} declares {pat}");
        }
    }

    /// **A version `0x4440` curve is quarter-scale, and reading it literally
    /// threw the linearisation away.**
    ///
    /// `14bit-compressed-other__Z_6` is the only file in the corpus with this
    /// version. Before the `ver1 == 0x40` arm it fell through to the
    /// read-directly branch, which set `max = csize` and copied 257 entries into
    /// a table still holding its identity fill, so every sample above 256 came
    /// out as its own curve index: the plane maxed at **4092** where LibRaw
    /// reads **16371**, and 15,146,739 of 24,498,560 samples differed. After the
    /// fix, **0 of 24,498,560 differ**.
    ///
    /// The maximum is the cheap discriminator and the reason this test does not
    /// need the oracle: a 14-bit body whose plane tops out just under 12 bits
    /// has not been linearised. Its siblings `Z_50` and `Z_f` carry version
    /// `0x4630`, keep the identity curve deliberately, and were exact all along
    /// — so they are here to catch a fix that "corrects" them too.
    #[test]
    fn a_quarter_scale_curve_is_interpolated_not_read_literally() {
        for (name, want_max, want_white) in [
            ("14bit-compressed-other__Z_6", 16371u16, 16380u16),
            ("14bit-compressed-other__Z_50", 16383, 16383),
            ("14bit-compressed-other__Z_f", 8438, 16383),
        ] {
            let p = format!(r"C:\Foo\raw-converter\tests\NEF Raws\{name}.NEF");
            let Ok(d) = std::fs::read(&p) else {
                eprintln!("skipped: {p} not present");
                continue;
            };
            let b = decode_nef(&d).unwrap_or_else(|e| panic!("{name} must decode: {e}"));
            let mx = b.raw.iter().copied().max().unwrap();
            assert_eq!(mx, want_max, "{name}: plane maximum");
            assert_eq!(b.white, want_white, "{name}: white level");
            assert!(
                mx > 4096,
                "{name} is a 14-bit body: a maximum inside 12 bits means no linearisation"
            );
        }
    }

    /// **14-bit uncompressed is words, not packed bits.** Measured at exactly
    /// 2.000 B/px on the D3, D300 and D3S. Reading it as packed 14-bit decodes
    /// without error and yields noise, so this asserts the plane looks like a
    /// photograph rather than merely that it decoded.
    #[test]
    fn fourteen_bit_uncompressed_is_words() {
        const F: &str = r"C:\Foo\raw-converter\tests\NEF Raws\14bit-uncompressed__D3.NEF";
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        let b = decode_nef(&d).expect("14-bit uncompressed must decode");
        assert_eq!((b.width, b.height), (4288, 2844));
        let (mut tot, mut n) = (0u64, 0u64);
        for y in (0..b.height).step_by(37) {
            let row = &b.raw[y * b.width..(y + 1) * b.width];
            for x in 2..b.width {
                tot += (row[x] as i32 - row[x - 2] as i32).unsigned_abs() as u64;
                n += 1;
            }
        }
        let mad = tot as f64 / n as f64;
        assert!(mad < 16384.0 / 12.0, "packed-bit misread would land here (mad {mad:.0})");
    }

    /// **A D1X has no `Nikon\0` and no 0x0096.** Its MakerNote is a bare IFD in
    /// the file's own byte order with file-relative offsets, and its curve is at
    /// the older tag 0x008C. Both had to be handled for this body to decode at
    /// all.
    #[test]
    fn an_unsigned_makernote_with_an_old_curve_tag_decodes() {
        const F: &str = r"C:\Foo\raw-converter\tests\NEF Raws\12bit-compressed-other__D1X.NEF";
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        assert!(
            !d.windows(6).any(|w| w == b"Nikon\0"),
            "fixture must be the signature-less case"
        );
        let b = decode_nef(&d).expect("a D1X must decode");
        assert_eq!(b.raw.len(), b.width * b.height);
        assert!(b.model.contains("D1X"), "model: {:?}", b.model);
    }

    /// **A curve blob too small for its own version header must be refused.**
    ///
    /// A D810 and a Z 6 III carry a 578-byte structure at 0x008C which is not a
    /// linearisation table — the same blob sits on a D3 and a D6 beside their
    /// real 0x0096. Version `0x49` skips 2110 bytes into it, i.e. past its end,
    /// and everything read after that is unrelated file content. Accepting it
    /// produced four files that decoded without error and were wrong.
    ///
    /// **The Z 6 III used to be the second case here and no longer is.** Its
    /// strip really does begin with the JPEG XS SOC marker, so it is a High
    /// Efficiency file that never reaches the curve check; the expectation, not
    /// the routing, was the stale half. See
    /// [`an_he_body_this_decoder_does_not_model_refuses_rather_than_overflowing`].
    /// The D810's strip begins `11 E1`, not `FF 10`, so the HE route cannot take
    /// it — and the "too small" the assertion below demands is the proof, since
    /// only the curve check can produce that message.
    #[test]
    fn an_undersized_curve_blob_is_refused() {
        const NAME: &str = "12bit-small-raw__D810";
        let p = format!(r"C:\Foo\raw-converter\tests\NEF Raws\{NAME}.NEF");
        let Ok(d) = std::fs::read(&p) else {
            eprintln!("skipped: {p} not present");
            return;
        };
        let e = decode_nef(&d).expect_err("must refuse rather than misread");
        assert!(e.contains("too small"), "{NAME}: unhelpful refusal: {e}");
    }

    /// **The D1H splits its sensor across 407 strips.** Reading only the first
    /// gave a 60 kB buffer where four megabytes were needed.
    #[test]
    fn a_multi_strip_nef_gathers_every_strip() {
        const F: &str = r"C:\Foo\raw-converter\tests\NEF Raws\12bit-uncompressed__D1H.NEF";
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        let b = decode_nef(&d).expect("a multi-strip NEF must decode");
        assert_eq!(b.raw.len(), b.width * b.height, "every strip must be gathered");
        assert!(
            b.strip.len() >= b.width * b.height * 12 / 8,
            "the reported payload must span all strips, not one"
        );
    }

    /// **A big-endian NEF must decode.** Nikon's DSLR line writes `MM`, and this
    /// reader used to refuse it outright — which cost every D-series body
    /// regardless of compression, 19 of 34 files in the fixture set.
    ///
    /// Skips when the corpus is absent: it lives outside the repo, and a test
    /// that fails on a clean checkout teaches people to ignore failures.
    #[test]
    fn a_big_endian_nef_decodes() {
        const F: &str = r"C:\Foo\raw-converter\tests\NEF Raws\14bit-lossless__D3.NEF";
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        assert_eq!(&d[0..2], b"MM", "fixture must be the big-endian case");

        let b = decode_nef(&d).expect("a big-endian NEF must decode");
        assert_eq!((b.width, b.height), (4288, 2844));
        assert_eq!(b.raw.len(), b.width * b.height);
        assert!(b.model.contains("D3"), "model: {:?}", b.model);
        assert!(!b.strip.is_empty() && b.strip.end <= d.len());

        // Decoding without error is not the same as decoding correctly. A
        // photograph sits a few percent of full scale between same-colour
        // neighbours; byte-swapped samples would sit near a third of it.
        let (mut tot, mut n) = (0u64, 0u64);
        for y in (0..b.height).step_by(37) {
            let row = &b.raw[y * b.width..(y + 1) * b.width];
            for x in 2..b.width {
                tot += (row[x] as i32 - row[x - 2] as i32).unsigned_abs() as u64;
                n += 1;
            }
        }
        let mad = tot as f64 / n as f64;
        assert!(mad < 16384.0 / 12.0, "decoded plane looks like noise (mad {mad:.0})");
    }

    /// The bit reader's page walk is the part most likely to be wrong, so pin the
    /// arithmetic rather than only the end-to-end result.
    #[test]
    fn pana_bits_walks_the_page_backwards() {
        let src = vec![0xAAu8; 0x4000];
        let mut b = PanaBits::new(&src, 0x2008);
        // First read primes the page and takes bits from the TOP of it.
        let v = b.get(8);
        assert_eq!(v, 0xAA, "a uniform page must read back uniform");
        assert!(b.pos == 0x4000, "one whole page is consumed up front");
    }

    /// The split read is the bug that produced a fictional -25% result, so pin the
    /// byte placement directly. A uniform page cannot detect it; this uses a page
    /// whose two halves differ.
    #[test]
    fn pana_bits_splits_the_page_at_load_flags() {
        const LF: usize = 0x2008;
        let mut src = vec![0x11u8; 0x4000];
        src[0x4000 - LF..].fill(0x22); // the bytes dcraw's SECOND fread places at buf[0]
        let mut b = PanaBits::new(&src, LF);
        b.get(1); // prime the page
        assert_eq!(b.buf[0], 0x22, "second read must land at buf[0]");
        assert_eq!(b.buf[LF], 0x11, "first read must land at buf[load_flags]");
    }

    /// The 12-bit lossy tree's length counts sum to 14 while only 13 symbols are
    /// printed in dcraw, so the builder takes its last symbol from the array's
    /// zero padding. Transcribing only the printed symbols overruns; pin the shape.
    #[test]
    fn nikon_decoder_uses_the_zero_padding() {
        let t = &NIKON_TREE[0];
        let counts: u32 = t[..16].iter().map(|&c| c as u32).sum();
        assert_eq!(counts, 14, "12-bit lossy tree has 14 codes");
        let huff = make_decoder(t);
        // Longest code is 10 bits: the last non-zero count sits at index 9.
        assert_eq!(huff[0], 10, "table is indexed by 10 bits");
        assert_eq!(huff.len(), 1 + (1 << 10));
        // First code is 2 bits -> symbol 5, filling 1 << (10-2) slots.
        assert_eq!(huff[1], (2 << 8) | 5);
        assert_eq!(huff[256], (2 << 8) | 5);
        assert_ne!(huff[257], (2 << 8) | 5, "the run ends after 256 slots");
    }

    #[test]
    fn read_ifd_refuses_a_nonsense_entry_count() {
        // 0xFFFF entries at offset 0 -- the shape a corrupt or misread offset takes.
        let d = vec![0xffu8; 64];
        assert!(read_ifd(&d, 0, End::Le).is_err());
    }

    /// OPF-13: the fixed-layout block equals `pana_block` reading the same chunk
    /// top-down, and declines exactly when a first code is zero.
    #[test]
    fn pana_block_fixed_matches_pana_block() {
        let mut s = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for t in 0..200_000 {
            let mut u = ((next() as u128) << 64) | next() as u128;
            if t % 7 == 0 {
                u &= !(0xffu128 << 120); // first code zero
            }
            if t % 11 == 0 {
                u &= !(0xffu128 << 108); // second first code zero
            }
            let (mut a, mut b) = ([0u16; 14], [0u16; 14]);
            let mut q = 128u32;
            pana_block(&mut a, |n| {
                // A zero first code can need more than 128 bits; only the
                // nonzero case is compared, so wrap rather than panic.
                q = q.wrapping_sub(n);
                ((u >> (q & 127)) as u32) & !(!0u32 << n)
            });
            let zero_first = (u >> 120) as u8 == 0 || (u >> 108) as u8 == 0;
            assert_eq!(pana_block_fixed(&mut b, u), !zero_first, "u={u:#x}");
            if !zero_first {
                assert_eq!(q, 0, "u={u:#x}");
                assert_eq!(a, b, "u={u:#x}");
            }
        }
    }

    /// OPF-30: 16 chunks through `pana_group16` give exactly what
    /// `pana_block_fixed` gives per chunk, and the group declines (dst
    /// untouched) when any block has a zero first code.
    #[cfg(target_arch = "x86_64")]
    #[test]
    fn pana_group16_matches_pana_block_fixed() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let mut s = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for t in 0..20_000 {
            let mut src = [0u8; 256];
            for c in src.chunks_mut(8) {
                c.copy_from_slice(&next().to_le_bytes());
            }
            if t % 5 == 0 {
                // One block with a zero first code: the group must decline.
                src[16 * (t % 16) + if t % 2 == 0 { 15 } else { 13 }] = 0;
                src[16 * (t % 16) + 14] &= if t % 2 == 0 { 0xff } else { 0xf0 };
            }
            let mut want = [7u16; 16 * 14 + 2];
            let mut ok = true;
            for b in 0..16 {
                let u = u128::from_le_bytes(src[16 * b..16 * b + 16].try_into().unwrap());
                let mut blk = [0u16; 14];
                ok &= pana_block_fixed(&mut blk, u);
                want[14 * b..14 * b + 14].copy_from_slice(&blk);
            }
            let mut got = [7u16; 16 * 14 + 2];
            assert_eq!(unsafe { pana_group16(&src, &mut got) }, ok, "t={t}");
            if ok {
                assert_eq!(got[..16 * 14], want[..16 * 14], "t={t}");
            } else {
                assert!(got.iter().all(|&v| v == 7), "t={t}");
            }
        }
    }

    #[test]
    fn rw2_refuses_a_non_rw2() {
        assert!(decode_rw2(b"II\x2a\x00\x08\x00\x00\x00").is_err());
        assert!(decode_rw2(b"MM\x00\x55\x00\x00\x00\x08").is_err());
    }

    /// Minimal little-endian TIFF: header (`ver`), one IFD at 8 of inline
    /// SHORT/LONG entries, next-IFD = 0.
    fn tiny_tiff(ver: u16, entries: &[(u16, u16, u32, u32)]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(b"II");
        d.extend_from_slice(&ver.to_le_bytes());
        d.extend_from_slice(&8u32.to_le_bytes());
        d.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for &(tag, typ, count, val) in entries {
            d.extend_from_slice(&tag.to_le_bytes());
            d.extend_from_slice(&typ.to_le_bytes());
            d.extend_from_slice(&count.to_le_bytes());
            d.extend_from_slice(&val.to_le_bytes());
        }
        d.extend_from_slice(&0u32.to_le_bytes());
        d
    }

    /// Hostile dims must come back as a clean error before any allocation —
    /// 65535x65535 wraps a wasm32 `w * h` and asks for gigabytes on native.
    #[test]
    fn rw2_refuses_hostile_dims() {
        let d = tiny_tiff(
            85,
            &[
                (0x0002, 3, 1, 0xFFFF), // SensorWidth
                (0x0003, 3, 1, 0xFFFF), // SensorHeight
                (0x000a, 3, 1, 12),     // bits
                (0x002d, 3, 1, 4),      // RawFormat
                (0x0118, 4, 1, 8),      // raw offset
            ],
        );
        let e = decode_rw2(&d).unwrap_err();
        assert!(e.contains("200 MP"), "want the cap error, got: {e}");
        // Zero is just as dead.
        let z = tiny_tiff(
            85,
            &[
                (0x0002, 3, 1, 0),
                (0x0003, 3, 1, 100),
                (0x000a, 3, 1, 12),
                (0x002d, 3, 1, 4),
                (0x0118, 4, 1, 8),
            ],
        );
        assert!(decode_rw2(&z).is_err());
    }

    /// A crop origin outside the sensor previously underflowed
    /// `sensor_w - left` and panicked.
    #[test]
    fn rw2_refuses_crop_origin_outside_sensor() {
        let d = tiny_tiff(
            85,
            &[
                (0x0002, 3, 1, 16),
                (0x0003, 3, 1, 16),
                (0x0005, 3, 1, 100), // CropLeft > SensorWidth
                (0x000a, 3, 1, 12),
                (0x002d, 3, 1, 4),
                (0x0118, 4, 1, 8),
            ],
        );
        let e = decode_rw2(&d).unwrap_err();
        assert!(e.contains("crop origin"), "want the crop guard, got: {e}");
    }

    /// NEF with a SubIFD claiming compressed 60000x60000: without the dims cap
    /// the zero-padding bit reader would decode 3.6e9 symbols from nothing.
    #[test]
    fn nef_refuses_hostile_dims() {
        // IFD0 at 8: one entry (330 → SubIFD offset), next = 0. SubIFD follows.
        let sub_off: u32 = 8 + 2 + 12 + 4;
        let mut d = Vec::new();
        d.extend_from_slice(b"II");
        d.extend_from_slice(&42u16.to_le_bytes());
        d.extend_from_slice(&8u32.to_le_bytes());
        d.extend_from_slice(&1u16.to_le_bytes());
        for &(tag, typ, count, val) in &[(330u16, 4u16, 1u32, sub_off)] {
            d.extend_from_slice(&tag.to_le_bytes());
            d.extend_from_slice(&typ.to_le_bytes());
            d.extend_from_slice(&count.to_le_bytes());
            d.extend_from_slice(&val.to_le_bytes());
        }
        d.extend_from_slice(&0u32.to_le_bytes());
        let sub: &[(u16, u16, u32, u32)] = &[
            (256, 4, 1, 60000),  // width
            (257, 4, 1, 60000),  // height
            (258, 3, 1, 12),     // bits
            (259, 3, 1, 34713),  // compressed
            (273, 4, 1, 8),      // strip offset
            (279, 4, 1, 100),    // strip len
        ];
        assert_eq!(d.len() as u32, sub_off);
        d.extend_from_slice(&(sub.len() as u16).to_le_bytes());
        for &(tag, typ, count, val) in sub {
            d.extend_from_slice(&tag.to_le_bytes());
            d.extend_from_slice(&typ.to_le_bytes());
            d.extend_from_slice(&count.to_le_bytes());
            d.extend_from_slice(&val.to_le_bytes());
        }
        d.extend_from_slice(&0u32.to_le_bytes());
        let e = decode_nef(&d).unwrap_err();
        assert!(e.contains("200 MP"), "want the cap error, got: {e}");
    }

    /// **A D100 declares compression 34713 and stores no compressed data.**
    ///
    /// Pinned against LibRaw per sample, not against "it stopped erroring". The
    /// FNV-1a below is over the whole 2024 x 3034 plane as little-endian u16,
    /// taken from `rawpy`'s `raw_image` (the full frame, because
    /// `raw_image_visible` drops sensor margins that this reader keeps). Any
    /// single sample moving changes it; the four spot values beside it exist so
    /// that a failure says *where*.
    ///
    /// Before the fix this plane was 99.9896% pinned at 16383 with only 14 of
    /// 2024 rows carrying any variation.
    #[test]
    fn a_d100_declares_compression_and_is_not_compressed() {
        const F: &str = concat!(
            r"C:\Foo\raw-converter\tests\NEF Raws\",
            "12bit-compressed-other__D100.NEF"
        );
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        let img = decode_nef(&d).expect("D100 decodes");
        assert_eq!((img.width, img.height), (3034, 2024));
        assert_eq!(img.white, 4095, "12-bit, and the reader once called it 14");

        // Every row carries variation. The defect this replaces left 2010 of
        // 2024 rows constant, so this assertion is the one that fails first if
        // the packed path is ever bypassed again.
        let flat = (0..img.height)
            .filter(|&y| {
                let r = &img.raw[y * img.width..(y + 1) * img.width];
                r.iter().all(|&v| v == r[0])
            })
            .count();
        assert_eq!(flat, 0, "{flat} of {} rows are constant", img.height);

        // Spot values from LibRaw, so a hash mismatch is diagnosable.
        assert_eq!(&img.raw[..8], &[386, 85, 182, 63, 221, 82, 208, 77]);
        assert_eq!(&img.raw[1011 * 3034..1011 * 3034 + 4], &[531, 602, 329, 614]);
        assert_eq!(*img.raw.iter().max().unwrap(), 3501);
        assert_eq!(*img.raw.iter().min().unwrap(), 9);

        // The whole plane, sample for sample.
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for v in &img.raw {
            for b in v.to_le_bytes() {
                h = (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        assert_eq!(
            h, 0xde21_bb64_c23a_9a3f,
            "plane differs from the LibRaw reference"
        );
    }

    /// **The discriminator must be able to say no**, or it is not a check.
    ///
    /// Two shapes it has to reject: a strip whose 16th bytes are not all zero
    /// (a real Huffman stream), and one whose row length is not a multiple of
    /// 16 (no block structure to read). The corpus supplies the first case for
    /// real — the D810 and both D4s small-raw fixtures reach this test and are
    /// rejected by it — but a unit test that carries its own counter-example
    /// fails on a machine with no fixtures too.
    #[test]
    fn packed_in_disguise_rejects_a_stream_that_is_actually_compressed() {
        // 2 rows x 32 bytes, pad bytes zero: accepted, and unpacks.
        let mut good = vec![0u8; 64];
        for (i, b) in good.iter_mut().enumerate() {
            *b = if i % 16 == 15 { 0 } else { (i * 7 % 251) as u8 };
        }
        let per_row = 32 / 16 * 15 * 8 / 12; // 20 samples
        assert!(nikon_packed_in_disguise(&good, per_row, 2, 12, 0, 64).is_some());

        // One pad byte set, anywhere: refused.
        for spoil in [15usize, 31, 47, 63] {
            let mut bad = good.clone();
            bad[spoil] = 1;
            assert!(
                nikon_packed_in_disguise(&bad, per_row, 2, 12, 0, 64).is_none(),
                "a nonzero pad byte at {spoil} must send this to the Huffman path"
            );
        }

        // Row length not a multiple of 16: refused rather than guessed at.
        let odd = vec![0u8; 60];
        assert!(nikon_packed_in_disguise(&odd, 4, 2, 12, 0, 60).is_none());

        // A width the payload cannot fill: refused rather than padded.
        assert!(nikon_packed_in_disguise(&good, per_row + 1, 2, 12, 0, 64).is_none());
    }

    /// A genuinely compressed sibling must keep taking the Huffman path.
    ///
    /// The new branch sits in front of `nikon_compressed`, so the failure mode
    /// it could introduce is stealing files from it. The D70 is the closest
    /// neighbour: same era, same declared compression, and it decodes
    /// sample-exact against LibRaw today.
    #[test]
    fn the_packed_branch_does_not_steal_a_real_compressed_nef() {
        const F: &str =
            concat!(r"C:\Foo\raw-converter\tests\NEF Raws\", "12bit-lossy-type1__D70.NEF");
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        let img = decode_nef(&d).expect("D70 decodes");
        assert_eq!((img.width, img.height), (3040, 2014));

        let off = img.strip.start;
        let len = img.strip.end - img.strip.start;
        assert!(
            nikon_packed_in_disguise(&d, img.width, img.height, 12, off, len).is_none(),
            "the D70's strip is a Huffman stream and must not read as packed"
        );
    }
}
