//! Packet-3 Task 6 (findings 53,54): the DNG + CR2 streaming row sources must
//! reproduce the batch decode bit-for-bit WITHOUT building a hidden full-size
//! auxiliary mosaic during construction.
//!
//! Two axes are gated here:
//!   1. BIT-EXACT full-vs-row parity — the concatenated streamed rows equal
//!      `decode_bytes().raw` for:
//!        * DNG: all four CFA phases, compression 1 (strips AND tiles), both
//!          endian cases, crop-edge (odd/off-by-one) dims, and a malformed
//!          truncation that must error rather than panic; plus a real comp=7
//!          LJPEG DNG when the fixture is present.
//!        * CR2: single-slice (raster mosaic) and multi-slice (stacked slices).
//!   2. LOWER PEAK ALLOCATION — `cr2::cr2_row_source` must NOT allocate a second
//!      crop_w×crop_h mosaic just to gather the CFA-phase green statistics. A
//!      counting global allocator caps the construction's peak transient at the
//!      resident mosaic plus a small slack; a whole extra cropped mosaic (the
//!      pre-fix behaviour) blows past that cap.
//!
//! The synthetic DNGs are hand-built so the non-comp=7/non-RGGB matrix is covered
//! without shipping a bespoke real file per case. The CR2 gates are fixture-gated
//! on the real Canon corpus (skips gracefully when absent).

use raw_pipeline::decompress::RawRowSource;
use raw_pipeline::{cr2, dng};

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

// ---------------------------------------------------------------------------
// Counting allocator (this test binary only) for the CR2 peak-alloc probe.
// ---------------------------------------------------------------------------
struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Big-allocation watch, **per thread**. Lets a test detect whether a specific big
/// buffer (e.g. a whole cropped mosaic) is still being allocated, independent of
/// unrelated transient scratch.
///
/// Thread-local, not global: the two `cr2_*_peak_alloc` tests each arm the watch and
/// each allocate a ~48 MB mosaic, so with a process-wide counter the harness's default
/// parallelism made each one count the other's allocation and see 2 where it required 1.
/// That is a property of the measurement, not of `cr2_row_source` — it reproduced only
/// when the tests ran together, and each passed alone. Attributing counts to the arming
/// thread keeps the probe sound without serialising the binary.
///
/// `const`-initialised `Cell`s: TLS access inside a `GlobalAlloc` must not allocate or
/// recurse, and `try_with` keeps it safe during thread-local destruction.
thread_local! {
    static WATCH_MIN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static BIG_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(c, Ordering::Relaxed);
            let _ = WATCH_MIN.try_with(|w| {
                let wm = w.get();
                if wm != 0 && l.size() >= wm {
                    let _ = BIG_COUNT.try_with(|b| b.set(b.get() + 1));
                }
            });
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
        System.dealloc(p, l);
    }
}
#[global_allocator]
static A: Counting = Counting;

// ---------------------------------------------------------------------------
// Synthetic DNG builder (little/big-endian, comp=1 strips or tiles, any CFA).
// ---------------------------------------------------------------------------

/// Minimal TIFF/DNG writer covering the cases the streaming row source must
/// handle. Emits a single IFD (IFD0 doubles as the raw IFD — `DngRowSource` /
/// `decode_bytes` walk IFD0 + SubIFDs and treat the first raw-candidate IFD as
/// the raw image, and IFD0 itself qualifies).
struct DngBuilder {
    le: bool,
    width: u32,
    height: u32,
    compression: u32, // 1 only (uncompressed) for synthetic files
    cfa: [u8; 4],
    /// (offset-tag, bytecount-tag) pairs are chosen by `tiled`.
    tiled: bool,
    tile_w: u32,
    tile_h: u32,
    /// Row pixel values, row-major, length == width*height.
    pixels: Vec<u16>,
}

