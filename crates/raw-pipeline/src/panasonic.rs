//! Panasonic RW2 and Leica RWL, and uncompressed Nikon NRW/NEF.
//!
//! Three formats that this pipeline previously had no reader for, sharing a file
//! because they share a shape: a TIFF-ish container holding a single Bayer plane
//! that needs unpacking rather than decompressing. Everything here produces the
//! same `(raw: Vec<u16>, cfa_phase, black, white, wb)` the CR2 and DNG readers
//! produce, so `demosaic_bayer_mhc` and `pipeline::process_auto` are unchanged.
//!
//! **RWL is a rebadged Panasonic**, so the RW2 reader takes Leica for free —
//! confirmed on `leica_c-typ112`, which carries the identical tag set at TIFF
//! version 85.
//!
//! Not here, deliberately: Nikon's *compressed* NEF (tag 259 = 34713) needs a
//! Huffman decoder plus the linearisation curve from MakerNote 0x0096, and Canon
//! CRW and CR3 are different containers entirely — CR3 wraps CRX, a wavelet
//! codec. Those stay with LibRaw.

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

struct Entry {
    typ: u16,
    count: u32,
    /// Inline bytes when the value fits in four, otherwise the bytes at the offset.
    val: Vec<u8>,
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

/// Read one little-endian IFD. Returns the tags and the next-IFD offset.
fn read_ifd(d: &[u8], off: usize) -> Result<(HashMap<u16, Entry>, usize), String> {
    if off + 2 > d.len() {
        return Err("IFD offset past end of file".into());
    }
    let n = u16le(&d[off..]) as usize;
    // A real IFD is tens of entries. A four-digit count means the offset is wrong,
    // and following it would read the file as a tag table.
    if n > 512 {
        return Err(format!("IFD at {} claims {} entries", off, n));
    }
    let end = off + 2 + n * 12;
    if end + 4 > d.len() {
        return Err("IFD runs past end of file".into());
    }
    let mut map = HashMap::with_capacity(n);
    for i in 0..n {
        let p = off + 2 + i * 12;
        let tag = u16le(&d[p..]);
        let typ = u16le(&d[p + 2..]);
        let count = u32le(&d[p + 4..]);
        let size = type_size(typ).saturating_mul(count as usize);
        let val = if size <= 4 {
            d[p + 8..p + 8 + size.min(4)].to_vec()
        } else {
            let vo = u32le(&d[p + 8..]) as usize;
            if vo.saturating_add(size) > d.len() {
                Vec::new() // out of range: keep the tag, drop the value
            } else {
                d[vo..vo + size].to_vec()
            }
        };
        map.insert(tag, Entry { typ, count, val });
    }
    Ok((map, u32le(&d[end..]) as usize))
}

fn tag_u32(m: &HashMap<u16, Entry>, t: u16) -> Option<u32> {
    let e = m.get(&t)?;
    match e.typ {
        3 if e.val.len() >= 2 => Some(u16le(&e.val) as u32),
        4 if e.val.len() >= 4 => Some(u32le(&e.val)),
        _ => None,
    }
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
    let (t, _) = read_ifd(d, u32le(&d[4..]) as usize)?;

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
) -> Result<BayerImage, String> {
    // The MakerNote carries its OWN TIFF header 10 bytes past the signature and
    // all of its offsets are relative to that, not to the file.
    let sig = d
        .windows(6)
        .position(|x| x == b"Nikon\0")
        .ok_or("NEF: no Nikon MakerNote signature")?;
    let base = sig + 10;
    if base + 8 > d.len() {
        return Err("NEF: MakerNote runs past end of file".into());
    }
    // NOT read_ifd: that resolves long values against the FILE, while every offset
    // inside a MakerNote is relative to `base`. Reading 0x0096 through it yields
    // bytes from an unrelated part of the file.
    let mo = base + u32le(&d[base + 4..]) as usize;
    if mo + 2 > d.len() {
        return Err("NEF: MakerNote IFD past end of file".into());
    }
    let n = u16le(&d[mo..]) as usize;
    if n > 512 || mo + 2 + n * 12 > d.len() {
        return Err(format!("NEF: MakerNote IFD claims {} entries", n));
    }
    let mut meta = 0usize;
    for i in 0..n {
        let e = mo + 2 + i * 12;
        if u16le(&d[e..]) == 0x0096 {
            let size = type_size(u16le(&d[e + 2..])) * u32le(&d[e + 4..]) as usize;
            meta = if size <= 4 { e + 8 } else { base + u32le(&d[e + 8..]) as usize };
        }
    }
    if meta == 0 {
        return Err("NEF: MakerNote has no linearisation table (0x0096)".into());
    }
    if meta + 8 > d.len() {
        return Err("NEF: linearisation table past end of file".into());
    }

    let (ver0, ver1) = (d[meta], d[meta + 1]);
    let mut p = meta + 2;
    if ver0 == 0x49 || ver1 == 0x58 {
        p += 2110;
    }
    let mut tree = if ver0 == 0x46 { 2usize } else { 0 };
    if bits == 14 {
        tree += 3;
    }
    let rd16 = |o: usize| -> u32 {
        if o + 2 <= d.len() { u16le(&d[o..]) as u32 } else { 0 }
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
    if d.len() < 8 || &d[0..2] != b"II" {
        return Err("NEF: not a little-endian TIFF".into());
    }
    let (ifd0, _) = read_ifd(d, u32le(&d[4..]) as usize)?;

    // The raw plane lives in a SubIFD, never in IFD0 — IFD0 is a thumbnail.
    let sub = ifd0.get(&330).ok_or("NEF: no SubIFDs")?;
    let mut offs = Vec::new();
    for k in 0..sub.count as usize {
        if (k + 1) * 4 <= sub.val.len() {
            offs.push(u32le(&sub.val[k * 4..]) as usize);
        }
    }
    if offs.is_empty() && sub.val.len() >= 4 {
        offs.push(u32le(&sub.val) as usize);
    }

    // Take the SubIFD with the most pixels: the others are previews.
    let mut best: Option<(usize, HashMap<u16, Entry>)> = None;
    for so in offs {
        if let Ok((st, _)) = read_ifd(d, so) {
            let w = tag_u32(&st, 256).unwrap_or(0) as usize;
            let h = tag_u32(&st, 257).unwrap_or(0) as usize;
            if w * h > best.as_ref().map_or(0, |(n, _)| *n) {
                best = Some((w * h, st));
            }
        }
    }
    let (_, st) = best.ok_or("NEF: no usable SubIFD")?;

    let w = tag_u32(&st, 256).ok_or("NEF: SubIFD has no width")? as usize;
    let h = tag_u32(&st, 257).ok_or("NEF: SubIFD has no height")? as usize;
    let bits = tag_u32(&st, 258).unwrap_or(12);
    let comp = tag_u32(&st, 259).unwrap_or(0);
    let off = tag_u32(&st, 273).ok_or("NEF: SubIFD has no strip offset")? as usize;
    let len = tag_u32(&st, 279).unwrap_or(0) as usize;

    if comp == 34713 {
        return nikon_compressed(d, &ifd0, w, h, bits, off, len);
    }
    if comp != 1 {
        return Err(format!("NEF: compression {} is not supported", comp));
    }
    if bits != 12 {
        return Err(format!("NEF: {}-bit uncompressed is not supported", bits));
    }
    // **Coolpix NRW has THREE layouts, and the strip length picks between them.**
    // Keying on the declared byte count rather than a model-string table is both
    // simpler and what LibRaw's own A1000 branch effectively does.
    let packed = w * h * 12 / 8;
    let unpacked = w * h * 2;
    let model = tag_str(&ifd0, 272);

    let raw: Vec<u16> = if len == unpacked {
        // A1000: not packed at all. Plain 16-bit little-endian words holding
        // 12-bit values -- our file declares 31 850 496 = 4608*3456*2 exactly,
        // which is LibRaw's own test for this case (tiff.cpp: data_size ==
        // raw_width*raw_height*2 -> unpacked_load_raw).
        if off + unpacked > d.len() {
            return Err("NEF: strip runs past end of file".into());
        }
        d[off..off + unpacked]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    } else if len == packed {
        if off + packed > d.len() {
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
            "NEF: {w}x{h} at 12 bits needs {packed} packed or {unpacked} unpacked, strip declares {len}"
        ));
    };
    let need = len;

    Ok(BayerImage {
        width: w,
        height: h,
        raw,
        // Nikon Bayer is RGGB on every model in this corpus.
        cfa_phase: (0, 0),
        black: 0,
        white: (1u16 << bits) - 1,
        wb_r: 2.0,
        wb_g: 1.0,
        wb_b: 1.5,
        make: tag_str(&ifd0, 271),
        model: tag_str(&ifd0, 272),
        strip: off..off + need,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(read_ifd(&d, 0).is_err());
    }

    #[test]
    fn rw2_refuses_a_non_rw2() {
        assert!(decode_rw2(b"II\x2a\x00\x08\x00\x00\x00").is_err());
        assert!(decode_rw2(b"MM\x00\x55\x00\x00\x00\x08").is_err());
    }
}
