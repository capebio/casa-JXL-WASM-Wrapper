//! Nikon High Efficiency (HE / HE*) NEF decoder.
//!
//! HE/HE* NEF stores the sensor as an **intoPIX TicoRAW** codestream, which is
//! ISO/IEC 21122 **JPEG XS** with a vendor-extended picture header. It reuses NEF
//! compression tag 34713, so `panasonic::decode_nef` routes here when the SubIFD
//! strip begins with the JPEG XS SOC marker `FF 10`.
//!
//! The wire format was reverse-engineered clean-room from the open SVT-JPEG-XS
//! reference (BSD-2-Clause-Patent) — see `blizz/docs/NEF-HE-CRACKED-2026-09-01.md`.
//! Key facts baked in here: GCLI unary VLC is a **leading-ONES** run; packets are
//! in **component order** (pkt0=green g, pkt1=green-diff dg, pkt2=red-diff dr
//! [undecomposed], pkt3=blue-diff db); the first precinct of each slice is
//! pred-from-zero + all-significant, the rest use vertical prediction with per-band
//! significance; DATA/SIGN sub-regions are located by the packet header's gl/dl.
//!
//! STATUS: **experimental / reduced resolution.** This reconstructs each component
//! from its coarse pyramid (LL + horizontal detail) via the 5/3 inverse, at half
//! vertical resolution (the vertical-detail bands and most chroma detail that HE
//! discards are not reassembled), then inverse-Star-Tetrix to a Bayer mosaic scaled
//! to the sensor dimensions. Good enough to *open* an HE NEF; not a lossless match
//! to the camera pixels. Full-res needs the 2-D DWT over the detail bands.

use crate::panasonic::BayerImage;

// ---------------- MSB-first bit reader ----------------
struct Br<'a> {
    d: &'a [u8],
    byte: usize,
    bit: u8,
}
impl<'a> Br<'a> {
    fn at(d: &'a [u8], byte: usize) -> Self {
        Br { d, byte, bit: 0 }
    }
    fn rb(&mut self) -> u8 {
        if self.byte >= self.d.len() {
            return 0;
        }
        let b = (self.d[self.byte] >> (7 - self.bit)) & 1;
        self.bit += 1;
        if self.bit == 8 {
            self.bit = 0;
            self.byte += 1;
        }
        b
    }
    fn nib(&mut self) -> u8 {
        if self.byte >= self.d.len() {
            return 0;
        }
        if self.bit == 0 {
            let v = self.d[self.byte] >> 4;
            self.bit = 4;
            v
        } else {
            let v = self.d[self.byte] & 0xf;
            self.bit = 0;
            self.byte += 1;
            v
        }
    }
    fn al(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.byte += 1;
        }
    }
    fn vlc(&mut self) -> i32 {
        let mut o = 0i32;
        while o < 40 {
            if self.rb() == 0 {
                return o;
            }
            o += 1;
        }
        -1
    }
}

fn be16(d: &[u8], p: usize) -> usize {
    ((d[p] as usize) << 8) | d[p + 1] as usize
}
fn be24(d: &[u8], p: usize) -> usize {
    ((d[p] as usize) << 16) | ((d[p + 1] as usize) << 8) | d[p + 2] as usize
}
fn gcw(w: usize) -> usize {
    (w + 3) / 4
}

/// Parsed codestream geometry (the subset the decoder needs).
struct Hdr {
    decom_h: u8,
    decom_v: u8,
    /// per decomposed-comp band widths, index 0 = LL .. 4 = finest horizontal.
    widths: [usize; 5],
    gain: Vec<i32>,
    prio: Vec<i32>,
    comp_w: usize, // decomposed component width
    /// meaningful LL columns (band0 has trailing padding on Z9-class frames)
    ll_used: usize,
}