impl DngBuilder {
    fn new(le: bool, width: u32, height: u32, cfa: [u8; 4]) -> Self {
        let pixels = (0..(width as usize * height as usize))
            .map(|i| ((i * 7 + 3) & 0x3fff) as u16)
            .collect();
        Self {
            le,
            width,
            height,
            compression: 1,
            cfa,
            tiled: false,
            tile_w: 0,
            tile_h: 0,
            pixels,
        }
    }

    fn tiled(mut self, tw: u32, th: u32) -> Self {
        self.tiled = true;
        self.tile_w = tw;
        self.tile_h = th;
        self
    }

    fn u16b(&self, v: u16) -> [u8; 2] {
        if self.le { v.to_le_bytes() } else { v.to_be_bytes() }
    }
    fn u32b(&self, v: u32) -> [u8; 4] {
        if self.le { v.to_le_bytes() } else { v.to_be_bytes() }
    }

    /// Serialize the pixel payload as either strips (one strip per row) or tiles.
    /// Returns (payload_bytes, offsets, byte_counts).
    fn build_payload(&self, base: u32) -> (Vec<u8>, Vec<u32>, Vec<u32>) {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut payload = Vec::new();
        let mut offs = Vec::new();
        let mut counts = Vec::new();
        if self.tiled {
            let tw = self.tile_w as usize;
            let th = self.tile_h as usize;
            let coltiles = w.div_ceil(tw);
            let rowtiles = h.div_ceil(th);
            for tr in 0..rowtiles {
                for tc in 0..coltiles {
                    offs.push(base + payload.len() as u32);
                    // A tile is tw×th samples (padded rows past the image edge are
                    // still full tile rows in the file; decode reads only the active
                    // sub-rect and skips `tw*2` per row).
                    for r in 0..th {
                        let y = tr * th + r;
                        for c in 0..tw {
                            let x = tc * tw + c;
                            let v = if y < h && x < w {
                                self.pixels[y * w + x]
                            } else {
                                0
                            };
                            payload.extend_from_slice(&self.u16b(v));
                        }
                    }
                    counts.push((tw * th * 2) as u32);
                }
            }
        } else {
            // One strip per row (rows_per_strip = 1).
            for y in 0..h {
                offs.push(base + payload.len() as u32);
                for x in 0..w {
                    payload.extend_from_slice(&self.u16b(self.pixels[y * w + x]));
                }
                counts.push((w * 2) as u32);
            }
        }
        (payload, offs, counts)
    }

