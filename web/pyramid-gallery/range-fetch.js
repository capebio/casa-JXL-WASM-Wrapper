/**
 * range-fetch — deliver a resolved LOD by HTTP Range through the ONE trusted boundary (Task 6).
 *
 * The LOD resolver (`@casabio/jxl-pyramid` `resolveLod`) decides WHICH bytes to fetch:
 *   - `progressive-prefix` → a single window `[0, byteEnd)`  → `fetchLevelRange`.
 *   - `jxtc-ranges`        → one window per overlapping tile → `fetchTileRanges`.
 *
 * Both go through `fetchVerifiedAsset` (finding 73 — the single origin/root-contained, byte-capped,
 * optionally SHA-verified fetch), now with its `range` option. Nothing here re-implements fetch or
 * containment: it composes the trusted boundary. The progressive-prefix bytes are then decoded via
 * the existing progressive session/decode path (finding 2 — reuse, don't recreate the queue/fetch).
 */

import { fetchVerifiedAsset } from "./trusted-fetch.js";

/**
 * Fetch a single byte window `[range.start, range.endExclusive)` of a level via HTTP Range.
 * Used for the `progressive-prefix` delivery kind. Returns exactly the window bytes (the trusted
 * boundary slices the window even when the server ignores Range and replies 200).
 *
 * @param {object} opts
 * @param {URL|string} opts.root
 * @param {string} opts.relativePath                 e.g. `levels/<contenthash>.jxl`.
 * @param {{ start: number, endExclusive: number }} opts.range
 * @param {string} [opts.sha256]                     Optional strong digest of the RANGE bytes.
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {SubtleCrypto} [opts.subtle]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchLevelRange({ root, relativePath, range, sha256, signal, fetchImpl, subtle }) {
  return fetchVerifiedAsset({
    root,
    relativePath,
    // expectedBytes is derived from the window by fetchVerifiedAsset when `range` is present; pass a
    // matching value so the argument-bounds guard is satisfied before the derivation runs.
    expectedBytes: range.endExclusive - range.start,
    range,
    sha256,
    signal,
    fetchImpl,
    subtle,
  });
}

/**
 * Fetch several tile byte windows (one HTTP Range request per tile) for the `jxtc-ranges` delivery
 * kind. Returns the delivered tile bitstreams in the SAME order as `ranges` (aligned with the
 * resolver's `tiles[]`). Fetches run sequentially so a cancellation aborts the remaining tiles
 * promptly; a caller wanting parallelism can map `fetchLevelRange` itself.
 *
 * @param {object} opts
 * @param {URL|string} opts.root
 * @param {string} opts.relativePath
 * @param {{ start: number, end: number }[]} opts.ranges  Half-open `[start, end)` per tile (from resolveLod).
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {SubtleCrypto} [opts.subtle]
 * @returns {Promise<ArrayBuffer[]>}
 */
export async function fetchTileRanges({ root, relativePath, ranges, signal, fetchImpl, subtle }) {
  const parts = [];
  for (const r of ranges) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const buf = await fetchLevelRange({
      root,
      relativePath,
      range: { start: r.start, endExclusive: r.end },
      signal,
      fetchImpl,
      subtle,
    });
    parts.push(buf);
  }
  return parts;
}
