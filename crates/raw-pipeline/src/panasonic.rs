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
    fn fill(&mut self) {
        let lf = self.load_flags;
        self.buf[..0x4000].fill(0);
        let n1 = self.src.len().saturating_sub(self.pos).min(0x4000 - lf);
        self.buf[lf..lf + n1].copy_from_slice(&self.src[self.pos..self.pos + n1]);
        self.pos += n1;
        let n2 = self.src.len().saturating_sub(self.pos).min(lf);
        self.buf[..n2].copy_from_slice(&self.src[self.pos..self.pos + n2]);
        self.pos += n2;
    }

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
    // the sensor grid and the borders are part of it.
    let mut full = vec![0u16; sensor_w * sensor_h];
    // load_flags is a function of RawFormat; 0x2008 is the value for format 4,
    // which is the only one accepted above.
    let mut bits_rd = PanaBits::new(&d[raw_off..], 0x2008);
    for row in 0..sensor_h {
        let (mut pred, mut nonz) = ([0i32; 2], [0i32; 2]);
        let mut sh = 0u32;
        for col in 0..sensor_w {
            let i = col % 14;
            if i == 0 {
                pred = [0, 0];
                nonz = [0, 0];
            }
            if i % 3 == 2 {
                sh = 4 >> (3 - bits_rd.get(2));
            }
            let k = i & 1;
            if nonz[k] != 0 {
                let j = bits_rd.get(8) as i32;
                if j != 0 {
                    pred[k] -= 0x80 << sh;
                    if pred[k] < 0 || sh == 4 {
                        pred[k] &= !((-1i32) << sh);
                    }
                    pred[k] += j << sh;
                }
            } else {
                nonz[k] = bits_rd.get(8) as i32;
                if nonz[k] != 0 || i > 11 {
                    pred[k] = (nonz[k] << 4) | bits_rd.get(4) as i32;
                }
            }
            full[row * sensor_w + col] = pred[k].clamp(0, 65535) as u16;
        }
    }

    // Crop to the active area. The CFA phase is defined on the sensor grid, so
    // an odd border flips it — get this wrong and the image is colour-swapped
    // with no other symptom, which is exactly the silent failure this pipeline's
    // own avx2 module warns about for deinterleave.
    let (px, py) = pana_cfa_phase(cfa);
    let phase = ((px as usize + left) as u8 & 1, (py as usize + top) as u8 & 1);
    let mut raw = vec![0u16; img_w * img_h];
    for y in 0..img_h {
        let sy = y + top;
        if sy >= sensor_h {
            break;
        }
        let s = sy * sensor_w + left;
        let n = img_w.min(sensor_w - left);
        raw[y * img_w..y * img_w + n].copy_from_slice(&full[s..s + n]);
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
/// dcraw's `nikon_tree`. The arrays are 32 wide and **zero-padded on purpose**:
/// the length counts sum to one more than the symbols listed, so the builder
/// reads a final symbol 0 out of the padding. Transcribing only the printed
/// symbols overruns the array.
#[rustfmt::skip]
const NIKON_TREE: [[u8; 32]; 6] = [
    // 12-bit lossy
    [0,1,5,1,1,1,1,1,1,2,0,0,0,0,0,0, 5,4,3,6,2,7,1,0,8,9,11,10,12, 0,0,0],
    // 12-bit lossy, after the split
    [0,1,5,1,1,1,1,1,1,2,0,0,0,0,0,0, 0x39,0x5a,0x38,0x27,0x16,5,4,3,2,1,0,11,12,12,0,0],
    // 12-bit lossless
    [0,1,4,2,3,1,2,0,0,0,0,0,0,0,0,0, 5,4,6,3,7,2,8,1,9,0,10,11,12, 0,0,0],
    // 14-bit lossy
    [0,1,4,3,1,1,1,1,1,2,0,0,0,0,0,0, 5,6,4,7,8,3,9,2,1,0,10,11,12,13,14, 0],
    // 14-bit lossy, after the split
    [0,1,5,1,1,1,1,1,1,1,2,0,0,0,0,0, 8,0x5c,0x4b,0x3a,0x29,7,6,5,4,3,2,1,0,13,14, 0],
    // 14-bit lossless
    [0,1,4,2,2,3,1,2,0,0,0,0,0,0,0,0, 7,6,8,5,9,4,10,3,11,12,2,0,1,13,14, 0],
];

/// dcraw `make_decoder_ref`: a flat lookup indexed by the next `max` bits, each
/// slot holding `len << 8 | symbol`. `count[len]` is `tree[len - 1]`.
fn make_decoder(tree: &[u8; 32]) -> Vec<u16> {
    let mut max = 16usize;
    while max > 0 && tree[max - 1] == 0 {
        max -= 1;
    }
    let mut huff = vec![0u16; 1 + (1 << max)];
    huff[0] = max as u16;
    let (mut h, mut src) = (1usize, 16usize);
    for len in 1..=max {
        for _ in 0..tree[len - 1] {
            let sym = tree[src] as u16;
            src += 1;
            for _ in 0..(1usize << (max - len)) {
                if h <= (1 << max) {
                    huff[h] = ((len as u16) << 8) | sym;
                    h += 1;
                }
            }
        }
    }
    huff
}

/// MSB-first bit reader over the strip. Unlike `PanaBits` this is a plain
/// forward reader; Nikon does not page or reverse anything.
struct NikonBits<'a> {
    d: &'a [u8],
    p: usize,
    buf: u64,
    vbits: u32,
}