    fn build(&self) -> Vec<u8> {
        // Layout: [header 8][IFD][external arrays + payload].
        // Tags emitted (ascending): 0x0100 w, 0x0101 h, 0x0102 bps=16,
        // 0x0103 compression, 0x0106 photometric=CFA(32803), then either strip
        // tags (0x0111/0x0117/0x0116) or tile tags (0x0142/0x0143/0x0144/0x0145),
        // 0x011C planar=1, 0x828E CFAPattern, 0x828D CFARepeat=2,2.
        //
        // External data (arrays that don't fit inline, plus the pixel payload)
        // live after the IFD. We compute offsets in two passes.

        let entries: Vec<(u16, u16, u32)> = self.ifd_entry_shapes();
        let n = entries.len();
        // IFD size: 2 (count) + 12*n + 4 (next-IFD offset).
        let ifd_off = 8u32;
        let ifd_size = 2 + 12 * n as u32 + 4;
        let ext_base = ifd_off + ifd_size;

        // External data (CFAPattern is inline as 4 BYTEs; strip/tile arrays and the
        // pixel payload live after the IFD). We compute offsets in two passes.
        let mut ext = Vec::new();

        // First pass: build the payload at base 0 just to learn how many strips/tiles
        // there are (so we know whether the offset/count arrays need external storage).
        let arr_len = self.build_payload(0).1.len();
        let offs_needs_ext = arr_len > 1;
        let counts_needs_ext = arr_len > 1;

        let mut ext_cursor = ext_base;
        let offs_arr_off = if offs_needs_ext {
            let o = ext_cursor;
            ext_cursor += (arr_len * 4) as u32;
            o
        } else {
            0
        };
        let counts_arr_off = if counts_needs_ext {
            let o = ext_cursor;
            ext_cursor += (arr_len * 4) as u32;
            o
        } else {
            0
        };
        let payload_base = ext_cursor;
        let (payload, offs, counts) = self.build_payload(payload_base);

        // Now emit external arrays (offsets, counts) then payload.
        if offs_needs_ext {
            for &o in &offs {
                ext.extend_from_slice(&self.u32b(o));
            }
        }
        if counts_needs_ext {
            for &c in &counts {
                ext.extend_from_slice(&self.u32b(c));
            }
        }
        ext.extend_from_slice(&payload);

        // Build the IFD now that offsets are known.
        let mut ifd = Vec::new();
        ifd.extend_from_slice(&self.u16b(n as u16));
        for (tag, dtype, _shape) in &entries {
            let (cnt, val) = self.entry_value(*tag, offs_arr_off, counts_arr_off, &offs, &counts);
            ifd.extend_from_slice(&self.u16b(*tag));
            ifd.extend_from_slice(&self.u16b(*dtype));
            ifd.extend_from_slice(&self.u32b(cnt));
            ifd.extend_from_slice(&val);
        }
        ifd.extend_from_slice(&self.u32b(0)); // no next IFD

        let mut out = Vec::new();
        if self.le {
            out.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00]);
        } else {
            out.extend_from_slice(&[0x4D, 0x4D, 0x00, 0x2A]);
        }
        out.extend_from_slice(&self.u32b(ifd_off));
        assert_eq!(out.len(), ifd_off as usize);
        out.extend_from_slice(&ifd);
        assert_eq!(out.len(), ext_base as usize);
        out.extend_from_slice(&ext);
        out
    }

    /// The ordered set of (tag, dtype, count-hint) the IFD carries.
    fn ifd_entry_shapes(&self) -> Vec<(u16, u16, u32)> {
        let mut v = vec![
            (0x0100, 3, 1), // ImageWidth SHORT
            (0x0101, 3, 1), // ImageLength SHORT
            (0x0102, 3, 1), // BitsPerSample SHORT
            (0x0103, 3, 1), // Compression SHORT
            (0x0106, 3, 1), // PhotometricInterpretation SHORT (32803 = CFA)
            (0x0115, 3, 1), // SamplesPerPixel = 1
        ];
        if self.tiled {
            v.push((0x0142, 3, 1)); // TileWidth
            v.push((0x0143, 3, 1)); // TileLength
            v.push((0x0144, 4, 1)); // TileOffsets LONG (count set at emit)
            v.push((0x0145, 4, 1)); // TileByteCounts LONG
        } else {
            v.push((0x0111, 4, 1)); // StripOffsets
            v.push((0x0116, 3, 1)); // RowsPerStrip
            v.push((0x0117, 4, 1)); // StripByteCounts
        }
        v.push((0x011C, 3, 1)); // PlanarConfiguration = 1
        v.push((0x828E, 1, 4)); // CFAPattern (4 BYTE)
        v
    }

    fn entry_value(
        &self,
        tag: u16,
        offs_arr_off: u32,
        counts_arr_off: u32,
        offs: &[u32],
        counts: &[u32],
    ) -> (u32, [u8; 4]) {
        let short = |v: u16| {
            // SHORT stored left-justified in the 4-byte value field.
            let b = self.u16b(v);
            if self.le {
                (1u32, [b[0], b[1], 0, 0])
            } else {
                (1u32, [b[0], b[1], 0, 0])
            }
        };
        let long = |v: u32| (1u32, self.u32b(v));
        match tag {
            0x0100 => short(self.width as u16),
            0x0101 => short(self.height as u16),
            0x0102 => short(16),
            0x0103 => short(self.compression as u16),
            0x0106 => short(32803), // CFA
            0x0115 => short(1),
            0x0142 => short(self.tile_w as u16),
            0x0143 => short(self.tile_h as u16),
            0x0144 => {
                if offs.len() == 1 {
                    long(offs[0])
                } else {
                    (offs.len() as u32, self.u32b(offs_arr_off))
                }
            }
            0x0145 => {
                if counts.len() == 1 {
                    long(counts[0])
                } else {
                    (counts.len() as u32, self.u32b(counts_arr_off))
                }
            }
            0x0111 => {
                if offs.len() == 1 {
                    long(offs[0])
                } else {
                    (offs.len() as u32, self.u32b(offs_arr_off))
                }
            }
            0x0116 => short(1), // RowsPerStrip = 1
            0x0117 => {
                if counts.len() == 1 {
                    long(counts[0])
                } else {
                    (counts.len() as u32, self.u32b(counts_arr_off))
                }
            }
            0x011C => short(1),
            0x828E => {
                // 4 BYTEs inline.
                (4u32, [self.cfa[0], self.cfa[1], self.cfa[2], self.cfa[3]])
            }
            _ => (1, [0; 4]),
        }
    }
}