fn parse_header(s: &[u8]) -> Result<Hdr, String> {
    // walk markers from SOC. size fields count (size-field + payload).
    if be16(s, 0) != 0xff10 {
        return Err("NEF-HE: no SOC".into());
    }
    let (mut dh, mut dv) = (5u8, 1u8);
    let (mut gain, mut prio) = (Vec::new(), Vec::new());
    let mut frame_w = 8280usize;
    let mut p = 2usize;
    while p + 4 <= s.len() {
        let m = be16(s, p);
        p += 2;
        let sz = be16(s, p);
        match m {
            0xff12 => {
                let b = p + 2; // PIH payload
                if b + 23 > s.len() {
                    return Err("NEF-HE: short PIH".into());
                }
                frame_w = be16(s, b + 8);
                dh = s[b + 22] >> 4;
                dv = s[b + 22] & 0xf;
                p += sz;
            }
            0xff14 => {
                let b = p + 2;
                let n = (sz.saturating_sub(2)) / 2;
                for i in 0..n {
                    gain.push(s[b + i * 2] as i8 as i32);
                    prio.push(s[b + i * 2 + 1] as i32);
                }
                p += sz;
            }
            0xff20 => break, // SLH -> header done
            _ => {
                if sz < 2 {
                    return Err("NEF-HE: bad marker size".into());
                }
                p += sz;
            }
        }
    }
    if gain.is_empty() {
        return Err("NEF-HE: no weights table".into());
    }
    // component width = frame width (Sx=1). band widths via pi_compute (5/3, decom_h horiz + decom_v vert).
    let comp_w = frame_w;
    let widths = pyramid_widths(comp_w, dh, dv);
    // LL used cols: on the Z9 8280 frame the LL is 259 declared but ~130 meaningful.
    // Use half the LL width when it looks padded (declared width even & >= 8), else full.
    let ll_used = (widths[0] / 2).max(1);
    Ok(Hdr {
        decom_h: dh,
        decom_v: dv,
        widths,
        gain,
        prio,
        comp_w,
        ll_used,
    })
}

/// band-in-comp widths (LL=0 .. finest-horizontal=4) from pi_compute lifting.
fn pyramid_widths(comp_w: usize, decom_h: u8, decom_v: u8) -> [usize; 5] {
    // Each vertical split halves width (quadrants are comp_w/2 wide). Then the LL quadrant is
    // split horizontally decom_h-decom_v times; each split's HIGH half is a detail band, the LOW
    // half continues. For 8280/(v1,h5): LL quad 4140 ->(x4)-> 2070,1035,517,259 detail, LL 259.
    let mut cur = comp_w >> decom_v; // LL-quadrant width after vertical split(s)
    let hsplits = decom_h.saturating_sub(decom_v) as usize;
    let mut detail = Vec::new(); // high halves, coarse->fine
    for _ in 0..hsplits {
        let w2 = cur / 2; // detail (high)
        let w1 = cur - w2; // low continues
        detail.push(w2);
        cur = w1;
    }
    // band-in-comp order: [LL, finest-detail .. coarsest-detail]
    let mut out = [1usize; 5];
    out[0] = cur; // LL
    for (i, w) in detail.iter().rev().enumerate() {
        if i + 1 < 5 {
            out[i + 1] = *w;
        }
    }
    out
}

fn gtli(gain: i32, prio: i32, q: i32, r: i32) -> i32 {
    let pump = if prio < r { 1 } else { 0 };
    if q < gain + pump {
        0
    } else {
        (q - gain - pump).min(15)
    }
}

