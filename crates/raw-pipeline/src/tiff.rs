//! TIFF/ORF IFD parser. Hand-rolled for Olympus Raw Format.
//!
//! Olympus ORF uses TIFF container with non-standard magic bytes (IIRO/IIRS/IIUS).
//! We walk IFD0 to find image dimensions, strip offset, compression mode, and
//! descend into Exif IFD → Olympus MakerNote IFD for white balance and black level.

use anyhow::{anyhow, bail, Result};

#[derive(Debug, Clone)]
pub struct OrfInfo {
    pub width: u32,
    pub height: u32,
    pub bits_per_sample: u16,
    pub compression: u16,
    pub strip_offset: u32,
    pub strip_byte_count: u32,
    pub orientation: u16,
    pub make: String,
    pub model: String,
    pub wb_r: Option<f32>,
    pub wb_b: Option<f32>,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    #[allow(dead_code)]
    pub black_level: u16,
    #[allow(dead_code)]
    pub little_endian: bool,
    // Olympus CameraSettings WhiteBalance2 mode (0x0500). When set to a
    // user-defined mode (One-Touch/Custom 256-259, 512-515) the stored
    // 0x0100 WB_RBLevels is a fixed calibration that won't match per-shot
    // lighting — caller can choose to discard it and gray-world instead.
    pub wb_mode: Option<u16>,
    pub lens: String,
    pub datetime: String,
    pub exposure: Option<(u32, u32)>,
    pub fnumber: Option<(u32, u32)>,
    pub iso: Option<u32>,
    pub focal_length: Option<(u32, u32)>,
    pub focal_length_35: Option<u16>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub gps_alt: Option<f64>,
    pub quality: Option<u16>,
}

/// Common metadata extracted from any supported RAW format. Normalizes
/// per-format field types (u32→usize for dims, Option<f32>→f32 for WB).
#[derive(Debug, Clone)]
pub struct RawImageMeta {
    pub width: usize,
    pub height: usize,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub orientation: u16,
    pub make: String,
    pub model: String,
}

impl OrfInfo {
    pub fn meta(&self) -> RawImageMeta {
        RawImageMeta {
            width: self.width as usize,
            height: self.height as usize,
            wb_r: self.wb_r.unwrap_or(1.0),
            wb_g: 1.0,
            wb_b: self.wb_b.unwrap_or(1.0),
            color_matrix: self.color_matrix,
            orientation: self.orientation,
            make: self.make.clone(),
            model: self.model.clone(),
        }
    }
}

/// Scan the first 3 MB of `data` for JPEG SOI markers (0xFF 0xD8 0xFF) and
/// return the largest valid JPEG found (SOI … EOI inclusive).  Mirrors the
/// wasm frontend's `extractEmbeddedJpegs` Phase-A logic.  Olympus ORF files
/// embed a full-size preview JPEG in the first ~1–2 MB; this finds it without
/// a full IFD parse.
pub fn extract_largest_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    let scan_end = data.len().min(3 * 1024 * 1024);
    let chunk = &data[..scan_end];
    let mut sois: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i + 2 < chunk.len() {
        if chunk[i] == 0xFF && chunk[i + 1] == 0xD8 && chunk[i + 2] == 0xFF {
            sois.push(i);
            i += 2;
        } else {
            i += 1;
        }
    }
    let mut best: Option<&[u8]> = None;
    for n in 0..sois.len() {
        let start = sois[n];
        // Search for this candidate's EOI (0xFF 0xD9) scanning BACKWARDS from the end
        // of the buffer. We do NOT cap at sois[n+1] because a real preview JPEG often
        // embeds a thumbnail (inner FFD8…FFD9), and capping would stop at the inner SOI
        // returning a truncated blob. The true outermost EOI lies after any nested SOIs.
        // Taking the last FFD9 in the whole remaining buffer gives the correct outer EOI.
        let search_end = scan_end;
        let mut eoi = None;
        let mut j = search_end.saturating_sub(1);
        while j > start + 1 {
            if chunk[j - 1] == 0xFF && chunk[j] == 0xD9 {
                eoi = Some(j + 1);
                break;
            }
            j -= 1;
        }
        if let Some(eoi_end) = eoi {
            let blob = &chunk[start..eoi_end];
            if best.map_or(true, |b: &[u8]| blob.len() > b.len()) {
                best = Some(blob);
            }
        }
    }
    best.map(|b| b.to_vec())
}

/// Extract the small thumbnail JPEG from the IFD1 block (standard TIFF thumbnail
/// pointer: tag 0x0201 = byte offset, 0x0202 = byte length).  Returns None if
/// IFD1 is absent or the tags are missing.
pub fn extract_thumbnail_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 8 {
        return None;
    }
    let (le, ifd0_offset) = parse_header(data).ok()?;
    let r = Reader { data, le };
    // Skip past IFD0 entries to reach the next-IFD pointer.
    let off = ifd0_offset as usize;
    let count = (r.u16(off).ok()? as usize).min(512);
    let next_ptr_off = off + 2 + count * 12;
    let ifd1_offset = r.u32(next_ptr_off).ok()?;
    if ifd1_offset == 0 {
        return None;
    }
    // IFD1 — find JPEGInterchangeFormat (0x0201) and JPEGInterchangeFormatLength (0x0202).
    let ifd1 = read_ifd(&r, ifd1_offset).ok()?;
    let mut jpeg_off: Option<u32> = None;
    let mut jpeg_len: Option<u32> = None;
    for entry in &ifd1 {
        match entry.tag {
            0x0201 => jpeg_off = entry.as_u32(&r).ok(),
            0x0202 => jpeg_len = entry.as_u32(&r).ok(),
            _ => {}
        }
    }
    let start = jpeg_off? as usize;
    let len = jpeg_len? as usize;
    if len == 0 {
        return None;
    }
    // Cap at 8 MiB — a TIFF thumbnail is never this large; crafted headers could
    // point at multi-GB regions and trigger OOM-equivalent allocations.
    const MAX_THUMBNAIL_JPEG_BYTES: usize = 8 * 1024 * 1024;
    if len > MAX_THUMBNAIL_JPEG_BYTES {
        return None;
    }
    // SEC-012: start + len can overflow usize on wasm32 for crafted values.
    let end = start.checked_add(len)?;
    let slice = data.get(start..end)?;
    // Basic SOI/EOI content validation — reject blobs that are clearly not JPEG.
    if slice.len() < 4 || slice[0] != 0xFF || slice[1] != 0xD8 {
        return None;
    }
    Some(slice.to_vec())
}