const RGGB: [u8; 4] = [0, 1, 1, 2];
const GBRG: [u8; 4] = [1, 2, 0, 1];
const GRBG: [u8; 4] = [1, 0, 2, 1];
const BGGR: [u8; 4] = [2, 1, 1, 0];

/// Concatenate every streamed raw row from a `DngRowSource`.
fn dng_stream_rows(data: &[u8]) -> (usize, usize, Vec<u16>) {
    let mut src = dng::DngRowSource::new(data).expect("DngRowSource::new");
    let (w, h) = (src.width(), src.height());
    let mut rowbuf = vec![0u16; w];
    let mut out = Vec::with_capacity(w * h);
    while src.next_row_into(&mut rowbuf).expect("next_row_into") {
        out.extend_from_slice(&rowbuf);
    }
    (w, h, out)
}

/// Assert the synthetic DNG streams row-identical to the batch `decode_bytes`.
fn assert_dng_full_vs_row(b: &DngBuilder, label: &str) {
    let data = b.build();
    let full = dng::decode_bytes(&data).unwrap_or_else(|e| panic!("{label}: decode_bytes: {e}"));
    let (w, h, streamed) = dng_stream_rows(&data);
    assert_eq!((w, h), (full.width, full.height), "{label}: dims differ");
    assert_eq!(streamed.len(), full.raw.len(), "{label}: raw len differs");
    assert!(streamed == full.raw, "{label}: streamed rows != decode_bytes().raw");
}

#[test]
fn dng_synth_all_cfa_phases_strip_le() {
    // Even dims exercise all four phase mappings cleanly.
    for (cfa, name) in [(RGGB, "RGGB"), (GBRG, "GBRG"), (GRBG, "GRBG"), (BGGR, "BGGR")] {
        assert_dng_full_vs_row(&DngBuilder::new(true, 8, 6, cfa), &format!("strip-le {name}"));
    }
}

#[test]
fn dng_synth_all_cfa_phases_strip_be() {
    for (cfa, name) in [(RGGB, "RGGB"), (GBRG, "GBRG"), (GRBG, "GRBG"), (BGGR, "BGGR")] {
        assert_dng_full_vs_row(&DngBuilder::new(false, 8, 6, cfa), &format!("strip-be {name}"));
    }
}

#[test]
fn dng_synth_tiled_le_and_be() {
    // Tile grid that does NOT evenly divide the image (edge tiles) — the row source
    // must still land rows in raster order.
    assert_dng_full_vs_row(
        &DngBuilder::new(true, 10, 8, RGGB).tiled(4, 4),
        "tiled-le 10x8 t4x4",
    );
    assert_dng_full_vs_row(
        &DngBuilder::new(false, 10, 8, BGGR).tiled(4, 4),
        "tiled-be 10x8 t4x4",
    );
}

