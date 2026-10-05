//! Quick-look render of a DNG through OUR decoder, for visual side-by-sides
//! against the file's own embedded JPEG preview. Not a product render path:
//! half-res demosaic for Bayer, direct channels for Linear DNG, AsShot WB,
//! percentile auto-exposure, sRGB-ish gamma. Usage:
//!   dng_render <in.dng> <out.png> [max_dim]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: dng_render <in.dng> <out.png> [max_dim]");
        std::process::exit(1);
    }
    let max_dim: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1100);
    let data = std::fs::read(&a[1]).expect("read");
    let mut img = raw_pipeline::dng::decode_bytes(&data).expect("decode");
    img.crop_to_active_area();
    // Apply the LinearizationTable: `raw` holds STORED codes; every
    // white-level and PGTM computation below lives in the LINEAR domain.
    if !img.linearization_table.is_empty() {
        let t = &img.linearization_table;
        for v in img.raw.iter_mut() {
            *v = t[(*v as usize).min(t.len() - 1)];
        }
    }
    let (w, h, cps) = (img.width, img.height, img.samples_per_pixel);

    // Linear RGB at full res: either direct channels (Linear DNG) or a
    // half-res 2x2 demosaic (Bayer).
    let (lw, lh, mut rgb): (usize, usize, Vec<f32>) = if cps == 3 {
        let v: Vec<f32> = img.raw.iter().map(|&s| s as f32).collect();
        (w, h, v)
    } else {
        // cfa phase of the red pixel
        let (rx, ry) = raw_pipeline::dng::cfa_phase(img.cfa);
        let (rx, ry) = (rx as usize, ry as usize);
        let (hw, hh) = (w / 2, h / 2);
        let mut v = vec![0f32; hw * hh * 3];
        let black = img.black as f32;
        for y in 0..hh {
            for x in 0..hw {
                let px = |ox: usize, oy: usize| -> f32 {
                    (img.raw[(2 * y + oy) * w + 2 * x + ox] as f32 - black).max(0.0)
                };
                let r = px(rx, ry);
                let b = px(1 - rx, 1 - ry);
                let g = (px(1 - rx, ry) + px(rx, 1 - ry)) * 0.5;
                let o = (y * hw + x) * 3;
                v[o] = r;
                v[o + 1] = g;
                v[o + 2] = b;
            }
        }
        (hw, hh, v)
    };

    // ── The DNG color pipeline, driven by what the file carries ──────────

    // The Bradford-adapted ColorMatrix path, for files WITHOUT a ForwardMatrix
    // (Apple): needs (and must not have) separate WB multipliers. This replaces
    // the earlier "CM path is never safe" bail-out, whose magenta was exactly
    // the missing adaptation.
    let cm_bradford: Option<[[f32; 3]; 3]> = if img.forward_matrix.is_none() {
        img.color_matrix
            .and_then(|fused| raw_pipeline::dng::color_matrix_bradford(fused, img.wb_r, img.wb_b))
    } else {
        None
    };

    if let Some(m) = cm_bradford {
        // Whole transform in one matrix, applied to UNBALANCED camera RGB.
        for p in rgb.chunks_exact_mut(3) {
            let (r, g, b) = (p[0], p[1], p[2]);
            for c in 0..3 {
                p[c] = (m[c][0] * r + m[c][1] * g + m[c][2] * b).max(0.0);
            }
        }
    } else {
        // WB sanity (gray-world gate): WB only if it moves the channel means
        // toward equal; some Linear DNGs store already-balanced channels.
        if raw_pipeline::dng::wb_moves_toward_grey(&rgb, img.wb_r, img.wb_b) {
            for p in rgb.chunks_exact_mut(3) {
                p[0] *= img.wb_r;
                p[2] *= img.wb_b;
            }
        }
        // ForwardMatrix path: fused = XYZ2SRGB·FM expects white-balanced input.
        if img.forward_matrix.is_some() {
            if let Some(m) = img.color_matrix {
                for p in rgb.chunks_exact_mut(3) {
                    let (r, g, b) = (p[0], p[1], p[2]);
                    for c in 0..3 {
                        p[c] = (m[c][0] * r + m[c][1] * g + m[c][2] * b).max(0.0);
                    }
                }
            }
        }
    }
    // Exposure: highlight-anchored (the LinearizationTable we deliberately do
    // not model is linear-to-first-order, so it folds into this one scale).
    let anchor = |rgb: &[f32]| -> f32 {
        let mut greens: Vec<f32> = rgb.chunks_exact(3).map(|p| p[1]).collect();
        greens.sort_by(|a, b| a.partial_cmp(b).unwrap());
        1.0 / greens[((greens.len() - 1) as f64 * 0.997) as usize].max(1.0)
    };
    let scale = anchor(&rgb);

    // ProfileGainTableMap — Apple ProRAW's local tone map, the "Apple look".
    // Reference: dng_sdk RefBaselineProfileGainTableMap. Applied to the
    // normalized linear RGB (exposure already in `scale`, so no extra
    // exposure factor on the weight), before the tone curve. Trilinear:
    // spatial grid x weighted-input table index; one gain multiplies R,G,B.
    if let Some(m) = &img.profile_gain_table_map {
        let (pv, ph) = (m.points_v as usize, m.points_h as usize);
        let nt = m.num_table_points as usize;
        // The reference feeds the weight dot-product camera-linear values in
        // [0,1] (v / WhiteLevel, in the LINEARIZED domain — applied above)
        // times 2^BaselineExposure; highlights can sit above 1.0 before the
        // final weight clamp.
        let wscale = (2f32).powf(img.baseline_exposure) / (img.white as f32).max(1.0);
        for y in 0..lh {
            let v_img = (y as f64 + 0.5) / lh as f64;
            for x in 0..lw {
                let u_img = (x as f64 + 0.5) / lw as f64;
                let i = (y * lw + x) * 3;
                let p = [rgb[i] * wscale, rgb[i + 1] * wscale, rgb[i + 2] * wscale];
                let gain = m.gain(u_img, v_img, p);
                rgb[i] *= gain;
                rgb[i + 1] *= gain;
                rgb[i + 2] *= gain;
            }
        }
        eprintln!(
            "  PGTM applied: {}x{} grid x {} table points, weights {:?}",
            ph, pv, nt, m.map_input_weights
        );
        if std::env::var("PGTM_DEBUG").is_ok() {
            let cell = (pv / 2) * ph + ph / 2;
            let tb: Vec<f32> =
                (0..nt).step_by(nt / 8).map(|t| m.gains[cell * nt + t]).collect();
            let (mut gmin, mut gmax, mut gsum) = (f32::MAX, f32::MIN, 0f64);
            for g in &m.gains {
                gmin = gmin.min(*g);
                gmax = gmax.max(*g);
                gsum += *g as f64;
            }
            eprintln!(
                "  center-cell table (every {}th): {:?}",
                nt / 8,
                tb
            );
            eprintln!(
                "  all gains: min {gmin:.3} max {gmax:.3} mean {:.3}; wscale {wscale:.5}",
                gsum / m.gains.len() as f64
            );
        }
    }
    // Exposure after the gain map. Apple (PGTM) path: the file's OWN key —
    // v/WhiteLevel × 2^BaselineExposure — with an extended-Reinhard shoulder
    // whose white point is the max representable post-exposure value, standing
    // in for the reference pipeline's exposure ramp (which is why Apple's
    // lifts never clip). Everything else keeps the percentile anchor.
    let (scale, shoulder_wp) = if img.profile_gain_table_map.is_some() {
        let bev = (2f32).powf(img.baseline_exposure);
        (bev / (img.white as f32).max(1.0), Some(bev.max(1.001)))
    } else {
        (scale, None)
    };

    // The profile's own tone curve (linear→linear control points), when the
    // file carries one; sampled by piecewise-linear interpolation.
    let curve: Option<Vec<(f32, f32)>> = if img.profile_tone_curve.len() >= 4 {
        Some(
            img.profile_tone_curve
                .chunks_exact(2)
                .map(|p| (p[0], p[1]))
                .collect(),
        )
    } else {
        None
    };
    let tone = |v: f32| -> f32 {
        match &curve {
            Some(c) => {
                let x = v.clamp(0.0, 1.0);
                let i = c.partition_point(|&(cx, _)| cx <= x);
                if i == 0 {
                    c[0].1
                } else if i >= c.len() {
                    c[c.len() - 1].1
                } else {
                    let (x0, y0) = c[i - 1];
                    let (x1, y1) = c[i];
                    if x1 > x0 { y0 + (y1 - y0) * (x - x0) / (x1 - x0) } else { y0 }
                }
            }
            None => v,
        }
    };

    // Downscale by integer stride with box averaging, then gamma-encode.
    let s = (lw.max(lh)).div_ceil(max_dim).max(1);
    let (ow, oh) = (lw / s, lh / s);
    let mut out = image::RgbImage::new(ow as u32, oh as u32);
    for oy in 0..oh {
        for ox in 0..ow {
            let mut acc = [0f32; 3];
            for dy in 0..s {
                for dx in 0..s {
                    let i = ((oy * s + dy) * lw + ox * s + dx) * 3;
                    acc[0] += rgb[i];
                    acc[1] += rgb[i + 1];
                    acc[2] += rgb[i + 2];
                }
            }
            let n = (s * s) as f32;
            let q = |v: f32| -> u8 {
                let mut e = (v / n * scale).max(0.0);
                if let Some(wp) = shoulder_wp {
                    // Extended Reinhard: maps [0, wp] → [0, 1], soft knee.
                    e = e * (1.0 + e / (wp * wp)) / (1.0 + e);
                }
                let lin = tone(e.clamp(0.0, 1.0));
                let g = lin.clamp(0.0, 1.0).powf(1.0 / 2.2);
                // When the file supplied no tone curve, a mild s-curve toward
                // the camera-preview look; the profile curve replaces it.
                let out = if curve.is_some() {
                    g
                } else {
                    let sc = g * g * (3.0 - 2.0 * g);
                    g * 0.65 + sc * 0.35
                };
                ((out * 255.0) + 0.5) as u8
            };
            out.put_pixel(ox as u32, oy as u32, image::Rgb([q(acc[0]), q(acc[1]), q(acc[2])]));
        }
    }
    // Capture sharpening on the Apple path: the DNG stores Apple's pre-sharpening
    // image. Shared with the app's ProRAW decode. DNG_RENDER_NO_SHARPEN=1 skips
    // it (to measure it).
    if img.profile_gain_table_map.is_some() && std::env::var_os("DNG_RENDER_NO_SHARPEN").is_none() {
        let (ow, oh) = (out.width() as usize, out.height() as usize);
        raw_pipeline::pipeline::capture_sharpen_rgb8(&mut out, ow, oh, 0.9);
    }

    // Honor the EXIF orientation the way the embedded preview's viewer will.
    let out = match img.orientation {
        3 => image::imageops::rotate180(&out),
        6 => image::imageops::rotate90(&out),
        8 => image::imageops::rotate270(&out),
        _ => out,
    };
    out.save(&a[2]).expect("write png");
    println!(
        "{} -> {}x{} (spp={cps}, stride {s}, orient {})",
        a[1], ow, oh, img.orientation
    );
}