/// Scan the first 3 MB of `data` for JPEG SOI markers and return the smallest
/// valid JPEG that is at least `min_bytes` in size.  The smallest JPEG in an
/// ORF file is reliably the embedded thumbnail (a few KB) rather than the
/// full-size preview (1–2 MB).  `min_bytes` guards against tiny EXIF blobs.
pub fn extract_smallest_jpeg(data: &[u8], min_bytes: usize) -> Option<Vec<u8>> {
    let scan_end = data.len().min(3 * 1024 * 1024);
    let chunk = &data[..scan_end];
    let mut sois: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i + 2 < chunk.len() {
        if chunk[i] == 0xFF && chunk[i + 1] == 0xD8 && chunk[i + 2] == 0xFF {
            sois.push(i);
            i += 2;
        } else {
            i += 1;
        }
    }
    let mut best: Option<&[u8]> = None;
    for n in 0..sois.len() {
        let start = sois[n];
        let end = if n + 1 < sois.len() {
            sois[n + 1]
        } else {
            scan_end
        };
        let mut eoi = None;
        let mut j = end.saturating_sub(1);
        while j > start + 1 {
            if chunk[j - 1] == 0xFF && chunk[j] == 0xD9 {
                eoi = Some(j + 1);
                break;
            }
            j -= 1;
        }
        if let Some(eoi_end) = eoi {
            let blob = &chunk[start..eoi_end];
            if blob.len() >= min_bytes && best.map_or(true, |b: &[u8]| blob.len() < b.len()) {
                best = Some(blob);
            }
        }
    }
    best.map(|b| b.to_vec())
}

/// Reads orientation (0x0112), width (0x0100), and height (0x0101) from IFD0
/// without requiring strip tags to be valid.  Returns (orientation, width,
/// height); orientation defaults to 1, width/height default to 0 on parse error.
/// Used by the fast-thumb emit so the frontend can pre-size the grid canvas
/// to the eventual RAW-thumb dims before the full pipeline runs.
pub fn parse_orientation_and_dims(data: &[u8]) -> (u16, u32, u32) {
    let Ok((le, ifd0_offset)) = parse_header(data) else {
        return (1, 0, 0);
    };
    let r = Reader { data, le };
    let off = ifd0_offset as usize;
    let Ok(count) = r.u16(off) else {
        return (1, 0, 0);
    };
    let count = (count as usize).min(512);
    let mut orientation: u16 = 1;
    let mut width: u32 = 0;
    let mut height: u32 = 0;
    // Read tag value handling both SHORT (type 3) and LONG (type 4) inline.
    let read_val = |e: usize| -> Option<(u16, u32)> {
        let dtype = r.u16(e + 2).ok()?;
        let val_off = r.u32(e + 8).ok()?;
        let val = match dtype {
            3 => {
                if le {
                    val_off & 0xFFFF
                } else {
                    val_off >> 16
                }
            }
            _ => val_off,
        };
        Some((dtype, val))
    };
    for i in 0..count {
        let e = off + 2 + i * 12;
        let Ok(tag) = r.u16(e) else {
            break;
        };
        match tag {
            0x0112 => {
                if let Some((_, v)) = read_val(e) {
                    orientation = v as u16;
                }
            }
            0x0100 => {
                if let Some((_, v)) = read_val(e) {
                    width = v;
                }
            }
            0x0101 => {
                if let Some((_, v)) = read_val(e) {
                    height = v;
                }
            }
            _ => {}
        }
    }
    (orientation, width, height)
}

/// Reads only IFD0 orientation tag (0x0112). Does not require strip tags to be valid.
/// Used pre-semaphore for the fast thumbnail path. Returns 1 on any parse error.
pub fn parse_orientation(data: &[u8]) -> u16 {
    let Ok((le, ifd0_offset)) = parse_header(data) else {
        return 1;
    };
    let r = Reader { data, le };
    let off = ifd0_offset as usize;
    let Ok(count) = r.u16(off) else {
        return 1;
    };
    let count = (count as usize).min(512);
    for i in 0..count {
        let e = off + 2 + i * 12;
        let Ok(tag) = r.u16(e) else {
            break;
        };
        if tag == 0x0112 {
            let Ok(val) = r.u32(e + 8) else {
                return 1;
            };
            return if le {
                (val & 0xFFFF) as u16
            } else {
                (val >> 16) as u16
            };
        }
    }
    1
}

