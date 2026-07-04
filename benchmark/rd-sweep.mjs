// Pure quality-ladder sweep for one codec over one image. Encodes + decodes ONCE per
// ladder point; `metrics(decodedData)` (injected) returns {butteraugli, ssim} so this
// is unit-testable without WASM and never double-encodes.
export const DEFAULT_LADDER = [30, 45, 55, 65, 75, 85, 92, 98];

// codec: { key, runtime, encode(rgba,w,h,q)->bytes(Uint8Array), decode(bytes)->{data,...} }
// metrics: async (decoded) -> { butteraugli, ssim }
export async function sweepQualityLadder(codec, { rgba, width, height, npx, metrics, ladder = DEFAULT_LADDER }) {
  const pts = [];
  for (const q of ladder) {
    const bytes = await codec.encode(rgba, width, height, q);
    const decoded = await codec.decode(bytes);
    const { butteraugli, ssim } = await metrics(decoded);
    pts.push({ codec: codec.key, runtime: codec.runtime, quality: q, bytes: bytes.length, bpp: (bytes.length * 8) / npx, butteraugli, ssim });
  }
  return pts;
}
