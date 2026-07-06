use raw_pipeline::image_formats::*;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

#[test]
fn exr_roundtrip_preserves_hdr_and_is_clean() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_f32.exr")).unwrap();
    let d = decode_exr_bytes(&bytes).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 32));
    // no NaN/Inf anywhere
    assert!(
        d.f32.iter().all(|v| v.is_finite()),
        "non-finite sample in EXR decode"
    );
    // HDR actually present (generator peaks ~3.0)
    let max = d.f32.iter().cloned().fold(0.0_f32, f32::max);
    assert!(max > 1.5, "expected HDR values >1.5, got max {max}");
    // display conversion is clean: all bytes valid, alpha solid, not all-black
    let disp = f32_linear_to_srgb8(&d.f32);
    assert_eq!(disp.len(), (256 * 256 * 4) as usize);
    assert!(
        disp.iter().skip(3).step_by(4).all(|&a| a == 255),
        "alpha must be opaque"
    );
    assert!(disp.iter().any(|&b| b > 10), "image must not be all-black");
    // channel separation preserved (palette is non-grey): channels differ somewhere
    let differs = disp.chunks_exact(4).any(|p| p[0] != p[1] || p[1] != p[2]);
    assert!(differs, "expected colour, got greyscale");
}

#[test]
fn tiff16_roundtrip_keeps_16bit() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u16.tiff")).unwrap();
    let d = decode_tiff_bytes(&bytes).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 16));
    assert_eq!(d.u16.len(), (256 * 256 * 4) as usize);
}

#[test]
fn tiff8_roundtrip() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u8.tiff")).unwrap();
    let d = decode_tiff_bytes(&bytes).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 8));
    assert_eq!(d.u8.len(), (256 * 256 * 4) as usize);
}