pub fn parse(data: &[u8]) -> Result<OrfInfo> {
    if data.len() < 8 {
        bail!("file too small ({}B)", data.len());
    }

    let (little_endian, ifd0_offset) = parse_header(data)?;
    let r = Reader {
        data,
        le: little_endian,
    };

    let mut info = OrfInfo {
        width: 0,
        height: 0,
        bits_per_sample: 12,
        compression: 1,
        strip_offset: 0,
        strip_byte_count: 0,
        orientation: 1,
        make: String::new(),
        model: String::new(),
        wb_r: None,
        wb_b: None,
        color_matrix: None,
        black_level: 0,
        little_endian,
        wb_mode: None,
        lens: String::new(),
        datetime: String::new(),
        exposure: None,
        fnumber: None,
        iso: None,
        focal_length: None,
        focal_length_35: None,
        gps_lat: None,
        gps_lon: None,
        gps_alt: None,
        quality: None,
    };

    let ifd0 = read_ifd(&r, ifd0_offset)?;
    let mut exif_offset: u32 = 0;
    let mut gps_offset: u32 = 0;

    for entry in &ifd0 {
        match entry.tag {
            0x0100 => info.width = entry.as_u32(&r)?,
            0x0101 => info.height = entry.as_u32(&r)?,
            0x0102 => info.bits_per_sample = entry.as_u32(&r)? as u16,
            0x0103 => info.compression = entry.as_u32(&r)? as u16,
            0x0111 => info.strip_offset = entry.as_u32(&r)?,
            0x0112 => info.orientation = entry.as_u32(&r)? as u16,
            0x0117 => info.strip_byte_count = entry.as_u32(&r)?,
            0x010F => info.make = entry.as_ascii(&r),
            0x0110 => info.model = entry.as_ascii(&r),
            0x0132 => {
                if info.datetime.is_empty() {
                    info.datetime = entry.as_ascii(&r);
                }
            }
            0x8769 => exif_offset = entry.as_u32(&r)?,
            0x8825 => gps_offset = entry.as_u32(&r)?,
            _ => {}
        }
    }

    if info.width == 0 || info.height == 0 || info.strip_offset == 0 || info.strip_byte_count == 0 {
        bail!(
            "missing required tags (w={}, h={}, strip={}, byte_count={})",
            info.width,
            info.height,
            info.strip_offset,
            info.strip_byte_count,
        );
    }
    // SEC-009 / ERR-017: verify strip bounds before any caller does the slice.
    {
        let strip_start = info.strip_offset as usize;
        let strip_end = strip_start
            .checked_add(info.strip_byte_count as usize)
            .ok_or_else(|| anyhow!("strip range overflow"))?;
        if strip_end > data.len() {
            bail!(
                "strip OOB: strip_offset={} + strip_byte_count={} = {} > data.len()={}",
                info.strip_offset,
                info.strip_byte_count,
                strip_end,
                data.len()
            );
        }
    }

    if exif_offset > 0 {
        if let Ok(exif) = read_ifd(&r, exif_offset) {
            for entry in &exif {
                match entry.tag {
                    0x829A => info.exposure = entry.as_rational(&r),
                    0x829D => info.fnumber = entry.as_rational(&r),
                    0x8827 => info.iso = entry.as_u32(&r).ok(),
                    0x9003 => {
                        if info.datetime.is_empty() || info.datetime.starts_with("0000") {
                            info.datetime = entry.as_ascii(&r);
                        }
                    }
                    0x920A => info.focal_length = entry.as_rational(&r),
                    0xA405 => info.focal_length_35 = entry.as_u32(&r).ok().map(|v| v as u16),
                    0xA434 => {
                        if info.lens.is_empty() {
                            info.lens = entry.as_ascii(&r);
                        }
                    }
                    0x927C => parse_olympus_makernote(&r, entry, &mut info),
                    _ => {}
                }
            }
        }
    }

    if gps_offset > 0 {
        if let Ok(gps) = read_ifd(&r, gps_offset) {
            parse_gps_ifd(&r, &gps, &mut info);
        }
    }

    Ok(info)
}

fn parse_gps_ifd(r: &Reader, entries: &[IfdEntry], info: &mut OrfInfo) {
    let mut lat_ref = b'N';
    let mut lon_ref = b'E';
    let mut alt_ref: u8 = 0;
    let mut lat_dms: Option<[(u32, u32); 3]> = None;
    let mut lon_dms: Option<[(u32, u32); 3]> = None;
    let mut alt: Option<(u32, u32)> = None;
    for e in entries {
        match e.tag {
            0x0001 => {
                let s = e.as_ascii(r);
                if let Some(c) = s.bytes().next() {
                    lat_ref = c;
                }
            }
            0x0002 => lat_dms = e.as_rational_triplet(r),
            0x0003 => {
                let s = e.as_ascii(r);
                if let Some(c) = s.bytes().next() {
                    lon_ref = c;
                }
            }
            0x0004 => lon_dms = e.as_rational_triplet(r),
            0x0005 => alt_ref = e.as_u32(r).unwrap_or(0) as u8,
            0x0006 => alt = e.as_rational(r),
            _ => {}
        }
    }
    let to_deg = |dms: [(u32, u32); 3], r: u8| -> f64 {
        let d = dms[0].0 as f64 / dms[0].1.max(1) as f64;
        let m = dms[1].0 as f64 / dms[1].1.max(1) as f64;
        let s = dms[2].0 as f64 / dms[2].1.max(1) as f64;
        let v = d + m / 60.0 + s / 3600.0;
        if r == b'S' || r == b'W' {
            -v
        } else {
            v
        }
    };
    if let Some(d) = lat_dms {
        info.gps_lat = Some(to_deg(d, lat_ref));
    }
    if let Some(d) = lon_dms {
        info.gps_lon = Some(to_deg(d, lon_ref));
    }
    if let Some((n, d)) = alt {
        let v = n as f64 / d.max(1) as f64;
        info.gps_alt = Some(if alt_ref == 1 { -v } else { v });
    }
}

fn parse_header(data: &[u8]) -> Result<(bool, u32)> {
    if data.len() < 8 {
        bail!("truncated TIFF header: {} bytes", data.len());
    }
    let magic = &data[0..4];
    let le = match magic {
        b"IIRO" | b"IIRS" | b"IIUS" => true,
        [0x49, 0x49, 0x2A, 0x00] => true,
        b"MMOR" | b"MMMR" => false,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        _ => bail!("unknown magic: {:?}", magic),
    };
    let r = Reader { data, le };
    let ifd0 = r.u32(4)?;
    Ok((le, ifd0))
}

