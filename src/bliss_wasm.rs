use wasm_bindgen::prelude::*;
use bliss_core::Opts;

/// Encode an even-width RGB24 buffer as BLISS bytes.
/// q_y=1, q_c=1 → lossless.  q_y=2, q_c=2 → near-lossless (good for display cache).
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
    result.map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Decode BLISS bytes → RGB24.  Returns a flat `Uint8Array` [r,g,b, r,g,b, …].
/// Dimensions are prepended as two little-endian u32s (8 bytes total) so the
/// caller can read width and height without a separate call.
///
/// Layout: [width u32 LE][height u32 LE][rgb bytes…]
#[wasm_bindgen]
pub fn bliss_decode(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (rgb, w, h) = bliss_core::decode(data)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut out = Vec::with_capacity(8 + rgb.len());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    out.extend_from_slice(&rgb);
    Ok(out)
}