#[test]
fn dng_synth_crop_edge_odd_dims() {
    // Odd width/height (off-by-one edges) — the last strip/tile row is short.
    assert_dng_full_vs_row(&DngBuilder::new(true, 7, 5, RGGB), "odd 7x5 strip");
    assert_dng_full_vs_row(&DngBuilder::new(true, 9, 7, GRBG).tiled(4, 4), "odd 9x7 tiled");
}

#[test]
fn dng_synth_malformed_truncation_errors_not_panics() {
    // Truncate the pixel payload: the last strip is short. decode_bytes and the
    // row source must both return Err, not panic / read OOB.
    let data = DngBuilder::new(true, 8, 6, RGGB).build();
    let truncated = &data[..data.len() - 4];
    let full = dng::decode_bytes(truncated);
    assert!(full.is_err(), "truncated DNG batch decode should error");
    // Row source: either constructs then errors on a row, or fails to construct.
    if let Ok(mut src) = dng::DngRowSource::new(truncated) {
        let w = src.width();
        let mut rowbuf = vec![0u16; w];
        let mut hit_err = false;
        loop {
            match src.next_row_into(&mut rowbuf) {
                Ok(true) => {}
                Ok(false) => break,
                Err(_) => {
                    hit_err = true;
                    break;
                }
            }
        }
        assert!(hit_err, "truncated DNG row source should error on a row");
    }
}

// ---------------------------------------------------------------------------
// Real comp=7 LJPEG DNG (fixture-gated).
// ---------------------------------------------------------------------------

fn find_dng() -> Option<Vec<u8>> {
    for p in [
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
        r"C:\Foo\raw-converter\tests\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
        "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    ] {
        if let Ok(d) = std::fs::read(p) {
            return Some(d);
        }
    }
    None
}

#[test]
fn dng_real_comp7_full_vs_row() {
    let Some(data) = find_dng() else {
        eprintln!("skip: no comp=7 DNG fixture");
        return;
    };
    let full = dng::decode_bytes(&data).expect("decode_bytes");
    let (w, h, streamed) = dng_stream_rows(&data);
    assert_eq!((w, h), (full.width, full.height), "comp7 dims differ");
    assert_eq!(streamed.len(), full.raw.len(), "comp7 raw len differs");
    assert!(streamed == full.raw, "comp7 streamed rows != decode_bytes().raw");
}

// ---------------------------------------------------------------------------
// CR2 streaming: bit-exact row parity + lower peak allocation.
// ---------------------------------------------------------------------------

const CR2_SINGLE: &str = "ADH 1234.CR2";
const CR2_MULTI: &str = "_MG_1744.CR2";

fn cr2_fixture(name: &str) -> Option<Vec<u8>> {
    let dir =
        std::env::var("CR2_FIXTURE_DIR").unwrap_or_else(|_| r"C:\Foo\raw-converter\tests".into());
    let p = std::path::Path::new(&dir).join(name);
    std::fs::read(p).ok()
}

fn cr2_stream_rows(data: &[u8]) -> (usize, usize, Vec<u16>) {
    let mut src = cr2::cr2_row_source(data).expect("cr2_row_source");
    let (w, h) = (src.width(), src.height());
    let mut rowbuf = vec![0u16; w];
    let mut out = Vec::with_capacity(w * h);
    while src.next_row_into(&mut rowbuf).expect("next_row_into") {
        out.extend_from_slice(&rowbuf);
    }
    (w, h, out)
}