#[derive(Clone, Copy)]
struct Reader<'a> {
    data: &'a [u8],
    le: bool,
}

impl<'a> Reader<'a> {
    fn u16(&self, off: usize) -> Result<u16> {
        let b = self
            .data
            .get(off..off + 2)
            .ok_or_else(|| anyhow!("u16 OOB at {:#x}", off))?;
        Ok(if self.le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }

    fn u32(&self, off: usize) -> Result<u32> {
        let b = self
            .data
            .get(off..off + 4)
            .ok_or_else(|| anyhow!("u32 OOB at {:#x}", off))?;
        Ok(if self.le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct IfdEntry {
    tag: u16,
    dtype: u16,
    count: u32,
    value_off: u32,
}

impl IfdEntry {
    fn as_u32(&self, r: &Reader) -> Result<u32> {
        match self.dtype {
            // BYTE (dtype=1): single unsigned byte, always inline in the value field.
            // The first raw byte of the value field is the byte value regardless of
            // endianness (TIFF spec §7, "Value" column). For LE files value_off is
            // stored little-endian so byte[0] is the low byte; for BE it is the high
            // byte of the big-endian u32, i.e. value_off >> 24.
            1 => {
                let byte_val = if r.le {
                    (self.value_off & 0xFF) as u32
                } else {
                    self.value_off >> 24
                };
                Ok(byte_val)
            }
            3 => {
                if self.count <= 2 {
                    // Inline SHORT: count==1 or count==2 both fit in the 4-byte value field.
                    let v = if r.le {
                        self.value_off & 0xFFFF
                    } else {
                        self.value_off >> 16
                    };
                    Ok(v)
                } else {
                    Ok(r.u16(self.value_off as usize)? as u32)
                }
            }
            4 => Ok(self.value_off),
            // PARSERS-006: reject unrecognized dtypes rather than silently treating
            // value_off as a numeric value, which would return nonsense for pointer types
            // (e.g. RATIONAL=5, ASCII=2, UNDEFINED=7) that happen to share a tag.
            _ => bail!(
                "IFD tag {:#06x}: unsupported dtype {} for as_u32",
                self.tag,
                self.dtype
            ),
        }
    }

    fn as_ascii(&self, r: &Reader) -> String {
        if self.count == 0 {
            return String::new();
        }
        if self.count <= 4 {
            // Inline ASCII: the bytes live in the 4-byte value field (TIFF-001).
            // value_off was read as a u32 in file byte order; recover the raw bytes.
            let bytes = if r.le {
                self.value_off.to_le_bytes()
            } else {
                self.value_off.to_be_bytes()
            };
            let n = (self.count as usize).min(4);
            return String::from_utf8_lossy(&bytes[..n])
                .trim_end_matches('\0')
                .trim_end()
                .to_string();
        }
        let start = self.value_off as usize;
        let end = match start.checked_add(self.count as usize) {
            Some(e) if e <= r.data.len() => e,
            _ => return String::new(),
        };
        String::from_utf8_lossy(&r.data[start..end])
            .trim_end_matches('\0')
            .trim_end()
            .to_string()
    }

    /// RATIONAL (dtype=5) or SRATIONAL (dtype=10): 8-byte numerator/denominator
    /// pair stored at the value offset (always a pointer — 8 bytes > 4 inline).
    fn as_rational(&self, r: &Reader) -> Option<(u32, u32)> {
        if self.dtype != 5 && self.dtype != 10 {
            return None;
        }
        let p = self.value_off as usize;
        let n = r.u32(p).ok()?;
        let d = r.u32(p + 4).ok()?;
        Some((n, d))
    }

    /// Three RATIONAL values in a row (24 bytes via pointer). Used for GPS
    /// latitude/longitude (degrees, minutes, seconds).
    fn as_rational_triplet(&self, r: &Reader) -> Option<[(u32, u32); 3]> {
        if self.dtype != 5 || self.count < 3 {
            return None;
        }
        let p = self.value_off as usize;
        let n0 = r.u32(p).ok()?;
        let d0 = r.u32(p + 4).ok()?;
        let n1 = r.u32(p + 8).ok()?;
        let d1 = r.u32(p + 12).ok()?;
        let n2 = r.u32(p + 16).ok()?;
        let d2 = r.u32(p + 20).ok()?;
        Some([(n0, d0), (n1, d1), (n2, d2)])
    }
}

fn read_ifd(r: &Reader, offset: u32) -> Result<Vec<IfdEntry>> {
    let off = offset as usize;
    let count = (r.u16(off)? as usize).min(512); // cap to prevent DoS from crafted files
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let e = off + 2 + i * 12;
        entries.push(IfdEntry {
            tag: r.u16(e)?,
            dtype: r.u16(e + 2)?,
            count: r.u32(e + 4)?,
            value_off: r.u32(e + 8)?,
        });
    }
    Ok(entries)
}

/// Bounds-safe u16 read for IFD walking (LE or BE). Returns 0 on OOB.
#[inline]
fn ifd_u16(data: &[u8], off: usize, le: bool) -> u16 {
    match data.get(off..off.wrapping_add(2)) {
        Some(b) => {
            if le {
                u16::from_le_bytes([b[0], b[1]])
            } else {
                u16::from_be_bytes([b[0], b[1]])
            }
        }
        None => 0,
    }
}

/// Bounds-safe u32 read for IFD walking (LE or BE). Returns 0 on OOB.
#[inline]
fn ifd_u32(data: &[u8], off: usize, le: bool) -> u32 {
    match data.get(off..off.wrapping_add(4)) {
        Some(b) => {
            if le {
                u32::from_le_bytes([b[0], b[1], b[2], b[3]])
            } else {
                u32::from_be_bytes([b[0], b[1], b[2], b[3]])
            }
        }
        None => 0,
    }
}

/// Zero-allocation IFD entry visitor shared by ORF, CR2, and DNG parsers.
///
/// Iterates entries at `off` (up to 512, as a corrupt-file guard), calling
/// `visitor(tag, dtype, cnt, val, inline_pos)` for each. `inline_pos` is the
/// byte offset of the 4-byte value field for callers that need in-place reads.
/// Returns the next-IFD offset (0 on OOB or when there is none).
pub(crate) fn visit_ifd<F: FnMut(u16, u16, u32, u32, usize)>(
    data: &[u8],
    off: usize,
    le: bool,
    mut visitor: F,
) -> u32 {
    if off.checked_add(2).map_or(true, |e| e > data.len()) {
        return 0;
    }
    let count = (ifd_u16(data, off, le) as usize).min(512);
    for i in 0..count {
        let e = off + 2 + i * 12;
        if e.checked_add(12).map_or(true, |end| end > data.len()) {
            break;
        }
        visitor(
            ifd_u16(data, e, le),
            ifd_u16(data, e + 2, le),
            ifd_u32(data, e + 4, le),
            ifd_u32(data, e + 8, le),
            e + 8,
        );
    }
    // SEC-006 / ERR-010: off + 2 + count * 12 can overflow usize on wasm32 when
    // off is a large file-supplied value.
    let next_pos = off.checked_add(2).and_then(|v| v.checked_add(count * 12));
    match next_pos {
        Some(p) if p.checked_add(4).map_or(false, |end| end <= data.len()) => ifd_u32(data, p, le),
        _ => 0,
    }
}

/// Olympus MakerNote header variants:
///   "OLYMP\0II\x03\0" + ...  (legacy)
///   "OLYMPUS\0II\x03\0" + ...  (E-system, modern; offsets are absolute in file)
///   "OM SYSTEM\0II..." (newer OM cameras)
fn parse_olympus_makernote(r: &Reader, entry: &IfdEntry, info: &mut OrfInfo) {
    let off = entry.value_off as usize;
    let data = r.data;
    // SEC: off + 12 can overflow usize on wasm32 when off is a file-supplied
    // value; use checked_add and a bounds-safe slice instead of a direct index.
    let Some(head) = off.checked_add(12).and_then(|end| data.get(off..end)) else {
        return;
    };
    // Try modern OLYMPUS header (12 bytes), then legacy OLYMP (8 bytes).
    let (sub_off, base_off) = if head.starts_with(b"OLYMPUS\0") {
        (off + 12, off)
    } else if head.starts_with(b"OLYMP\0") {
        (off + 8, 0)
    } else if head.starts_with(b"OM SYSTEM\0") {
        (off + 16, off)
    } else {
        (off, 0)
    };

    let sub = Reader { data, le: r.le };
    let Ok(count) = sub.u16(sub_off) else {
        return;
    };

    // OLYMPUS\0 / OM SYSTEM\0: IFD value-offsets are relative to the MakerNote start
    // (base_off). OLYMP\0 legacy uses absolute file offsets (base_off == 0).
    let abs = |v: u32| base_off + v as usize;

    // Extract the first inline SHORT from an IFD value field.
    // TIFF stores SHORT[1] or SHORT[2] directly in the 4-byte value field when
    // count*2 ≤ 4.  Must NOT treat it as a file pointer.
    let inline_u16 = |v: u32| -> u16 {
        if sub.le {
            (v & 0xFFFF) as u16
        } else {
            (v >> 16) as u16
        }
    };

    for i in 0..count as usize {
        let e_off = sub_off + 2 + i * 12;
        let Ok(tag) = sub.u16(e_off) else { return };
        let Ok(dtype) = sub.u16(e_off + 2) else {
            return;
        };
        let Ok(cnt) = sub.u32(e_off + 4) else { return };
        let Ok(val) = sub.u32(e_off + 8) else { return };
        match tag {
            // Top-level Olympus MakerNote Quality (SHORT[1]) — 1=SQ, 2=HQ, 3=SHQ, 4=RAW
            0x0201 if dtype == 3 && cnt <= 2 => {
                info.quality = Some(inline_u16(val));
            }
            // Equipment sub-IFD — has LensModel (0x0202).
            0x2010 => {
                let sub_off_abs = (base_off as u32).checked_add(val).unwrap_or(u32::MAX);
                let _ = parse_equipment_subifd(&sub, sub_off_abs, base_off, info);
            }
            // CameraSettings sub-IFD — has WhiteBalance2 (0x0500).
            0x2020 => {
                let sub_off_abs = (base_off as u32).checked_add(val).unwrap_or(u32::MAX);
                let _ = parse_camera_settings_subifd(&sub, sub_off_abs, base_off, info);
            }
            // RedBalance: SHORT×1, inline value, × 256
            0x1017 => {
                if dtype == 3 && cnt >= 1 {
                    let v = if cnt <= 2 {
                        inline_u16(val)
                    } else if let Ok(v) = sub.u16(abs(val)) {
                        v
                    } else {
                        continue;
                    };
                    // Guard against zero (corrupt/absent value) — mirrors 0x2040 path.
                    if v > 0 {
                        info.wb_r = Some(v as f32 / 256.0);
                    }
                }
            }
            // BlueBalance: SHORT×1, inline value, × 256
            0x1018 => {
                if dtype == 3 && cnt >= 1 {
                    let v = if cnt <= 2 {
                        inline_u16(val)
                    } else if let Ok(v) = sub.u16(abs(val)) {
                        v
                    } else {
                        continue;
                    };
                    // Guard against zero (corrupt/absent value) — mirrors 0x2040 path.
                    if v > 0 {
                        info.wb_b = Some(v as f32 / 256.0);
                    }
                }
            }
            // WB_RBLevels: SHORT×2 inline (4 bytes fits in value field), × 256
            0x1029 => {
                if dtype == 3 && cnt >= 2 {
                    let (a, b) = if cnt <= 2 {
                        if sub.le {
                            ((val & 0xFFFF) as u16, (val >> 16) as u16)
                        } else {
                            ((val >> 16) as u16, (val & 0xFFFF) as u16)
                        }
                    } else {
                        let p = abs(val);
                        match (sub.u16(p), sub.u16(p + 2)) {
                            (Ok(a), Ok(b)) => (a, b),
                            _ => continue,
                        }
                    };
                    // Guard against zero levels — mirrors 0x2040 path; a zero SHORT
                    // would zero the channel multiplier and produce a colour cast.
                    if a > 0 {
                        info.wb_r = Some(a as f32 / 256.0);
                    }
                    if b > 0 {
                        info.wb_b = Some(b as f32 / 256.0);
                    }
                }
            }
            // ImageProcessing sub-IFD — contains WB_RBLevels (tag 0x0100) on
            // modern E-M1 II/III and OM-1 bodies.
            0x2040 => {
                let sub_off_abs = (base_off as u32).checked_add(val).unwrap_or(u32::MAX);
                let _ = parse_image_processing_subifd(&sub, sub_off_abs, base_off, info);
            }
            // ColorMatrix: SSHORT×9 — always a pointer (18 bytes > 4)
            0x1011 => {
                if cnt == 9 {
                    let p = abs(val);
                    let mut m = [[0f32; 3]; 3];
                    let mut ok = true;
                    'outer: for row in 0..3 {
                        for col in 0..3 {
                            match sub.u16(p + (row * 3 + col) * 2) {
                                Ok(v) => m[row][col] = (v as i16) as f32 / 256.0,
                                Err(_) => {
                                    ok = false;
                                    break 'outer;
                                }
                            }
                        }
                    }
                    if ok {
                        info.color_matrix = Some(m);
                    }
                }
            }
            _ => {}
        }
    }
}

fn parse_equipment_subifd(r: &Reader, off: u32, base_off: usize, info: &mut OrfInfo) -> Result<()> {
    let p = off as usize;
    if p + 2 > r.data.len() {
        return Ok(());
    }
    let count = r.u16(p)?;
    for i in 0..count as usize {
        let e = p + 2 + i * 12;
        if e + 12 > r.data.len() {
            break;
        }
        let tag = r.u16(e)?;
        let dtype = r.u16(e + 2)?;
        let cnt = r.u32(e + 4)?;
        let val = r.u32(e + 8)?;
        // 0x0203 LensModel (ASCII). Value offsets in Olympus sub-IFDs are
        // relative to the MakerNote base (same as parse_image_processing_subifd).
        // (0x0202 is LensSerialNumber — a hex string, not the human name.)
        if tag == 0x0203 && dtype == 2 && cnt > 4 {
            let start = base_off + val as usize;
            let end = start + cnt as usize;
            if let Some(bytes) = r.data.get(start..end.min(r.data.len())) {
                info.lens = String::from_utf8_lossy(bytes)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string();
            }
        }
    }
    Ok(())
}

fn parse_camera_settings_subifd(
    r: &Reader,
    off: u32,
    _base_off: usize,
    info: &mut OrfInfo,
) -> Result<()> {
    let p = off as usize;
    if p + 2 > r.data.len() {
        return Ok(());
    }
    let count = r.u16(p)?;
    for i in 0..count as usize {
        let e = p + 2 + i * 12;
        if e + 12 > r.data.len() {
            break;
        }
        let tag = r.u16(e)?;
        let dtype = r.u16(e + 2)?;
        let _cnt = r.u32(e + 4)?;
        let val = r.u32(e + 8)?;
        // 0x0500 WhiteBalance2 — SHORT[1], inline. Low 16 bits on LE.
        if tag == 0x0500 && dtype == 3 {
            let v = if r.le {
                (val & 0xFFFF) as u16
            } else {
                (val >> 16) as u16
            };
            info.wb_mode = Some(v);
        }
    }
    Ok(())
}

fn parse_image_processing_subifd(
    r: &Reader,
    off: u32,
    base_off: usize,
    info: &mut OrfInfo,
) -> Result<()> {
    let p = off as usize;
    if p + 2 > r.data.len() {
        return Ok(());
    }
    let count = r.u16(p)?;
    for i in 0..count as usize {
        let e = p + 2 + i * 12;
        if e + 12 > r.data.len() {
            break;
        }
        let tag = r.u16(e)?;
        let dtype = r.u16(e + 2)?;
        let cnt = r.u32(e + 4)?;
        let val = r.u32(e + 8)?;
        // WB_RBLevels: format [R_balance, B_balance, G_ref, G_ref] where
        // each value is the channel gain ×256 (G_ref = 256 = unity).
        // ptr+0 = R gain ×256, ptr+2 = B gain ×256.
        if tag == 0x0100 && dtype == 3 && cnt >= 2 {
            let (r_lvl, b_lvl) = if cnt == 2 {
                // Inline: val was already decoded with correct endianness.
                // LE: first SHORT in low 16 bits, second in high 16 bits.
                // BE: first SHORT in high 16 bits, second in low 16 bits.
                let (r_v, b_v) = if r.le {
                    ((val & 0xFFFF) as u16, (val >> 16) as u16)
                } else {
                    ((val >> 16) as u16, (val & 0xFFFF) as u16)
                };
                (r_v, b_v)
            } else {
                let ptr = base_off + val as usize;
                (r.u16(ptr)?, r.u16(ptr + 2)?)
            };
            if r_lvl > 0 && b_lvl > 0 {
                info.wb_r = Some(r_lvl as f32 / 256.0);
                info.wb_b = Some(b_lvl as f32 / 256.0);
            }
        }
        // ColorMatrix: SSHORT×9 packed as CamRGB→sRGB (÷256).  Row sums ~1.
        if tag == 0x0200 && cnt == 9 && (dtype == 3 || dtype == 8) {
            let ptr = base_off + val as usize;
            let mut m = [[0f32; 3]; 3];
            let mut ok = true;
            'cm: for row in 0..3 {
                for col in 0..3 {
                    match r.u16(ptr + (row * 3 + col) * 2) {
                        Ok(v) => m[row][col] = (v as i16) as f32 / 256.0,
                        Err(_) => {
                            ok = false;
                            break 'cm;
                        }
                    }
                }
            }
            if ok {
                info.color_matrix = Some(m);
            }
        }
    }
    Ok(())
}

/// Lightweight, public, pixel-free metadata for gallery preflight and batch operations.
/// This is the stable public API for metadata-only paths (B4).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrfMetadata {
    pub make: String,
    pub model: String,
    pub lens: String,
    pub datetime: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u16,
    pub iso: u32,
    pub has_gps: bool,
    pub gps_lat: f64,
    pub gps_lon: f64,
    pub gps_alt: f64,
    pub exposure_num: u32,
    pub exposure_den: u32,
    pub fnumber_num: u32,
    pub fnumber_den: u32,
    pub focal_length_num: u32,
    pub focal_length_den: u32,
    pub focal_length_35: u16,
    pub wb_mode: u16,
    pub wb_from_camera: bool,
}

