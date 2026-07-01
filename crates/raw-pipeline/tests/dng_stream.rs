//! DNG streaming decode: DngRowSource rows must equal the full decode_bytes().raw.
//! Fixture-gated (comp=7 real DNG); skips gracefully in CI without the asset.
use raw_pipeline::decompress::RawRowSource;
use raw_pipeline::dng;

fn find_dng() -> Option<Vec<u8>> {
    for p in [
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
        "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    ] {
        if let Ok(d) = std::fs::read(p) {
            return Some(d);
        }
    }
    None
}

#[test]
fn dng_rowsource_rows_equal_full_decode() {
    let Some(data) = find_dng() else {
        eprintln!("skip: no DNG fixture");
        return;
    };
    let full = dng::decode_bytes(&data).expect("full decode");
    let mut src = dng::DngRowSource::new(&data).expect("streaming parse");
    assert_eq!(src.width(), full.width);
    assert_eq!(src.height(), full.height);
    let w = full.width;
    let mut rowbuf = vec![0u16; w];
    let mut streamed = Vec::with_capacity(full.raw.len());
    while src.next_row_into(&mut rowbuf).expect("row") {
        streamed.extend_from_slice(&rowbuf);
    }
    assert_eq!(streamed.len(), full.raw.len());
    assert!(streamed == full.raw, "streamed rows != full decode raw");
}
