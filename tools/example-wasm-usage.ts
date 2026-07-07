/**
 * Example: Using raw_converter_wasm functions from pkg/
 * 
 * Available functions:
 * - downscale_rgb(src, src_w, src_h, dst_w, dst_h): Uint8Array → downscaled RGB8
 * - downscale_rgba(src, src_w, src_h, dst_w, dst_h): Uint8Array → downscaled RGBA8
 * - rgb_to_rgba(rgb): Uint8Array → RGBA8 (adds alpha = 255)
 * - process_orf(data, ...): ProcessResult → metadata + RGB/RGBA output
 *   - ProcessResult.take_rgb() and ProcessResult.take_rgba() provide zero-copy ownership moves
 * - apply_look(rgb16, ...): Uint8Array → re-toned RGB8 post-orientation
 * - rotate_rgb8(src, w, h, turns): RotateResult → rotated RGB8 with new dimensions
 */

import init, {
  downscale_rgb,
  rgb_to_rgba,
  process_orf,
  apply_look,
  rotate_rgb8,
  InitInput
} from './pkg/raw_converter_wasm.js';

/**
 * Initialize the WASM module.
 * 
 * Environment compatibility note (E5):
 * - Browser: You can call `initWasm()` with no arguments. It will automatically
 *   fetch the `.wasm` file relative to the module path.
 * - Bun/Node: Fetching relative files fails. You must read the `.wasm` file 
 *   manually using standard filesystem utilities and pass the bytes or options.
 * 
 * @example
 * // Browser usage:
 * await initWasm();
 * 
 * @example
 * // Node/Bun usage:
 * import { readFileSync } from 'node:fs';
 * const wasmBytes = readFileSync(new URL('./pkg/raw_converter_wasm_bg.wasm', import.meta.url));
 * await initWasm({ module_or_path: wasmBytes });
 * 
 * @param initInput Optional WebAssembly Module, bytes (ArrayBuffer/Uint8Array), or initialization options.
 */
async function initWasm(initInput?: InitInput | { module_or_path: InitInput }) {
  await init(initInput);
  console.log('WASM initialized');
}

/**
 * Downscale an RGB8 image buffer
 */
function downscaleImage(
  rgbBuffer: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  return downscale_rgb(rgbBuffer, srcWidth, srcHeight, dstWidth, dstHeight);
}

/**
 * Downscale and convert to RGBA (if alpha channel needed)
 */
function downscaleToRgba(
  rgbBuffer: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  // Step 1: downscale RGB
  const downscaledRgb = downscale_rgb(
    rgbBuffer,
    srcWidth,
    srcHeight,
    dstWidth,
    dstHeight
  );

  // Step 2: convert to RGBA (adds alpha = 255)
  const rgba = rgb_to_rgba(downscaledRgb);

  return rgba;
}

/**
 * Example: process an ORF file and create a thumbnail.
 * Prevents image distortion by dynamically calculating the thumbnail height
 * from the aspect ratio if not explicitly specified.
 */
async function processOrfWithThumbnail(
  orfData: Uint8Array,
  thumbnailWidth: number = 200,
  thumbnailHeight?: number
) {
  // Process the ORF file
  const result = process_orf(
    orfData,
    0, // exposure_ev
    0, // contrast
    0, // highlights
    0, // shadows
    0, // whites
    0, // blacks
    0, // saturation
    0, // vibrance
    0, // temp
    0, // tint
    NaN, // wb_r_override (use default)
    NaN, // wb_b_override (use default)
    0, // texture
    0  // clarity
  );

  // Move the full RGB buffer out of WASM using the zero-copy take_rgb() accessor. (E2)
  // Note: take_rgb() is a one-shot ownership move. After calling take_rgb(),
  // the ProcessResult instance no longer holds the buffer, and subsequent calls
  // to rgb() or take_rgb() on the same ProcessResult instance will return empty or throw.
  const fullRgb = result.take_rgb();
  const width = result.width;
  const height = result.height;

  // Compute thumbnailHeight based on aspect ratio if not provided (E3)
  const computedHeight = thumbnailHeight !== undefined
    ? thumbnailHeight
    : Math.round(height * thumbnailWidth / width);

  // Create a thumbnail using downscale_rgb
  const thumbnail = downscale_rgb(
    fullRgb,
    width,
    height,
    thumbnailWidth,
    computedHeight
  );

  // Convert to RGBA if needed for canvas display
  const thumbnailRgba = rgb_to_rgba(thumbnail);

  return {
    fullRgb,
    width,
    height,
    thumbnailRgba,
    thumbnailWidth,
    thumbnailHeight: computedHeight,
    metadata: {
      iso: result.iso,
      exposure: `${result.exposure_num}/${result.exposure_den}`,
      focal: `${result.focal_length_num}/${result.focal_length_den}mm`,
      make: result.make,
      model: result.model,
    },
  };
}

