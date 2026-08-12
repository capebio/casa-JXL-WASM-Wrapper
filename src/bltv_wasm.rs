use wasm_bindgen::prelude::*;

/// WASM-facing BLTV decoder.  Load the full .bltv byte stream once, then call
/// `decode_next_frame()` sequentially to get RGB24 frames at playback rate.
#[wasm_bindgen]
pub struct BltvDecoder {
    inner: bltv::Decoder,
    /// Reused RGBA staging for `decode_next_into` — no per-frame allocation.
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl BltvDecoder {
    /// Create a decoder from the full BLTV file bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<BltvDecoder, JsValue> {
        bltv::Decoder::new(data.to_vec())
            .map(|inner| BltvDecoder {
                inner,
                rgba: Vec::new(),
            })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn width(&self)       -> u32 { self.inner.width() }
    pub fn height(&self)      -> u32 { self.inner.height() }
    pub fn frame_count(&self) -> u32 { self.inner.frame_count() }
    pub fn fps_num(&self)     -> u32 { self.inner.fps_num() }
    pub fn fps_den(&self)     -> u32 { self.inner.fps_den() }
    pub fn is_lossless(&self) -> bool { self.inner.is_lossless() }

    /// Decode and return the next RGB24 frame as a `Uint8Array`, or `null` at end.
    pub fn decode_next_frame(&mut self) -> Result<Option<Vec<u8>>, JsValue> {
        match self.inner.decode_next() {
            None => Ok(None),
            Some(Ok(pixels)) => Ok(Some(pixels)),
            Some(Err(e)) => Err(JsValue::from_str(&e.to_string())),
        }
    }

    /// Decode the next frame as RGBA8 (alpha = 255) **into** the caller's
    /// `Uint8Array`, which must be exactly `width()*height()*4` bytes. Returns
    /// `true` with `out` filled, or `false` at end of stream (`out` untouched).
    ///
    /// Buffer flow is reversed vs `decode_next_frame`: JS keeps a pooled
    /// ArrayBuffer and no per-frame `Uint8Array`/RGBA buffer is allocated on
    /// either side — RGB→RGBA runs on the SIMD shuffle kernel wasm-side and
    /// `out` is filled with a single JS-side copy (`Uint8Array.set`), replacing
    /// the per-pixel main-thread JS loop in bltv-player.html.
    pub fn decode_next_into(&mut self, out: &js_sys::Uint8Array) -> Result<bool, JsValue> {
        let need = (self.inner.width() as usize) * (self.inner.height() as usize) * 4;
        if out.length() as usize != need {
            return Err(JsValue::from_str(&format!(
                "decode_next_into: out.length {} != width*height*4 = {}",
                out.length(),
                need
            )));
        }
        match self.inner.decode_next() {
            None => Ok(false),
            Some(Err(e)) => Err(JsValue::from_str(&e.to_string())),
            Some(Ok(rgb)) => {
                if self.rgba.len() != need {
                    self.rgba.resize(need, 0);
                }
                crate::rgb_to_rgba_into(&rgb, &mut self.rgba);
                out.copy_from(&self.rgba);
                Ok(true)
            }
        }
    }

    /// Seek so the next `decode_next_frame` returns frame `idx`.
    pub fn seek(&mut self, idx: u32) -> Result<(), JsValue> {
        self.inner.seek(idx)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