/// Parse ORF metadata only — zero pixel work (no decompress, no demosaic).
/// This is the equivalent of the WASM `parse_orf_metadata` for the native/Tauri path.
pub fn parse_orf_metadata(data: &[u8]) -> Result<OrfMetadata> {
    let info = parse(data)?;

    let (exp_num, exp_den) = info.exposure.unwrap_or((0, 1));
    let (fn_num, fn_den) = info.fnumber.unwrap_or((0, 1));
    let (fl_num, fl_den) = info.focal_length.unwrap_or((0, 1));

    Ok(OrfMetadata {
        make: info.make,
        model: info.model,
        lens: info.lens,
        datetime: info.datetime,
        width: info.width,
        height: info.height,
        orientation: info.orientation,
        iso: info.iso.unwrap_or(0),
        has_gps: info.gps_lat.is_some() && info.gps_lon.is_some(),
        gps_lat: info.gps_lat.unwrap_or(0.0),
        gps_lon: info.gps_lon.unwrap_or(0.0),
        gps_alt: info.gps_alt.unwrap_or(0.0),
        exposure_num: exp_num,
        exposure_den: exp_den,
        fnumber_num: fn_num,
        fnumber_den: fn_den,
        focal_length_num: fl_num,
        focal_length_den: fl_den,
        focal_length_35: info.focal_length_35.unwrap_or(0),
        wb_mode: info.wb_mode.unwrap_or(0),
        wb_from_camera: info.wb_r.is_some() && info.wb_b.is_some(),
    })
}

