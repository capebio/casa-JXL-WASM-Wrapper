use wasm_bindgen::prelude::*;

/// WASM-facing BLTV decoder.  Load the full .bltv byte stream once, then call
/// `decode_next_frame()` sequentially to get RGB24 frames at playback rate.
#[wasm_bindgen]
pub struct BltvDecoder {
    inner: bltv::Decoder,
}

#[wasm_bindgen]
impl BltvDecoder {
    /// Create a decoder from the full BLTV file bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<BltvDecoder, JsValue> {
        bltv::Decoder::new(data.to_vec())
            .map(|inner| BltvDecoder { inner })
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

    /// Seek so the next `decode_next_frame` returns frame `idx`.
    pub fn seek(&mut self, idx: u32) -> Result<(), JsValue> {
        self.inner.seek(idx)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
