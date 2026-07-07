## The flow is

CR2 (cr2.rs+ljpeg.rs) → demosaic → tone (pipeline.rs) → JXL encode (casabio_encode.rs).





## Key files

LibJXL files...

 lib/jxl/encode.cc │ Main pipeline  

lib/jxl/ans_common.cc  │ Entropy coding (hot)

lib/jxl/decode.cc │ Main pipeline 

Butteraugli │ lib/jxl/butteraugli/butteraugli.cc 



## CR2 decode

cr2.rs | CR2 orchestrator. Parses the TIFF/IFD container inline (CR2 is TIFF-based), finds the RAW strip, reads the lossless-JPEG SOF   cr2.rs   header (parse_ljpeg_sof), extracts black/white/WB/colour-matrix/ISO. Entry: cr2::decode_bytes → Cr2Image. Calls                ljpeg::decode_tile.

ljpeg.rs | Lossless-JPEG (Huffman) decompressor — decode_tile. This is the serial decode cost center (545–739ms in the bench). Huffman   bitstream + predictor reconstruction, inherently sequential.

domesaic.rs |  Post-decode: demosaic_rggb_mhc (CFA Bayer → RGB16). Already parallel.

exif.rs | EXIF/metadata helpers.

lib.rs |  WASM/public entry (process_*), wires decode → demosaic → tone.

srec/bin/raw_decode_bench.rs | Bench harness: bench_cr2.



## CR2 Encode

casabio_encode.rs | Native JXL encode (encode_variants_with_progressive) via jpegxl-rs.

 bridge.cpp / facade.ts (packages/jxl-wasm/) │ WASM JXL encode path.

jpegxl-rs (vendored libjxl) | Actual codec.