/// Decode one all-significant / vpred packet. Bands given as (width, gain, prio).
/// `first` = pred-from-zero (first precinct of slice); else vertical prediction from `prevg`.
fn decode_packet(
    d: &[u8],
    p: usize,
    bands: &[(usize, i32, i32)],
    q: i32,
    r: i32,
    first: bool,
    prevg: &mut Vec<Vec<i32>>,
    prevt: &mut Vec<i32>,
) -> Vec<Vec<i32>> {
    // packet header (7-byte long): raw(1) dl(20) gl(20) sl(15)
    let m = &d[p..(p + 7).min(d.len())];
    if m.len() < 7 {
        return bands.iter().map(|&(w, _, _)| vec![0i32; w]).collect();
    }
    let dl =
        (((m[0] as usize) & 0x7f) << 13) | ((m[1] as usize) << 5) | (((m[2] as usize) >> 3) & 0x1f);
    let gl = (((m[2] as usize) & 0x07) << 17)
        | ((m[3] as usize) << 9)
        | ((m[4] as usize) << 1)
        | ((m[5] as usize) >> 7);
    // flat significance region, byte-aligned
    let total: usize = bands.iter().map(|&(w, _, _)| gcw(w)).sum();
    let nflags = (total + 7) / 8;
    let mut sb = Br::at(d, p + 7);
    let sf: Vec<u8> = (0..nflags).map(|_| sb.rb()).collect();
    sb.al();
    let gstart = sb.byte;
    let mut br = Br::at(d, gstart);
    let mut gclis: Vec<Vec<i32>> = Vec::new();
    let mut cum = 0usize;
    for (bi, &(w, gain, prio)) in bands.iter().enumerate() {
        let gw = gcw(w);
        let t = gtli(gain, prio, q, r);
        let mut gc = vec![t; gw];
        if first {
            for grp in 0..gw {
                gc[grp] = t + br.vlc().max(0);
                cum += 1;
            }
        } else {
            let tt = prevt[bi].max(t);
            for grp in 0..gw {
                let top = if grp < prevg[bi].len() { prevg[bi][grp] } else { t };
                let m_top = top.max(tt);
                if cum / 8 < sf.len() && sf[cum / 8] == 0 {
                    let x = br.vlc().max(0);
                    let thr = (m_top - t).max(0);
                    let delta = if x > 2 * thr {
                        x - thr
                    } else if x > 0 {
                        if x & 1 == 1 {
                            -((x + 1) / 2)
                        } else {
                            x / 2
                        }
                    } else {
                        0
                    };
                    gc[grp] = m_top + delta;
                } else {
                    gc[grp] = m_top;
                }
                cum += 1;
            }
        }
        gclis.push(gc);
    }
    // DATA at gstart+gl (header-located), SIGN at gstart+gl+dl
    let mut bd = Br::at(d, gstart + gl);
    let mut coeffs: Vec<Vec<i32>> = Vec::new();
    let mut lsign = vec![0usize; bands.len()];
    for (bi, &(w, gain, prio)) in bands.iter().enumerate() {
        let gw = gcw(w);
        let t = gtli(gain, prio, q, r);
        let mut co = vec![0i32; gw * 4];
        for grp in 0..gw {
            let size = gclis[bi][grp] - t;
            if size <= 0 {
                continue;
            }
            let size = size.min(31);
            let mut tmp = [0u32; 4];
            for _ in 0..(size - 1) {
                let val = bd.nib() as u32;
                tmp[3] = (tmp[3] | (val & 1)) << 1;
                tmp[2] = (tmp[2] | (val & 2)) << 1;
                tmp[1] = (tmp[1] | (val & 4)) << 1;
                tmp[0] = (tmp[0] | (val & 8)) << 1;
            }
            let val = bd.nib() as u32;
            co[grp * 4 + 3] = (((tmp[3] | (val & 1)) >> 0) << t) as i32;
            co[grp * 4 + 2] = (((tmp[2] | (val & 2)) >> 1) << t) as i32;
            co[grp * 4 + 1] = (((tmp[1] | (val & 4)) >> 2) << t) as i32;
            co[grp * 4 + 0] = (((tmp[0] | (val & 8)) >> 3) << t) as i32;
        }
        if w % 4 != 0 {
            for i in w..gw * 4 {
                if co[i] != 0 {
                    lsign[bi] += 1;
                }
            }
        }
        co.truncate(w);
        coeffs.push(co);
    }
    let mut bs = Br::at(d, gstart + gl + dl);
    for (bi, &(w, _, _)) in bands.iter().enumerate() {
        for i in 0..w {
            if coeffs[bi][i] != 0 && bs.rb() == 1 {
                coeffs[bi][i] = -coeffs[bi][i];
            }
        }
        for _ in 0..lsign[bi] {
            bs.rb();
        }
    }
    for bi in 0..bands.len() {
        prevg[bi] = gclis[bi].clone();
        prevt[bi] = gtli(bands[bi].1, bands[bi].2, q, r);
    }
    coeffs
}

