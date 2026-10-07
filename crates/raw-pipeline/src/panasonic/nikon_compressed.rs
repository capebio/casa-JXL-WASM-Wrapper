//! Nikon compressed NEF (259 == 34713, Huffman DPCM), moved verbatim out of
//! `panasonic.rs` (2026-10-07) so the Nikon raw lane owns it. A child module,
//! so the TIFF helpers it shares with the Panasonic reader stay where they are.
use super::*;

/// dcraw's `nikon_tree`. The arrays are 32 wide and **zero-padded on purpose**:
/// the length counts sum to one more than the symbols listed, so the builder
/// reads a final symbol 0 out of the padding. Transcribing only the printed
/// symbols overruns the array.
#[rustfmt::skip]
pub(super) const NIKON_TREE: [[u8; 32]; 6] = [
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
pub(super) fn make_decoder(tree: &[u8; 32]) -> Vec<u16> {
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

/// Bits looked at by the fused table (`make_fused`).
const FUSE_BITS: u32 = 12;

/// Code and difference in one lookup (the CAN-9 shape): slot `w` holds
/// `consumed << 16 | diff as u16` for a code plus its magnitude bits that fit in
/// the next `FUSE_BITS` bits, 0 when they do not (the per-sample path decides).
/// Empty when the code itself is longer than the window.
fn make_fused(huff: &[u16]) -> Vec<u32> {
    let max = huff[0] as u32;
    if max > FUSE_BITS {
        return Vec::new();
    }
    (0..1u32 << FUSE_BITS)
        .map(|w| {
            let v = huff[1 + (w >> (FUSE_BITS - max)) as usize];
            let (clen, sym) = ((v >> 8) as u32, (v & 0xff) as u32);
            let (len, shl) = (sym & 15, sym >> 4);
            let nb = len - shl.min(len);
            if clen == 0 || clen + nb > FUSE_BITS {
                return 0;
            }
            let bits = (w >> (FUSE_BITS - clen - nb)) & ((1 << nb) - 1);
            let mut diff = ((((bits << 1) + 1) << shl) >> 1) as i32;
            if len > 0 && (diff & (1 << (len - 1))) == 0 {
                diff -= (1 << len) - if shl != 0 { 0 } else { 1 };
            }
            (clen + nb) << 16 | diff as u16 as u32
        })
        .collect()
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
        if self.vbits >= n {
            return;
        }
        // One 8-byte load tops the buffer up to 57..63 bits; only the last
        // seven bytes of the strip take the byte loop (and its zero padding).
        if let Some(b) = self.d.get(self.p..self.p + 8) {
            let k = (63 - self.vbits) / 8;
            let w = u64::from_be_bytes(b.try_into().unwrap());
            self.buf = (self.buf << (8 * k)) | (w >> (64 - 8 * k));
            self.p += k as usize;
            self.vbits += 8 * k;
            return;
        }
        while self.vbits < n {
            let c = *self.d.get(self.p).unwrap_or(&0) as u64;
            self.p += 1;
            self.buf = (self.buf << 8) | c;
            self.vbits += 8;
        }
    }
}

/// The two operations the sample loop needs, so it can run on either reader.
trait Bits {
    /// The next `n` bits (1..=25), not consumed.
    fn peek(&mut self, n: u32) -> u32;
    fn skip(&mut self, n: u32);
}

impl Bits for NikonBits<'_> {
    #[inline(always)]
    fn peek(&mut self, n: u32) -> u32 {
        self.fill(n);
        ((self.buf >> (self.vbits - n)) & ((1u64 << n) - 1)) as u32
    }
    #[inline(always)]
    fn skip(&mut self, n: u32) {
        self.vbits -= n;
    }
}

/// NSP-30: the unread bits sit at the TOP of `buf`, so a peek is a constant
/// shift and a skip is one left shift; the serial chain per sample loses the
/// `vbits - n` step. Bits below `bits` are the stream's next bytes or zero.
struct NikonLeft<'a> {
    d: &'a [u8],
    p: usize,
    buf: u64,
    bits: u32,
}

