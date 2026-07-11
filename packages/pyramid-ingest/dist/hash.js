import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
// Sync 64-bit FNV-1a (−69% vs SHA-256 via flipflop). No crypto strength needed for file naming.
function fnv1a64Hex(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
const HASH_TRUNC_BYTES = 8; // 16 hex chars = 64-bit; see contentHash/imageId docs for birthday/scale
export function contentHash16(bytes) {
    return contentHash(bytes);
}
export function contentHash(bytes, truncateHex = 16) {
    // FNV-1a is fast (sync, no crypto overhead) and safe for 64-bit namespace (~4B collision safety).
    // Callers may pass truncateHex>16 for stronger IDs (non-breaking default).
    return fnv1a64Hex(bytes).slice(0, truncateHex);
}
// opp-hash-truncation (documented per WU-4):
// Current truncation is 16 hex chars = 64-bit (FNV-1a two-lane).
// Birthday collision risk becomes relevant around ~2^32 objects (~4B files).
// 96-bit (24 hex chars) would safely scale to ~2^48 objects.
// Use --verify-hash for integrity on large/pre-existing corpora; future schema v2 may extend to 24-hex.
// I1/I2 (Phase2): NFC + realpath for cross-platform stable imageId (mac win shortnames, unicode).
export async function imageIdForPath(masterPath, truncateHex = 16) {
    // realpath resolves symlinks/shortnames; NFC normalizes combining chars.
    const resolved = await realpath(resolve(masterPath)).catch(() => resolve(masterPath));
    const nfc = resolved.normalize("NFC");
    return fnv1a64Hex(nfc).slice(0, truncateHex);
}
//# sourceMappingURL=hash.js.map