/// exact JPEG XS 5/3 inverse (idwt_horizontal_line, shift 0)
///
/// **Every add and subtract here is checked, and `None` means refuse.** The
/// lifting steps are the one place in this decoder where a misread coefficient
/// becomes an arithmetic fault rather than a wrong pixel: `size` in
/// [`decode_packet`] is only clamped to 31 bitplanes and is then shifted left by
/// the truncation level, so a stream this decoder does not model can hand these
/// lines values within a factor of two of `i32::MAX` and the very next `+`
/// leaves the type.
///
/// It is not hypothetical. Measured 2026-09-08 over the seven corpus files whose
/// strip begins `FF 10`: the four Z 9 bodies synthesise fine, and all three of
/// `8bit-compressed-other__Z6_3`, `__Z5_2` and `__Z50_2` overflowed here — the
/// panic the SOC routing first exposed. Under `panic = "abort"` that is a crash;
/// in a release build, where Rust does not check `+`, it was worse: the same
/// three files wrapped silently and would have produced a plane out of numbers
/// that mean nothing. Refusing is the only answer that is right in both
/// profiles.
fn idwt(lf: &[i32], hf: &[i32]) -> Option<Vec<i32>> {
    let len = lf.len() + hf.len();
    let mut out = vec![0i32; len];
    if len < 2 {
        if len == 1 {
            out[0] = *lf.first()?;
        }
        return Some(out);
    }
    out[0] = lf.first()?.checked_sub((hf.first()?.checked_add(1)?) >> 1)?;
    let (mut li, mut hi, mut oi) = (0usize, 0usize, 0usize);
    let mut i = 1usize;
    while i + 2 < len {
        let h2 = hf.get(hi)?.checked_add(*hf.get(hi + 1)?)?.checked_add(2)?;
        out[oi + 2] = lf.get(li + 1)?.checked_sub(h2 >> 2)?;
        out[oi + 1] = hf.get(hi)?.checked_add(out[oi].checked_add(out[oi + 2])? >> 1)?;
        li += 1;
        hi += 1;
        oi += 2;
        i += 2;
    }
    if len & 1 == 1 {
        out[oi + 2] = lf.get(li + 1)?.checked_sub(hf.get(hi)?.checked_add(1)? >> 1)?;
        out[oi + 1] = hf.get(hi)?.checked_add(out[oi].checked_add(out[oi + 2])? >> 1)?;
    } else {
        out[oi + 1] = hf.get(hi)?.checked_add(out[oi])?;
    }
    Some(out)
}

/// horizontal synthesis of a coarse pyramid: LL + 4 horizontal-detail bands -> full-width row.
///
/// `None` propagates [`idwt`]'s refusal.
fn synth_row(co: &[Vec<i32>]) -> Option<Vec<i32>> {
    let mut low = co.first()?.clone();
    for k in 1..co.len().min(5) {
        low = idwt(&low, &co[k])?;
    }
    Some(low)
}