/// Timing + dimension result for isolated decompress + demosaic benchmark.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DecodeBench {
    pub decompress_ms: f64,
    pub demosaic_ms: f64,
    pub width: u32,
    pub height: u32,
}

/// Benchmark ORF decompress + demosaic only (no tonemap, no orientation, no downscale).
/// Use for isolating raw decode cost (matches WASM `bench_decode_orf`).
pub fn bench_decode_orf(data: &[u8]) -> Result<DecodeBench> {
    let info = parse(data)?;

    if info.compression != 1 {
        bail!("compression {} not supported for bench", info.compression);
    }

    let w = info.width as usize;
    let h = info.height as usize;
    // SEC-001 / ERR-001: use checked arithmetic to avoid wasm32 overflow.
    let strip_start = info.strip_offset as usize;
    let strip_end = strip_start
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| anyhow!("strip range overflow"))?;
    let strip = data
        .get(strip_start..strip_end)
        .ok_or_else(|| anyhow!("strip OOB ({strip_start}..{strip_end} > {})", data.len()))?;

    let t = std::time::Instant::now();
    let raw = crate::decompress::decompress(strip, w, h).map_err(|e| anyhow!("{e}"))?;
    let decompress_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = std::time::Instant::now();
    let _rgb16 = crate::demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow!("{e}"))?;
    let demosaic_ms = t.elapsed().as_secs_f64() * 1000.0;

    Ok(DecodeBench {
        decompress_ms,
        demosaic_ms,
        width: info.width,
        height: info.height,
    })
}