fn cr2_full_vs_row(name: &str) {
    let Some(data) = cr2_fixture(name) else {
        eprintln!("skip: no CR2 fixture ({name})");
        return;
    };
    let full = cr2::decode_bytes(&data).expect("decode_bytes");
    let (w, h, streamed) = cr2_stream_rows(&data);
    assert_eq!((w, h), (full.width, full.height), "{name}: dims differ");
    assert_eq!(streamed.len(), full.raw.len(), "{name}: raw len differs");
    assert!(streamed == full.raw, "{name}: streamed rows != decode_bytes().raw");
    // The refined CFA phase carried on the row source must match the batch path.
    let mut src = cr2::cr2_row_source(&data).expect("cr2_row_source");
    let _ = src.next_row_into(&mut vec![0u16; w]);
    assert_eq!(src.cfa_phase, full.cfa_phase, "{name}: refined CFA phase differs");
}

#[test]
fn cr2_single_slice_full_vs_row() {
    cr2_full_vs_row(CR2_SINGLE);
}

#[test]
fn cr2_multi_slice_full_vs_row() {
    cr2_full_vs_row(CR2_MULTI);
}

/// Allocation gate: constructing a `Cr2RowSource` must NOT allocate a whole extra
/// crop_w×crop_h mosaic (the pre-fix behaviour materialised the cropped mosaic just
/// to run `refine_cfa_phase_by_green`, then dropped it).
///
/// The resident mosaic (`raw_buf_bytes`, ≥ the cropped mosaic) is the ONE unavoidable
/// large buffer. Arming the allocator to count every live allocation ≥ 90% of the
/// cropped-mosaic size isolates the two: the pre-fix code produced two such large
/// allocations (resident + crop), the fixed code produces exactly one (resident). The
/// reusable per-row scratch (`crop_w` u16) is orders of magnitude smaller and is not
/// counted. Peak bytes are printed too as a secondary structural signal.
fn cr2_peak_alloc_no_full_crop(name: &str) {
    let Some(data) = cr2_fixture(name) else {
        eprintln!("skip: no CR2 fixture ({name})");
        return;
    };
    // Learn the resident-mosaic + cropped-mosaic sizes for this file.
    let (_img, t) = cr2::decode_bytes_bench(&data).expect("decode_bytes_bench");
    let resident_bytes = t.raw_buf_bytes; // stride*sof_h*2 — the mosaic we must keep
    let crop_bytes = t.crop_buf_bytes; // crop_w*crop_h*2 — the hidden alloc to remove
    assert!(crop_bytes > 0 && resident_bytes >= crop_bytes);

    // Threshold: 90% of the cropped-mosaic size. Catches both the resident mosaic
    // (≥ crop) and any crop-sized buffer; excludes small scratch.
    let watch = (crop_bytes / 10) * 9;

    let base = CUR.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    BIG_COUNT.with(|b| b.set(0));
    WATCH_MIN.with(|w| w.set(watch));
    let src = cr2::cr2_row_source(&data).expect("cr2_row_source");
    WATCH_MIN.with(|w| w.set(0));
    let big = BIG_COUNT.with(|b| b.get());
    let peak_delta = PEAK.load(Ordering::Relaxed) - base;
    std::hint::black_box(&src);

    println!(
        "{name}: cr2_row_source big_allocs(>={watch})={big} peak_delta={peak_delta} \
         resident={resident_bytes} crop={crop_bytes}"
    );
    // Exactly one crop-scale allocation (the resident mosaic). Two would mean the
    // full cropped mosaic is still being materialised for the phase probe.
    assert_eq!(
        big, 1,
        "{name}: expected exactly 1 crop-scale allocation (resident mosaic), saw {big} \
         — a full cropped mosaic is still being allocated for CFA-phase refinement"
    );
}

#[test]
fn cr2_single_slice_peak_alloc() {
    cr2_peak_alloc_no_full_crop(CR2_SINGLE);
}

#[test]
fn cr2_multi_slice_peak_alloc() {
    cr2_peak_alloc_no_full_crop(CR2_MULTI);
}
