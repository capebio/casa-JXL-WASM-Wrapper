// Lean, ID-focused casava-ai/1 sidecar builder.
import { exifDatetimeToIso } from "./datetime-geo.mjs";
import { gpsFromDecoded } from "./gps.mjs";

export const SIDECAR_SCHEMA = "casava-ai/1";
export const PROXY_SPEC = "768px/q80/4:2:0";

/**
 * Build a lean, ID-focused casava-ai/1 sidecar object.
 * `input`: { filename, sha256, bytes, format, width, height, orientationApplied,
 *            datetimeExif, decoded } where `decoded` exposes has_gps/gps_lat/lon/alt.
 * Photographic EXIF (camera/lens/iso/exposure) is intentionally excluded — it stays in
 * the master RAW; full-EXIF preservation is the separate JXL-embed follow-up.
 */
export function buildSidecar(input) {
  return {
    schema: SIDECAR_SCHEMA,
    source: { filename: input.filename, sha256: input.sha256, bytes: input.bytes, format: input.format },
    image: { width: input.width, height: input.height, orientation_applied: !!input.orientationApplied },
    colour: { space: "sRGB", icc_embedded: false },
    datetime: exifDatetimeToIso(input.datetimeExif),
    geo: gpsFromDecoded(input.decoded),
    proxy: { spec: PROXY_SPEC, stored: false },
    generator: { name: "casava-ai", version: 1 },
  };
}