/// Per-stage timing for the full ORF → RGB8 pipeline (decompress + demosaic +
/// tone). For end-to-end profiling to locate the real cost center.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineBench {
    pub decompress_ms: f64,
    pub demosaic_ms: f64,
    pub tone_ms: f64,
    pub width: u32,
    pub height: u32,
}

/// Time decompress + demosaic + tone (pipeline::process) for one ORF.
pub fn bench_pipeline_orf(data: &[u8]) -> Result<PipelineBench> {
    let info = parse(data)?;
    if info.compression != 1 {
        bail!("compression {} not supported for bench", info.compression);
    }
    let w = info.width as usize;
    let h = info.height as usize;
    // SEC-001 / ERR-001: use checked arithmetic to avoid wasm32 overflow.
    let strip_start = info.strip_offset as usize;
    let strip_end = strip_start
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| anyhow!("strip range overflow"))?;
    let strip = data
        .get(strip_start..strip_end)
        .ok_or_else(|| anyhow!("strip OOB ({strip_start}..{strip_end} > {})", data.len()))?;

    let t = std::time::Instant::now();
    let raw = crate::decompress::decompress(strip, w, h).map_err(|e| anyhow!("{e}"))?;
    let decompress_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = std::time::Instant::now();
    let rgb16 = crate::demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow!("{e}"))?;
    let demosaic_ms = t.elapsed().as_secs_f64() * 1000.0;

    let params = crate::pipeline::PipelineParams::default_olympus();
    let t = std::time::Instant::now();
    let _rgb8 = crate::pipeline::process(&rgb16, &params);
    let tone_ms = t.elapsed().as_secs_f64() * 1000.0;

    Ok(PipelineBench {
        decompress_ms,
        demosaic_ms,
        tone_ms,
        width: info.width,
        height: info.height,
    })
}

