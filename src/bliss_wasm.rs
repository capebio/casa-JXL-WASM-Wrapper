use wasm_bindgen::prelude::*;
use bliss_core::Opts;

fn to_js_err(e: bliss_core::Error) -> JsValue {
    use bliss_core::Error::*;
    let code = match &e {
        BadMagic => "BadMagic",
        BadHeader(_) => "BadHeader",
        Truncated => "Truncated",
        OddWidth => "OddWidth",
        Cancelled => "Cancelled",
    };
    JsValue::from_str(&format!("{}: {}", code, e))
}

/// Encode an even-width RGB24 buffer as BLISS bytes.
/// q_y=1, q_c=1 → lossless.  q_y=2, q_c=2 → near-lossless (good for display cache).
/// Also accepts BLSP-prefixed blobs on decode side (transparent).
#[wasm_bindgen]
pub fn bliss_encode(rgb: &[u8], w: u32, h: u32, q_y: u8, q_c: u8) -> Result<Vec<u8>, JsValue> {
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 || w % 2 != 0 {
        return Err(JsValue::from_str("bliss_encode: w must be even and non-zero"));
    }
    let bands = bliss_core::default_bands(h);
    let result = if q_y == 1 && q_c == 1 {
        bliss_core::encode_opts(rgb, w, h, bands, Opts::default())
    } else {
        bliss_core::encode_lossy(rgb, w, h, bands, q_y, q_c)
    };
    result.map_err(to_js_err)
}

/// Encode with NEAR in-loop near-lossless (hard per-channel error bounds).
/// delta_y / delta_c control max luma / chroma error (1 = lossless, 2 = very tight, …).
/// Decoded by the ordinary `bliss_decode`.
#[wasm_bindgen]
pub fn bliss_encode_near(rgb: &[u8], w: u32, h: u32, delta_y: u8, delta_c: u8) -> Result<Vec<u8>, JsValue> {
    let (w, h) = (w as usize, h as usize);
    bliss_core::encode_near(rgb, w, h, bliss_core::default_bands(h), delta_y, delta_c)
        .map_err(to_js_err)
}

/// Encode with per-gradient-context NEAR delta tables (4 luma + 4 chroma contexts).
/// dys / dcs must each be a Uint8Array of length 4.
/// Context 0 = flat, 1 = low gradient, 2 = mid, 3 = high — tighter deltas where edges matter.
#[wasm_bindgen]
pub fn bliss_encode_near_ctx(rgb: &[u8], w: u32, h: u32, dys: &[u8], dcs: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (w, h) = (w as usize, h as usize);
    let dy: [u8; 4] = dys.try_into().map_err(|_| JsValue::from_str("dys must be 4 bytes"))?;
    let dc: [u8; 4] = dcs.try_into().map_err(|_| JsValue::from_str("dcs must be 4 bytes"))?;
    bliss_core::encode_near_ctx(rgb, w, h, bliss_core::default_bands(h), dy, dc)
        .map_err(to_js_err)
}

/// Encode RGB24 with an embedded 1/8-scale NEAR preview prefix (BLSP layout).
///
/// The returned blob starts with BLSP magic:
///   `[BLSP][u32 preview_len][preview BLSR][full BLSR]`
///
/// `bliss_decode_preview` extracts the ~10–50× faster thumbnail.
/// `bliss_decode` skips the prefix and decodes the full layer transparently.
/// q_y=1, q_c=1 → lossless full layer; otherwise near-lossless. preview_delta=2 is a good default.
#[wasm_bindgen]
pub fn bliss_encode_with_preview(
    rgb: &[u8], w: u32, h: u32, q_y: u8, q_c: u8, preview_delta: u8,
) -> Result<Vec<u8>, JsValue> {
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 || w % 2 != 0 {
        return Err(JsValue::from_str("bliss_encode_with_preview: w must be even and non-zero"));
    }
    let bands = bliss_core::default_bands(h);
    let full = if q_y == 1 && q_c == 1 {
        bliss_core::encode_opts(rgb, w, h, bands, Opts::default())
    } else {
        bliss_core::encode_lossy(rgb, w, h, bands, q_y, q_c)
    }
    .map_err(to_js_err)?;
    // 1/8-scale NEAR preview — same formula as bliss_core::wrap_preview (which is pub(crate)).
    let (prgb, pw, ph) = bliss_core::downscale_box8(rgb, w, h);
    let preview = bliss_core::encode_near(&prgb, pw, ph, 1, preview_delta, preview_delta)
        .map_err(to_js_err)?;
    let mut out = Vec::with_capacity(8 + preview.len() + full.len());
    out.extend_from_slice(bliss_core::PREVIEW_MAGIC);
    out.extend_from_slice(&(preview.len() as u32).to_le_bytes());
    out.extend_from_slice(&preview);
    out.extend_from_slice(&full);
    Ok(out)
}

/// Decode BLISS bytes → RGB24.  Returns a flat `Uint8Array` [r,g,b, r,g,b, …].
/// Dimensions are prepended as two little-endian u32s (8 bytes total) so the
/// caller can read width and height without a separate call.
///
/// Layout: [width u32 LE][height u32 LE][rgb bytes…]
/// Also accepts BLSP-prefixed blobs (skips the preview, decodes the full layer).
#[wasm_bindgen]
pub fn bliss_decode(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (rgb, w, h) = bliss_core::decode(data).map_err(to_js_err)?;
    let mut out = Vec::with_capacity(8 + rgb.len());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    out.extend_from_slice(&rgb);
    Ok(out)
}

/// Decode only the embedded 1/8-scale preview from a BLSP-prefixed blob.
/// Returns [width u32 LE][height u32 LE][rgb bytes…] — same layout as `bliss_decode`.
/// Typically 10–50× faster than a full decode; data must start with the BLSP magic.
/// Errors with "BadMagic: …" if the blob lacks a BLSP prefix.
#[wasm_bindgen]
pub fn bliss_decode_preview(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (rgb, w, h) = bliss_core::decode_preview(data).map_err(to_js_err)?;
    let mut out = Vec::with_capacity(8 + rgb.len());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    out.extend_from_slice(&rgb);
    Ok(out)
}