pub fn decode(
    d: &[u8],
    off: usize,
    len: usize,
    w: usize,
    h: usize,
    make: String,
    model: String,
    // Both read from the file by `decode_nef`, which owns the sensor SubIFD and
    // the MakerNote. This module used to hardcode them; see the construction at
    // the end of this function for what that cost.
    cfa_phase: (u8, u8),
    wb: (f32, f32, f32),
) -> Result<BayerImage, String> {
    let end = off.checked_add(len).ok_or("NEF-HE: strip overflow")?;
    if end > d.len() {
        return Err("NEF-HE: strip out of range".into());
    }
    let s = &d[off..end];
    let hdr = parse_header(s)?;

    // global band index -> (comp slot 0..2, band-in-comp 0..4) for the coarse pyramids.
    // packet order = component order: pkt0 comp0(g), pkt1 comp1(dg), pkt2 comp2(dr undecomp),
    // pkt3 comp3(db). Global band = level*3 + slot for the 3 decomposed comps.
    let gains = &hdr.gain;
    let prios = &hdr.prio;
    let bandinfo = |slot: usize| -> Vec<(usize, i32, i32)> {
        (0..5)
            .map(|lvl| {
                let g = lvl * 3 + slot;
                (
                    hdr.widths[lvl],
                    *gains.get(g).unwrap_or(&0),
                    *prios.get(g).unwrap_or(&0),
                )
            })
            .collect()
    };
    // comp2 (dr) undecomposed: global band 24, width = comp_w (use half like the LL padding).
    let dr_w = (hdr.comp_w / 2).max(1);
    let dr_band = vec![(
        dr_w,
        *gains.get(24).unwrap_or(&0),
        *prios.get(24).unwrap_or(&0),
    )];

    // locate slices
    let mut slh = Vec::new();
    let mut i = 0usize;
    while i + 4 < s.len() {
        if be16(s, i) == 0xff20 && be16(s, i + 2) == 0x0004 {
            slh.push(i);
            i += 6;
        } else {
            i += 1;
        }
    }
    slh.push(s.len());
    if slh.len() < 2 {
        return Err("NEF-HE: no slices".into());
    }
    let nsl = slh.len() - 1;

    // count precinct rows
    let mut rows = 0usize;
    for si in 0..nsl {
        let mut p = slh[si] + 6;
        let e = slh[si + 1];
        while p + 12 < e && p + 12 < s.len() {
            let plen = be24(s, p);
            if plen == 0 || plen > 1_048_575 || p + 12 + plen > s.len() {
                break;
            }
            rows += 1;
            p += 12 + plen;
            if p + 2 <= s.len() && be16(s, p) == 0xff20 {
                break;
            }
        }
    }
    if rows == 0 {
        return Err("NEF-HE: no precincts".into());
    }

    let fw = hdr.widths.iter().sum::<usize>().max(hdr.comp_w / 2); // full-width after horiz synth
    let cw = fw; // component reconstructed width
    // component planes at cw x rows
    let mut pg: Vec<i64> = vec![0; cw * rows]; // g
    let mut pdg: Vec<i64> = vec![0; cw * rows];
    let mut pdb: Vec<i64> = vec![0; cw * rows];
    let mut pdr: Vec<i64> = vec![0; cw * rows];

    let mut row = 0usize;
    for si in 0..nsl {
        let e = slh[si + 1];
        let mut p = slh[si] + 6;
        let mut first = true;
        let mut pg0 = vec![Vec::new(); 5];
        let mut pt0 = vec![0i32; 5];
        let mut pg1 = vec![Vec::new(); 5];
        let mut pt1 = vec![0i32; 5];
        let mut pg3 = vec![Vec::new(); 5];
        let mut pt3 = vec![0i32; 5];
        let mut pg2 = vec![Vec::new(); 1];
        let mut pt2 = vec![0i32; 1];
        while p + 12 < e && p + 12 < s.len() {
            let plen = be24(s, p);
            if plen == 0 || plen > 1_048_575 || p + 12 + plen > s.len() {
                break;
            }
            let q = s[p + 3] as i32;
            let r = s[p + 4] as i32;
            let data0 = p + 5 + (25 * 2 + 7) / 8;
            // packet offsets via header walk (sig=17 constant on Z9-class)
            let mut pp = data0;
            let mut offs = [0usize; 8];
            for pk in 0..8 {
                offs[pk] = pp;
                if pp + 7 > data0 + plen {
                    break;
                }
                let m = &s[pp..(pp + 7).min(s.len())];
                if m.len() < 7 {
                    break;
                }
                let dl = (((m[0] as usize) & 0x7f) << 13)
                    | ((m[1] as usize) << 5)
                    | (((m[2] as usize) >> 3) & 0x1f);
                let gl = (((m[2] as usize) & 0x07) << 17)
                    | ((m[3] as usize) << 9)
                    | ((m[4] as usize) << 1)
                    | ((m[5] as usize) >> 7);
                let sl = (((m[5] as usize) & 0x7f) << 8) | (m[6] as usize);
                pp += 7 + 17 + gl + dl + sl;
            }
            let c0 = decode_packet(s, offs[0], &bandinfo(0), q, r, first, &mut pg0, &mut pt0);
            let c1 = decode_packet(s, offs[1], &bandinfo(1), q, r, first, &mut pg1, &mut pt1);
            let c3 = decode_packet(s, offs[3], &bandinfo(2), q, r, first, &mut pg3, &mut pt3);
            let c2 = decode_packet(s, offs[2], &dr_band, q, r, first, &mut pg2, &mut pt2);
            if row < rows {
                // A refusal here means the coefficients are not what this
                // decoder models — Z 9 class only, see `idwt`. Naming the row is
                // what turns "it panicked somewhere" into a reportable finding.
                let bad = || format!("NEF-HE: coefficients out of range at precinct row {row} — this decoder models the Z 9 codestream only");
                let sg = synth_row(&c0).ok_or_else(bad)?;
                let sdg = synth_row(&c1).ok_or_else(bad)?;
                let sdb = synth_row(&c3).ok_or_else(bad)?;
                for x in 0..cw {
                    pg[row * cw + x] = *sg.get(x).unwrap_or(&0) as i64;
                    pdg[row * cw + x] = *sdg.get(x).unwrap_or(&0) as i64;
                    pdb[row * cw + x] = *sdb.get(x).unwrap_or(&0) as i64;
                    // comp2 dr: undecomposed, width dr_w; stretch to cw
                    let sx = x * dr_w / cw;
                    pdr[row * cw + x] = *c2[0].get(sx).unwrap_or(&0) as i64;
                }
            }
            row += 1;
            first = false;
            p += 12 + plen;
            if p + 2 <= s.len() && be16(s, p) == 0xff20 {
                break;
            }
        }
    }

    // inverse Star-Tetrix -> Bayer channels R, G1, G2, B (comp res cw x rows)
    // g=(G1+G2)/2, dg=G2-G1, dr=R-g, db=B-g
    // build a Bayer mosaic at cw*2 x rows*2 then resample to (w,h).
    let mw = cw * 2;
    let mh = rows * 2;
    let mut mos = vec![0f32; mw * mh];
    for y in 0..rows {
        for x in 0..cw {
            let g = pg[y * cw + x] as f32;
            let dg = pdg[y * cw + x] as f32;
            let db = pdb[y * cw + x] as f32;
            let dr = pdr[y * cw + x] as f32;
            let g1 = g - dg / 2.0;
            let g2 = g + dg / 2.0;
            let rr = dr + g;
            let bb = db + g;
            // RGGB: R at (2x,2y), G1 (2x+1,2y), G2 (2x,2y+1), B (2x+1,2y+1)
            let put = |mos: &mut Vec<f32>, xx: usize, yy: usize, v: f32| {
                if xx < mw && yy < mh {
                    mos[yy * mw + xx] = v;
                }
            };
            put(&mut mos, 2 * x, 2 * y, rr);
            put(&mut mos, 2 * x + 1, 2 * y, g1);
            put(&mut mos, 2 * x, 2 * y + 1, g2);
            put(&mut mos, 2 * x + 1, 2 * y + 1, bb);
        }
    }
    // robust bounds (2nd/98th percentile) reject the band0 padding-tail outliers.
    let mut sorted: Vec<f32> = mos.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mn = sorted[sorted.len() * 2 / 100];
    let mx = sorted[sorted.len() * 98 / 100];
    let span = (mx - mn).max(1.0);
    // map into a raw-ish range with black at 1008 and highlight headroom (matches the Nikon
    // black level blkb reinserts for this model, so its black-subtract + WB + matrix behaves).
    let black = 1008.0f32;
    let range = 7000.0f32;
    let white = 16383u16;
    let mut raw = vec![0u16; w * h];
    for y in 0..h {
        let sy = (y * mh / h).min(mh - 1);
        for x in 0..w {
            let sx = (x * mw / w).min(mw - 1);
            let v = ((mos[sy * mw + sx] - mn) / span).clamp(0.0, 1.0);
            raw[y * w + x] = (black + v * range) as u16;
        }
    }

    let _ = (hdr.decom_h, hdr.decom_v, hdr.ll_used);
    Ok(BayerImage {
        width: w,
        height: h,
        raw,
        cfa_phase,
        black: 0,
        white,
        // **These were hardcoded to 1.7051 / 1.0 / 1.5449 and they are one file's
        // numbers.** That is the as-shot white balance of `nikon_z9_he`, read
        // from its MakerNote 0x000C and then frozen into the source, so every
        // other HE body silently inherited it: the Z 9 HE* files carry 1.546875
        // where this claimed 1.544921875, and any future body could be as far out
        // as the 68% the ordinary NEF path's placeholder was on a Z 6. The caller
        // reads the tag; this takes what it read.
        //
        // NOTE, unchanged and still true: this experimental reconstruction is not
        // in true sensor-raw balance (R≈g, B≈g), so a viewer applying this WB
        // plus a camera matrix casts magenta — correct pipeline, wrong-units input.
        wb_r: wb.0,
        wb_g: wb.1,
        wb_b: wb.2,
        make,
        model: format!("{model} [HE experimental]"),
        strip: off..end,
    })
}