impl<'a> NikonBits<'a> {
    fn new(d: &'a [u8]) -> Self {
        NikonBits { d, p: 0, buf: 0, vbits: 0 }
    }
    fn fill(&mut self, n: u32) {
        while self.vbits < n {
            let c = *self.d.get(self.p).unwrap_or(&0) as u64;
            self.p += 1;
            self.buf = (self.buf << 8) | c;
            self.vbits += 8;
        }
    }
    fn get(&mut self, nbits: u32) -> u32 {
        if nbits == 0 {
            return 0;
        }
        self.fill(nbits);
        let v = ((self.buf >> (self.vbits - nbits)) & ((1u64 << nbits) - 1)) as u32;
        self.vbits -= nbits;
        v
    }
    fn huff(&mut self, huff: &[u16]) -> u16 {
        let n = huff[0] as u32;
        self.fill(n);
        let c = ((self.buf >> (self.vbits - n)) & ((1u64 << n) - 1)) as usize;
        let v = huff[1 + c];
        self.vbits -= (v >> 8) as u32;
        v & 0xff
    }
}

/// Nikon's compressed NEF (259 == 34713): a Huffman-coded DPCM over two
/// vertical predictors, then a linearisation curve read from MakerNote 0x0096.
///
/// Transcribed from dcraw `nikon_load_raw` and validated against ImageMagick
/// before it was written: r = 0.9408 on `nikon_1-j1_DSC0355.NEF`.
fn nikon_compressed(
    d: &[u8],
    _ifd0: &HashMap<u16, Entry>,
    w: usize,
    h: usize,
    bits: u32,
    off: usize,
    _len: usize,
    // The FILE's byte order. Needed only for the unsigned-MakerNote fallback,
    // whose offsets are file-relative; a signed MakerNote carries its own.
    e: End,
) -> Result<BayerImage, String> {
    // **Nikon has written two MakerNote shapes and both appear in this corpus.**
    //
    // The modern one is signed: `Nikon\0`, then a version, then a COMPLETE TIFF
    // header ten bytes in, with every internal offset measured from that header.
    //
    // The D1-series one has no signature and no header at all — the MakerNote
    // value simply *is* an IFD, in the file's byte order, with offsets measured
    // from the file. Scanning for `Nikon\0` finds nothing in a D1X and the whole
    // decode was refused for want of a string.
    //
    // The signed form is still found by scan rather than by tag, because that is
    // what worked for every file before today and a scan cannot regress on them.
    // Only the fallback needs the tag walk.
    let (mo, base, me) = if let Some(sig) = d.windows(6).position(|x| x == b"Nikon\0") {
        let base = sig + 10;
        if base + 8 > d.len() {
            return Err("NEF: MakerNote runs past end of file".into());
        }
        let me = End::of(&d[base..]).ok_or("NEF: MakerNote has no II/MM byte-order mark")?;
        (base + me.u32(&d[base + 4..]) as usize, base, me)
    } else {
        // Unsigned: ExifIFD (0x8769) -> MakerNote (0x927C). `voff` is the whole
        // point — the IFD starts exactly where the value does.
        let ex = tag_u32(_ifd0, 0x8769).ok_or("NEF: no MakerNote and no ExifIFD to find one")?;
        let (exif, _) = read_ifd(d, ex as usize, e)?;
        let mn = exif
            .get(&0x927C)
            .ok_or("NEF: no Nikon MakerNote signature and no MakerNote tag")?;
        (mn.voff, 0, e)
    };
    if mo + 2 > d.len() {
        return Err("NEF: MakerNote IFD past end of file".into());
    }
    // NOT read_ifd: that resolves long values against the FILE, while a signed
    // MakerNote's offsets are relative to `base`. Reading 0x0096 through it
    // yields bytes from an unrelated part of the file. `base` is 0 for the
    // unsigned form, which makes the two cases one arithmetic.
    let n = me.u16(&d[mo..]) as usize;
    if n > 512 || mo + 2 + n * 12 > d.len() {
        return Err(format!("NEF: MakerNote IFD claims {} entries", n));
    }
    let (mut meta, mut meta_size) = (0usize, 0usize);
    for i in 0..n {
        let e = mo + 2 + i * 12;
        // **Two tags have held this table.** `0x0096` is the modern
        // `NEFLinearizationTable`; the D1 series predates it and carries the
        // curve at `0x008C`. A D1X has 28 MakerNote entries and not one of them
        // is 0x0096, which is why it was refused for want of a table it never
        // had.
        //
        // Accepting both, last-wins, is right rather than merely convenient:
        // IFD entries are in ascending tag order, so on a body carrying both —
        // where 0x008C is a contrast curve and not a linearisation table —
        // 0x0096 is seen second and overwrites. Same resolution dcraw reaches.
        if matches!(me.u16(&d[e..]), 0x0096 | 0x008c) {
            let size = type_size(me.u16(&d[e + 2..])) * me.u32(&d[e + 4..]) as usize;
            meta = if size <= 4 { e + 8 } else { base + me.u32(&d[e + 8..]) as usize };
            meta_size = size;
        }
    }
    if meta == 0 {
        return Err("NEF: MakerNote has no linearisation table (0x0096 or 0x008c)".into());
    }
    if meta + 8 > d.len() {
        return Err("NEF: linearisation table past end of file".into());
    }

    let (ver0, ver1) = (d[meta], d[meta + 1]);
    let mut p = meta + 2;
    if ver0 == 0x49 || ver1 == 0x58 {
        p += 2110;
    }
    // **The skip must land inside the blob, and on some bodies it does not.**
    //
    // A D810 or a Z 6 III carries a 578-byte structure at 0x008C that is NOT a
    // linearisation table — the giveaway is that the same 578-byte `49 30` blob
    // also sits on a D3 and a D6 *alongside* their real 0x0096, where tag order
    // makes 0x0096 win. On a body that has only the 578-byte one, `ver0 == 0x49`
    // sends this 2110 bytes forward, well past the end of it, and the vertical
    // predictors and curve are then read from whatever the file happens to hold
    // next.
    //
    // That decodes without error and is wrong, which is the failure mode this
    // file has already produced twice. Refusing is the honest answer: those
    // bodies need their real table found, not this one misread.
    if p + 8 > meta + meta_size {
        return Err(format!(
            "NEF: the {meta_size}-byte curve at this MakerNote tag is too small for a version \
             {ver0:#04x}{ver1:02x} linearisation table — this body stores its table elsewhere, \
             and reading past the blob would decode a plausible but wrong image"
        ));
    }
    let mut tree = if ver0 == 0x46 { 2usize } else { 0 };
    if bits == 14 {
        tree += 3;
    }
    // The linearisation table and the vertical predictors live inside the
    // MakerNote, so they are read in ITS order, not the file's.
    let rd16 = |o: usize| -> u32 {
        if o + 2 <= d.len() { me.u16(&d[o..]) as u32 } else { 0 }
    };
    let mut vpred = [[0i32; 2]; 2];
    for a in 0..2 {
        for b in 0..2 {
            vpred[a][b] = rd16(p) as i32;
            p += 2;
        }
    }
    let mut max = ((1u32 << bits) & 0x7fff) as usize;
    let mut curve: Vec<u16> = (0..0x8000u32).map(|i| i as u16).collect();
    let csize = rd16(p) as usize;
    p += 2;
    let step = if csize > 1 { max / (csize - 1) } else { 0 };
    let mut split = 0usize;
    if ver0 == 0x44 && ver1 == 0x20 && step > 0 {
        for i in 0..csize {
            curve[i * step] = rd16(p) as u16;
            p += 2;
        }
        for i in 0..max {
            let r = i % step;
            curve[i] = ((curve[i - r] as usize * (step - r)
                + curve[i - r + step] as usize * r)
                / step) as u16;
        }
        split = rd16(meta + 562) as usize;
    } else if ver0 != 0x46 && csize <= 0x4001 {
        max = csize;
        for i in 0..csize {
            curve[i] = rd16(p) as u16;
            p += 2;
        }
    }
    // A zero curve-size in the `csize <= 0x4001` branch leaves max == 0, and
    // `curve[max - 1]` below would underflow-panic on that crafted input.
    if max == 0 {
        return Err("NEF: empty linearisation curve".into());
    }
    while max > 2 && curve[max - 2] == curve[max - 1] {
        max -= 1;
    }

    if off >= d.len() {
        return Err("NEF: strip offset past end of file".into());
    }
    let mut huff = make_decoder(&NIKON_TREE[tree]);
    let mut bs = NikonBits::new(&d[off..]);
    let mut out = vec![0u16; w * h];
    let mut hpred = [0i32; 2];
    for row in 0..h {
        if split != 0 && row == split {
            huff = make_decoder(&NIKON_TREE[tree + 1]);
        }
        for col in 0..w {
            let i = bs.huff(&huff);
            let len = (i & 15) as u32;
            let shl = (i >> 4) as u32;
            let mut diff = ((((bs.get(len - shl.min(len)) << 1) + 1) << shl) >> 1) as i32;
            if len > 0 && (diff & (1 << (len - 1))) == 0 {
                diff -= (1 << len) - if shl != 0 { 0 } else { 1 };
            }
            if col < 2 {
                vpred[row & 1][col] += diff;
                hpred[col] = vpred[row & 1][col];
            } else {
                hpred[col & 1] += diff;
            }
            out[row * w + col] = curve[hpred[col & 1].clamp(0, 0x3fff) as usize];
        }
    }

    Ok(BayerImage {
        width: w,
        height: h,
        raw: out,
        cfa_phase: (0, 0),
        black: 0,
        white: curve[max - 1],
        wb_r: 2.0,
        wb_g: 1.0,
        wb_b: 1.5,
        make: tag_str(_ifd0, 271),
        model: tag_str(_ifd0, 272),
        // Nikon declares the compressed strip length outright, so no cursor
        // arithmetic is needed here.
        strip: off..off + _len,
    })
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
    if comp == 34713 {
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
        return nikon_compressed(d, &ifd0, w, h, bits, off, len, e);
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
        // Nikon Bayer is RGGB on every model in this corpus.
        cfa_phase: (0, 0),
        black: 0,
        // `1u16 << 16` overflows; the widest legal white is u16::MAX.
        white: ((1u32 << bits) - 1).min(u16::MAX as u32) as u16,
        wb_r: 2.0,
        wb_g: 1.0,
        wb_b: 1.5,
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
    #[test]
    fn an_undersized_curve_blob_is_refused() {
        for name in ["12bit-small-raw__D810", "8bit-compressed-other__Z6_3"] {
            let p = format!(r"C:\Foo\raw-converter\tests\NEF Raws\{name}.NEF");
            let Ok(d) = std::fs::read(&p) else {
                eprintln!("skipped: {p} not present");
                continue;
            };
            let e = decode_nef(&d).expect_err("must refuse rather than misread");
            assert!(e.contains("too small"), "{name}: unhelpful refusal: {e}");
        }
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
}