/**
 * Example: Process an ORF file directly to an RGBA buffer for HTML canvas display.
 * This demonstrates the usage of `take_rgba()` which fuses RGB to RGBA conversion 
 * inside WASM, achieving maximum performance with zero unnecessary JS-side allocations.
 */
async function processOrfToCanvasRgba(orfData: Uint8Array): Promise<{
  rgba: Uint8Array;
  width: number;
  height: number;
}> {
  // Process the ORF file
  const result = process_orf(
    orfData,
    0, // exposure_ev
    0, // contrast
    0, // highlights
    0, // shadows
    0, // whites
    0, // blacks
    0, // saturation
    0, // vibrance
    0, // temp
    0, // tint
    NaN, // wb_r_override
    NaN, // wb_b_override
    0, // texture
    0  // clarity
  );

  // Move the RGBA buffer out of WASM with zero-copy. (E2)
  // This avoids the JS-side 3x buffer allocation of take_rgb() + rgb_to_rgba().
  const rgba = result.take_rgba();
  const width = result.width;
  const height = result.height;

  return {
    rgba,
    width,
    height,
  };
}

/**
 * Example: Re-apply tonemapping and look adjustments to a cached RGB16 lightbox buffer.
 * 
 * This uses `apply_look` which takes a Uint16Array of the pre-tonemapped 16-bit RGB data.
 * This is useful for interactive adjustment sliders where you want to quickly re-render
 * without doing the heavy decompression and demosaicing steps again.
 * 
 * @param rgb16Bytes Flat interleaved RGB16 Uint8Array buffer (e.g., from take_rgb16_lb()).
 * @param width Image width.
 * @param height Image height.
 * @param orientation EXIF orientation.
 * @param exposureEv Exposure compensation in stops.
 * @param contrast Contrast adjustment (-1..+1).
 * @returns Re-toned RGB8 output buffer.
 */
function applyLookExample(
  rgb16Bytes: Uint8Array,
  width: number,
  height: number,
  orientation: number,
  exposureEv: number,
  contrast: number
): Uint8Array {
  // Cast the Uint8Array buffer returned by take_rgb16_lb() to Uint16Array view.
  // This is a zero-copy operation because we reuse the underlying ArrayBuffer.
  const rgb16U16 = new Uint16Array(
    rgb16Bytes.buffer,
    rgb16Bytes.byteOffset,
    rgb16Bytes.byteLength / 2
  );

  // Use empty Float32Array to trigger the built-in cam_to_srgb color matrix fallback
  const emptyColorMatrix = new Float32Array(0);

  // Call the WASM apply_look function with all 19 positional arguments (E4)
  const updatedRgb8 = apply_look(
    rgb16U16,
    width,
    height,
    orientation,
    NaN, // wb_r (use camera/default)
    NaN, // wb_b (use camera/default)
    emptyColorMatrix,
    exposureEv,
    contrast,
    0, // highlights
    0, // shadows
    0, // whites
    0, // blacks
    0, // saturation
    0, // vibrance
    0, // temp
    0, // tint
    0, // texture
    0  // clarity
  );

  return updatedRgb8;
}

/**
 * Example: Rotate an RGB8 image buffer by 90-degree turns clockwise.
 * 
 * @param rgb8Buffer The input RGB8 buffer (e.g., from take_rgb()).
 * @param width The width of the input image.
 * @param height The height of the input image.
 * @param turns Number of 90-degree clockwise turns (1 = 90°, 2 = 180°, 3 = 270°).
 * @returns An object containing the rotated RGB8 buffer and new dimensions.
 */
function rotateImageExample(
  rgb8Buffer: Uint8Array,
  width: number,
  height: number,
  turns: number
): { rotatedRgb: Uint8Array; width: number; height: number } {
  // Call the WASM rotate_rgb8 function which returns a RotateResult instance (E4)
  const rotateResult = rotate_rgb8(rgb8Buffer, width, height, turns);

  try {
    // Move the rotated buffer out of WASM (zero-copy) via take_rgb()
    const rotatedRgb = rotateResult.take_rgb();
    
    return {
      rotatedRgb,
      width: rotateResult.width,
      height: rotateResult.height,
    };
  } finally {
    // Explicitly free the WASM-resident RotateResult to prevent memory leaks
    rotateResult.free();
  }
}

export {
  initWasm,
  downscaleImage,
  downscaleToRgba,
  processOrfWithThumbnail,
  processOrfToCanvasRgba,
  applyLookExample,
  rotateImageExample
};