#[cfg(test)]
mod tests {
    use crate::panasonic::decode_nef;

    /// **An HE body this decoder does not model must refuse, not overflow.**
    ///
    /// `decode_packet` clamps a group's bitplane count only to 31 and then
    /// shifts it left by the truncation level, so a codestream shaped unlike the
    /// Z 9's hands [`super::idwt`] values near `i32::MAX`. Before the checked
    /// arithmetic went in, all three of these files panicked at the same lifting
    /// step — and in a release build, where `+` is not checked, they wrapped
    /// silently instead, which is worse.
    ///
    /// Measured 2026-09-08 across every corpus file whose strip begins `FF 10`:
    /// the four Z 9 HE/HE* files synthesise (8280x5520, max 8008), and these
    /// three refuse — Z 6 III at precinct row 157, Z 5 II at 213, Z 50 II at 95.
    /// Only the small ones are here; a Z 9 decode is ~45 s, which is what
    /// [`the_z9_codestream_this_decoder_does_model_still_decodes`] costs and why
    /// it is ignored by default.
    #[test]
    fn an_he_body_this_decoder_does_not_model_refuses_rather_than_overflowing() {
        for name in
            ["8bit-compressed-other__Z6_3", "8bit-compressed-other__Z5_2", "8bit-compressed-other__Z50_2"]
        {
            let p = format!(r"C:\Foo\raw-converter\tests\NEF Raws\{name}.NEF");
            let Ok(d) = std::fs::read(&p) else {
                eprintln!("skipped: {p} not present");
                continue;
            };
            let e = decode_nef(&d).expect_err("must refuse rather than overflow");
            assert!(
                e.starts_with("NEF-HE:"),
                "{name} must reach the HE decoder and be refused by it, got: {e}"
            );
            assert!(e.contains("out of range"), "{name}: unhelpful refusal: {e}");
        }
    }