impl Bits for NikonLeft<'_> {
    #[inline(always)]
    fn peek(&mut self, n: u32) -> u32 {
        if self.bits < n {
            if let Some(b) = self.d.get(self.p..self.p + 8) {
                self.buf |= u64::from_be_bytes(b.try_into().unwrap()) >> self.bits;
                let k = (63 - self.bits) / 8;
                self.p += k as usize;
                self.bits += 8 * k;
            } else {
                while self.bits < n {
                    let c = *self.d.get(self.p).unwrap_or(&0) as u64;
                    self.p += 1;
                    self.buf |= c << (56 - self.bits);
                    self.bits += 8;
                }
            }
        }
        (self.buf >> (64 - n)) as u32
    }
    #[inline(always)]
    fn skip(&mut self, n: u32) {
        self.buf <<= n;
        self.bits -= n;
    }
}

/// Screening switch: on by env var `name`, or by an exe path containing it in
/// lower case (broker `ab` has no per-arm env). Read once per decode.
fn switch(name: &str) -> bool {
    std::env::var_os(name).is_some()
        || std::env::current_exe()
            .map_or(false, |p| p.to_string_lossy().contains(&name.to_lowercase()))
}

/// The Huffman-DPCM sample loop. `NB` (NSP-29) indexes a row slice and
/// fixed-size tables so the bounds checks fold away.
fn nikon_rows<R: Bits, const NB: bool>(
    mut bs: R,
    w: usize,
    h: usize,
    tree: usize,
    split: usize,
    mut vpred: [[i32; 2]; 2],
    curve: &[u16],
) -> Vec<u16> {
    let ca: &[u16; 0x8000] = curve[..0x8000].try_into().unwrap();
    let mut huff = make_decoder(&NIKON_TREE[tree]);
    let mut fused = make_fused(&huff);
    let mut out = vec![0u16; w * h];
    let mut hpred = [0i32; 2];
    for row in 0..h {
        if split != 0 && row == split {
            huff = make_decoder(&NIKON_TREE[tree + 1]);
            fused = make_fused(&huff);
        }
        let fa: Option<&[u32; 1 << FUSE_BITS]> = fused.as_slice().try_into().ok();
        let (o, base) = if NB { (&mut out[row * w..(row + 1) * w], 0) } else { (&mut out[..], row * w) };
        for col in 0..w {
            let f = if NB {
                match fa {
                    Some(t) => t[bs.peek(FUSE_BITS) as usize],
                    None => 0,
                }
            } else if fused.is_empty() {
                0
            } else {
                fused[bs.peek(FUSE_BITS) as usize]
            };
            let diff = if f != 0 {
                bs.skip(f >> 16);
                f as u16 as i16 as i32
            } else {
                let v = huff[1 + bs.peek(huff[0] as u32) as usize];
                bs.skip((v >> 8) as u32);
                let (len, shl) = ((v & 15) as u32, ((v & 0xff) >> 4) as u32);
                let nb = len - shl.min(len);
                let b = if nb == 0 {
                    0
                } else {
                    let b = bs.peek(nb);
                    bs.skip(nb);
                    b
                };
                let mut diff = ((((b << 1) + 1) << shl) >> 1) as i32;
                if len > 0 && (diff & (1 << (len - 1))) == 0 {
                    diff -= (1 << len) - if shl != 0 { 0 } else { 1 };
                }
                diff
            };
            if col < 2 {
                vpred[row & 1][col] += diff;
                hpred[col] = vpred[row & 1][col];
            } else {
                hpred[col & 1] += diff;
            }
            let i = hpred[col & 1].clamp(0, 0x3fff) as usize;
            o[base + col] = if NB { ca[i] } else { curve[i] };
        }
    }
    out
}