/// Decode an ORF to rgb16, then sub-profile the tone pass: returns
/// (tone_full_ms, tone_lut_only_ms). full − lut_only = the per-pixel
/// apply_tone_math (matrix + sat/vibrance) cost; lut_only = LUT gather + store.
pub fn bench_tone_split_orf(data: &[u8]) -> Result<(f64, f64)> {
    let info = parse(data)?;
    if info.compression != 1 {
        bail!("compression {} not supported for bench", info.compression);
    }
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_start = info.strip_offset as usize;
    let strip_end = strip_start
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| anyhow!("strip range overflow"))?;
    let strip = data
        .get(strip_start..strip_end)
        .ok_or_else(|| anyhow!("strip OOB ({strip_start}..{strip_end} > {})", data.len()))?;
    let raw = crate::decompress::decompress(strip, w, h).map_err(|e| anyhow!("{e}"))?;
    let rgb16 = crate::demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow!("{e}"))?;
    let params = crate::pipeline::PipelineParams::default_olympus();
    Ok(crate::pipeline::bench_tone_split(&rgb16, &params))
}

/// Decode an ORF to RGBA8 via the full native pipeline (decompress → demosaic → tone).
/// Returns `(rgba8, width, height)`.  The decode is NOT parallelised here; the caller
/// is responsible for multi-image parallelism if needed.
pub fn decode_orf_rgba8(data: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let info = parse(data)?;
    if info.compression != 1 {
        bail!(
            "unsupported compression {} (only ljpeg compression=1 supported)",
            info.compression
        );
    }
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_start = info.strip_offset as usize;
    let strip_end = strip_start
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| anyhow!("strip range overflow"))?;
    let strip = data
        .get(strip_start..strip_end)
        .ok_or_else(|| anyhow!("strip OOB ({strip_start}..{strip_end} > {})", data.len()))?;
    let raw = crate::decompress::decompress(strip, w, h).map_err(|e| anyhow!("{e}"))?;
    let rgb16 = crate::demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow!("{e}"))?;
    let params = crate::pipeline::PipelineParams::default_olympus();
    let rgba8 = crate::pipeline::process_rgba(&rgb16, &params);
    Ok((rgba8, info.width, info.height))
}

/// End-to-end tone comparison on a real ORF: times scalar `process_into` vs SIMD
/// `process_into_simd` (full tone+LUT, parallel) AND checks output parity.
/// Returns (scalar_ms, simd_ms, max_byte_diff, num_pixels_differing).
pub fn bench_tone_e2e_orf(data: &[u8]) -> Result<(f64, f64, u8, usize)> {
    let info = parse(data)?;
    if info.compression != 1 {
        bail!("compression {} not supported for bench", info.compression);
    }
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_start = info.strip_offset as usize;
    let strip_end = strip_start
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| anyhow!("strip range overflow"))?;
    let strip = data
        .get(strip_start..strip_end)
        .ok_or_else(|| anyhow!("strip OOB ({strip_start}..{strip_end} > {})", data.len()))?;
    let raw = crate::decompress::decompress(strip, w, h).map_err(|e| anyhow!("{e}"))?;
    let rgb16 = crate::demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow!("{e}"))?;
    let params = crate::pipeline::PipelineParams::default_olympus();
    let n = rgb16.len();
    let mut a = vec![0u8; n];
    let mut b = vec![0u8; n];

    crate::pipeline::process_into(&rgb16, &params, &mut a); // warmup
    let t = std::time::Instant::now();
    crate::pipeline::process_into(&rgb16, &params, &mut a);
    let scalar_ms = t.elapsed().as_secs_f64() * 1000.0;

    crate::pipeline::process_into_simd(&rgb16, &params, &mut b); // warmup
    let t = std::time::Instant::now();
    crate::pipeline::process_into_simd(&rgb16, &params, &mut b);
    let simd_ms = t.elapsed().as_secs_f64() * 1000.0;

    let mut max_diff = 0u8;
    let mut ndiff = 0usize;
    for i in 0..n {
        let d = a[i].abs_diff(b[i]);
        if d > 0 {
            ndiff += 1;
            if d > max_diff {
                max_diff = d;
            }
        }
    }
    Ok((scalar_ms, simd_ms, max_diff, ndiff))
}

/// Split the tone pass into three independent stages on a real ORF:
/// pre-LUT gather (u16→f32), tone math (`apply_tone_bulk`), post-LUT gather (f32→u8).
/// Returns `(pre_lut_ms, tone_math_ms, post_lut_ms)`.
pub fn bench_tone_stage_3way_orf(data: &[u8]) -> Result<(f64, f64, f64)> {
    let info = parse(data)?;
    if info.compression != 1 {
        bail!("compression {} not supported for bench", info.compression);
    }
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_start = info.strip_offset as usize;
    let strip_end = strip_start
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| anyhow!("strip range overflow"))?;
    let strip = data
        .get(strip_start..strip_end)
        .ok_or_else(|| anyhow!("strip OOB ({strip_start}..{strip_end} > {})", data.len()))?;
    let raw = crate::decompress::decompress(strip, w, h).map_err(|e| anyhow!("{e}"))?;
    let rgb16 = crate::demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow!("{e}"))?;
    let params = crate::pipeline::PipelineParams::default_olympus();
    Ok(crate::pipeline::bench_tone_stage_3way(&rgb16, &params))
}