    /// **The Z 9 arm still works.** The guard above must refuse the bodies this
    /// decoder cannot read without also refusing the one it can, so this is the
    /// other half of the same measurement: 8280x5520, every sample non-zero,
    /// maximum 8008.
    ///
    /// Ignored by default because it decodes 17 MB of codestream at roughly 45 s
    /// a file. Run it with `cargo test --lib -- --ignored`.
    #[test]
    #[ignore = "~45 s: decodes a full 8280x5520 Z 9 HE codestream"]
    fn the_z9_codestream_this_decoder_does_model_still_decodes() {
        const F: &str = r"C:\Foo\raw-converter\tests\raw-pixls\nikon_z9_he.NEF";
        let Ok(d) = std::fs::read(F) else {
            eprintln!("skipped: {F} not present");
            return;
        };
        let b = decode_nef(&d).expect("a Z 9 HE NEF must decode");
        assert_eq!((b.width, b.height), (8280, 5520));
        assert_eq!(b.raw.len(), b.width * b.height);
        assert!(b.raw.iter().all(|&v| v != 0), "a blank plane is not a decode");
        assert_eq!(b.raw.iter().copied().max().unwrap(), 8008);
        // From the file's MakerNote 0x000C, not from this module. The HE* sibling
        // records 1.546875 for blue, which is what the old hardcode got wrong;
        // `panasonic::tests::the_he_bodies_have_their_own_white_balance_to_read`
        // pins that half without paying for a decode.
        assert_eq!((b.wb_r, b.wb_g, b.wb_b), (1.705078125, 1.0, 1.544921875));
    }

    /// **`idwt` refuses instead of wrapping, and this is the check that can
    /// fail.** Two lines that overflow at the first lifting step, and one
    /// ordinary pair that must still synthesise, so a `None`-always regression
    /// is caught as loudly as a panic.
    #[test]
    fn the_lifting_step_refuses_coefficients_it_cannot_add() {
        assert_eq!(super::idwt(&[10, 20], &[4]), Some(vec![8, 17, 18]));
        assert_eq!(super::idwt(&[i32::MIN, 0], &[i32::MAX]), None);
        assert_eq!(super::idwt(&[0, 0, 0], &[i32::MAX, i32::MAX]), None);
    }
}