/// Nikon's compressed NEF (259 == 34713): a Huffman-coded DPCM over two
/// vertical predictors, then a linearisation curve read from MakerNote 0x0096.
///
/// Transcribed from dcraw `nikon_load_raw` and validated against ImageMagick
/// before it was written: r = 0.9408 on `nikon_1-j1_DSC0355.NEF`.
pub(super) fn nikon_compressed(
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
    // Read from the sensor SubIFD's CFAPattern by the caller, which is the IFD
    // that has it; this function only ever sees the MakerNote.
    cfa_phase: (u8, u8),
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
    let (mo, base, me) = if let Some(sig) = nikon_sig(d) {
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
    let mut step = if csize > 1 { max / (csize - 1) } else { 0 };
    let mut split = 0usize;
    // **Version `0x44 0x40` is a quarter-scale interpolated curve, and reading
    // it as a literal one silently loses the linearisation.**
    //
    // The `0x4440` shape stores the same 257 knots as `0x4420` but over a
    // quarter of the range, so both `step` and `max` are divided by four before
    // the interpolation. Without this arm it fell through to "read directly"
    // below, which sets `max = csize` and copies 257 entries into a table left
    // at its identity fill — so every sample above 256 came out as its own curve
    // INDEX instead of the curve's value.
    //
    // Measured on `14bit-compressed-other__Z_6`, the one file in the corpus with
    // this version: 15,146,739 of 24,498,560 samples differed from LibRaw, the
    // plane maxed at 4092 where LibRaw reads 16371, and LibRaw's value was a
    // pure monotone function of ours — 3,043 distinct values mapping one-to-one
    // onto 3,043, identical below 1004 and diverging above. A perfect 1:1 map is
    // what a missing lookup looks like; a broken decode does not produce one.
    // Its siblings `Z_50` and `Z_f` are version `0x4630`, keep the identity
    // curve, and were already exact, which is why this reads as body-specific.
    if ver0 == 0x44 && (ver1 == 0x20 || ver1 == 0x40) && step > 0 {
        if ver1 == 0x40 {
            step /= 4;
            max /= 4;
        }
        // `step` is the interpolation divisor below. dcraw tests it before the
        // quarter-scaling and can therefore divide by zero on a crafted csize;
        // refusing is cheaper than a panic and honest about what was unreadable.
        if step == 0 {
            return Err(format!(
                "NEF: a {csize}-knot version {ver0:#04x}{ver1:02x} curve leaves no interpolation \
                 step for {bits}-bit samples"
            ));
        }
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
    let s = &d[off..];
    let left = NikonLeft { d: s, p: 0, buf: 0, bits: 0 };
    let out = match (!switch("NSP30OFF"), !switch("NSP29OFF")) {
        (false, false) => nikon_rows::<_, false>(NikonBits::new(s), w, h, tree, split, vpred, &curve),
        (false, true) => nikon_rows::<_, true>(NikonBits::new(s), w, h, tree, split, vpred, &curve),
        (true, false) => nikon_rows::<_, false>(left, w, h, tree, split, vpred, &curve),
        (true, true) => nikon_rows::<_, true>(left, w, h, tree, split, vpred, &curve),
    };

    // The camera's own multipliers where the body records them; the documented
    // default only where it does not.
    let wb = nikon_wb(d).unwrap_or((2.0, 1.0, 1.5));
    Ok(BayerImage {
        width: w,
        height: h,
        raw: out,
        cfa_phase,
        black: 0,
        white: curve[max - 1],
        wb_r: wb.0,
        wb_g: wb.1,
        wb_b: wb.2,
        make: tag_str(_ifd0, 271),
        model: tag_str(_ifd0, 272),
        // Nikon declares the compressed strip length outright, so no cursor
        // arithmetic is needed here.
        strip: off..off + _len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every non-zero fused slot is what the per-sample path reads from the
    /// same bits, for all six trees (the split trees included).
    #[test]
    fn fused_slot_matches_the_per_sample_path() {
        for tree in &NIKON_TREE {
            let huff = make_decoder(tree);
            let fused = make_fused(&huff);
            assert!(!fused.is_empty());
            for w in 0..1u32 << FUSE_BITS {
                let f = fused[w as usize];
                if f == 0 {
                    continue;
                }
                let bytes = ((w << 20) | 0xA_5A5A).to_be_bytes();
                let mut bs = NikonBits::new(&bytes);
                let v = huff[1 + bs.peek(huff[0] as u32) as usize];
                bs.skip((v >> 8) as u32);
                let (len, shl) = ((v & 15) as u32, ((v & 0xff) >> 4) as u32);
                let nb = len - shl.min(len);
                let b = if nb == 0 { 0 } else { bs.peek(nb) };
                bs.skip(nb);
                let mut diff = ((((b << 1) + 1) << shl) >> 1) as i32;
                if len > 0 && (diff & (1 << (len - 1))) == 0 {
                    diff -= (1 << len) - if shl != 0 { 0 } else { 1 };
                }
                assert_eq!((f >> 16, f as u16 as i16 as i32), (bs.p as u32 * 8 - bs.vbits, diff), "w={w:#x}");
            }
        }
    }
}
