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
        return Err(
            "NEF: compressed (34713) needs the Nikon Huffman decoder and the \
             linearisation curve from MakerNote 0x0096 — not implemented"
                .into(),
        );
    }
    if comp != 1 {
        return Err(format!("NEF: compression {} is not supported", comp));
    }
    if bits != 12 {
        return Err(format!("NEF: {}-bit uncompressed is not supported", bits));
    }
    let need = w * h * 12 / 8;
    if len != need {
        return Err(format!(
            "NEF: {}x{} at 12 bits packed needs {} bytes, strip declares {} — not packed",
            w, h, need, len
        ));
    }
    if off + need > d.len() {
        return Err("NEF: strip runs past end of file".into());
    }

    // 12-bit big-endian packed: two pixels per three bytes.
    let src = &d[off..off + need];
    let mut raw = vec![0u16; w * h];
    let mut i = 0usize;
    for px in raw.chunks_exact_mut(2) {
        let a = src[i] as u16;
        let b = src[i + 1] as u16;
        let c = src[i + 2] as u16;
        px[0] = (a << 4) | (b >> 4);
        px[1] = ((b & 0x0f) << 8) | c;
        i += 3;
    }

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
