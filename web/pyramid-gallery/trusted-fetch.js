/**
 * trusted-fetch — the single trusted boundary for gallery asset bytes (Packet 1 Task 8, finding 73).
 *
 * Everything the gallery fetches (manifests, level bytes) is untrusted input arriving over the
 * network. `fetchVerifiedAsset` is the ONE place that:
 *   1. resolves the requested path safely (`new URL(relativePath, root)`) and, AFTER normalization
 *      AND after any redirect, requires the final URL to be same-origin AND contained within the
 *      gallery `root` subtree — rejecting absolute/cross-origin URLs, `..` traversal (raw or
 *      percent-encoded), root-absolute escapes, and redirect escapes;
 *   2. enforces the declared byte cap BEFORE streaming (via `Content-Length`) and DURING streaming
 *      (aborting the moment accumulated bytes exceed the cap) so a lying/absent length cannot make
 *      us buffer an unbounded body;
 *   3. verifies the SHA-256 of the fully-received body BEFORE the bytes are handed back for cache
 *      publication or decode, and rejects a truncated body (fewer bytes than declared).
 *
 * NOTE on `contenthash`: the pyramid on-disk `contenthash` is a 64-bit FNV-1a name (see
 * pyramid-ingest/hash.ts), NOT a cryptographic digest — it is a storage key, not an integrity
 * guarantee. Strong verification therefore rides on a separately-supplied `sha256` digest; when a
 * caller has one, this boundary enforces it. When absent, the byte cap + truncation checks still
 * apply.
 *
 * `fetchImpl` and `subtle` are injectable so this module is testable under node/bun and runs
 * unchanged in the browser (defaults: global `fetch` and `crypto.subtle`).
 */

export class TrustedFetchError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "trusted-fetch") {
    super(message);
    this.name = "TrustedFetchError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new TrustedFetchError(message, code);
}

/**
 * The directory subtree a request must stay within: the root's own directory path. A request may
 * target `root` itself or anything below it, but nothing above (`..`) or beside it (`/other/…`).
 * @param {URL} rootUrl
 */
function rootPrefix(rootUrl) {
  // `root` is a directory base (callers pass a trailing slash). Its pathname already ends in "/"
  // for a well-formed base; guard anyway so containment is a strict directory-prefix test.
  return rootUrl.pathname.endsWith("/") ? rootUrl.pathname : `${rootUrl.pathname}/`;
}

/**
 * Resolve `relativePath` against `root` and assert same-origin + root-subtree containment.
 * Returns the resolved absolute URL string. Throws TrustedFetchError on any escape.
 * @param {URL} rootUrl
 * @param {string} relativePath
 */
function resolveContained(rootUrl, relativePath) {
  let resolved;
  try {
    resolved = new URL(relativePath, rootUrl);
  } catch {
    fail(`unresolvable path: ${relativePath}`, "bad-path");
  }
  assertContained(rootUrl, resolved, "resolved");
  return resolved;
}

/**
 * Assert `candidate` is same-origin as `rootUrl` and its pathname is within the root subtree.
 * Used both for the initially-resolved URL and for the FINAL response URL after redirects.
 * @param {URL} rootUrl
 * @param {URL} candidate
 * @param {string} stage
 */
function assertContained(rootUrl, candidate, stage) {
  if (candidate.origin !== rootUrl.origin) {
    fail(`${stage} URL ${candidate.href} is cross-origin (expected ${rootUrl.origin})`, "cross-origin");
  }
  const prefix = rootPrefix(rootUrl);
  // Decode the pathname so percent-encoded traversal (..%2F, %2e%2e) is compared in decoded form;
  // `new URL` already collapses raw `../` and un-encodes `%2e%2e`, but an over-encoded segment like
  // `..%2F` survives as a literal path segment — decode + normalize to catch it too.
  let path = candidate.pathname;
  try {
    path = decodeURIComponent(candidate.pathname);
  } catch {
    fail(`${stage} URL ${candidate.href} has an undecodable path`, "bad-path");
  }
  // After decoding, re-resolve against the origin so any residual `..`/`.` segments collapse, then
  // require the result to start with the root subtree prefix.
  const normalized = new URL(path, `${rootUrl.origin}/`).pathname;
  if (!normalized.startsWith(prefix)) {
    fail(`${stage} URL path ${normalized} escapes gallery root ${prefix}`, "path-escape");
  }
}

/**
 * Fetch a gallery asset with full path/origin/byte-cap/SHA verification.
 *
 * @param {object} opts
 * @param {URL | string} opts.root            Gallery base (directory) URL. Trailing slash expected.
 * @param {string} opts.relativePath          Path relative to `root` (e.g. "levels/<hash>.jxl").
 * @param {number} opts.expectedBytes         Declared byte length; hard upper cap on the body. In the
 *                                            default `exactBytes` mode this is ALSO the exact expected
 *                                            length (a shorter body = truncation → reject).
 * @param {boolean} [opts.exactBytes=true]    When false, `expectedBytes` is only a ceiling: a body
 *                                            shorter than it is accepted (used for manifests / legacy
 *                                            level fetches that have no precise declared size). An
 *                                            OVERRUN of the cap is still rejected.
 * @param {string} [opts.sha256]              Expected lowercase-hex SHA-256 of the body (optional).
 * @param {AbortSignal} [opts.signal]         Caller abort signal.
 * @param {typeof fetch} [opts.fetchImpl]     Injected fetch (defaults to global fetch).
 * @param {SubtleCrypto} [opts.subtle]        Injected SubtleCrypto (defaults to crypto.subtle).
 * @param {{ start: number, endExclusive: number }} [opts.range]
 *        Half-open byte window `[start, endExclusive)` (Task 6). When present, an HTTP
 *        `Range: bytes=start-(endExclusive-1)` is sent; a `206` is accepted (its `Content-Range`
 *        start is validated against `start`) and only that slice is returned. A `200` fallback
 *        (server ignored Range) is tolerated: the requested window is sliced from the full body
 *        so the delivered bytes are always exactly the range. `expectedBytes` becomes the window
 *        length (`endExclusive - start`) automatically; a caller-supplied `sha256` then verifies
 *        the RANGE bytes. Range fetches are `exactBytes` for a 206 (the slice must be complete).
 * @returns {Promise<ArrayBuffer>}            The verified body bytes.
 */
export async function fetchVerifiedAsset({
  root,
  relativePath,
  expectedBytes,
  exactBytes = true,
  sha256,
  signal,
  fetchImpl,
  subtle,
  range,
}) {
  const doFetch = fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  if (!doFetch) fail("no fetch implementation available", "no-fetch");
  const digestImpl =
    subtle ?? (typeof crypto !== "undefined" ? crypto.subtle : undefined);

  // Range window (Task 6): validate + derive the exact expected length from the window so the cap
  // and truncation checks below apply to the SLICE, not the whole resource.
  let rangeStart = 0;
  let rangeLen = 0;
  const hasRange = range != null;
  if (hasRange) {
    rangeStart = range.start;
    const end = range.endExclusive;
    if (!Number.isInteger(rangeStart) || rangeStart < 0 || !Number.isInteger(end) || end <= rangeStart) {
      fail(`range must satisfy 0 <= start < endExclusive (got ${rangeStart}..${end})`, "bad-range");
    }
    rangeLen = end - rangeStart;
    expectedBytes = rangeLen; // the window length is the precise cap for a ranged fetch.
  }

  // Argument bounds: expectedBytes is the hard cap; a non-finite / non-positive cap is meaningless
  // and would let an unbounded body through, so reject it before touching the network.
  if (typeof expectedBytes !== "number" || !Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    fail(`expectedBytes must be a finite positive number, got ${expectedBytes}`, "bad-cap");
  }

  const rootUrl = root instanceof URL ? root : new URL(String(root));
  const target = resolveContained(rootUrl, relativePath);

  // Signal is honored before touching the network too (some fetch impls only observe it mid-body).
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const fetchInit = { signal, redirect: "error", cache: "no-store" };
  if (hasRange) {
    fetchInit.headers = { Range: `bytes=${rangeStart}-${rangeStart + rangeLen - 1}` };
  }
  const res = await doFetch(target.href, fetchInit);
  if (!res || !res.ok) {
    fail(`fetch ${target.href} failed: ${res ? res.status : "no response"}`, "http");
  }

  // Redirect escape: even with redirect:"error" set, some fetch impls surface a followed redirect
  // via `res.redirected` / a changed `res.url`. Re-assert containment on the FINAL URL.
  if (res.url) {
    let finalUrl;
    try {
      finalUrl = new URL(res.url, rootUrl);
    } catch {
      fail(`response URL is unparseable: ${res.url}`, "bad-response-url");
    }
    assertContained(rootUrl, finalUrl, "final");
  }
  if (res.redirected === true) {
    // `res.url` already checked above, but flag an explicit redirect for clarity/defense-in-depth.
    // A redirect that stayed in-subtree is still allowed (url check passed); this only fires when
    // the impl reports a redirect AND the url check somehow did not run (no res.url).
    if (!res.url) fail("response redirected but exposes no final URL to verify", "redirect");
  }

  // Ranged fetch that fell back to a full body (server ignored Range → 200): read the whole body
  // (still capped generously to prevent an unbounded DoS) and slice the requested window so the
  // delivered bytes are ALWAYS exactly the range, regardless of server Range support (Task 6).
  if (hasRange && res.status === 200) {
    // The full resource may legitimately exceed the window; cap at a large ceiling so we cannot
    // buffer unbounded bytes but can still reach the requested window.
    const FULL_FALLBACK_CAP = 512 * 1024 * 1024; // matches LEVEL_MAX_BYTES ceiling in image-store.
    const declaredFull = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declaredFull) && declaredFull > FULL_FALLBACK_CAP) {
      fail(`Content-Length ${declaredFull} exceeds fallback cap ${FULL_FALLBACK_CAP}`, "oversize-header");
    }
    const full = await readCapped(res, FULL_FALLBACK_CAP);
    if (full.length < rangeStart + rangeLen) {
      fail(`resource length ${full.length} shorter than requested window end ${rangeStart + rangeLen}`, "truncated");
    }
    const body = full.subarray(rangeStart, rangeStart + rangeLen);
    if (sha256 != null) {
      if (!digestImpl) fail("no SubtleCrypto available to verify sha256", "no-subtle");
      const actual = await sha256HexOf(digestImpl, body);
      if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
        fail(`sha256 mismatch: expected ${sha256}, got ${actual}`, "sha-mismatch");
      }
    }
    return body.slice().buffer;
  }

  // For a 206, validate the Content-Range start matches the requested window (defends against a
  // proxy that shifts/normalizes the range and would otherwise silently return the wrong bytes).
  if (hasRange && res.status === 206) {
    const cr = res.headers?.get?.("content-range");
    const m = cr == null ? null : /^bytes\s+(\d+)-/.exec(cr);
    if (m == null || Number(m[1]) !== rangeStart) {
      fail(`Content-Range start mismatch (wanted ${rangeStart}, got ${cr ?? "none"})`, "range-mismatch");
    }
    // A 206 slice must be complete (exact length), so force exactBytes below.
    exactBytes = true;
  }

  // Byte cap BEFORE streaming: a declared Content-Length larger than the cap is rejected without
  // reading a single body byte.
  const contentLengthHeader = res.headers?.get?.("content-length");
  if (contentLengthHeader != null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > expectedBytes) {
      fail(`Content-Length ${declared} exceeds cap ${expectedBytes}`, "oversize-header");
    }
  }

  const body = await readCapped(res, expectedBytes);

  // Truncation: in exact-length mode, fewer bytes than declared means an incomplete/interrupted
  // body — reject before it can be cached or decoded. In cap-only mode `expectedBytes` is just a
  // ceiling, so a shorter body is legitimate.
  if (exactBytes && body.length < expectedBytes) {
    fail(`body length ${body.length} is short of expected ${expectedBytes} (truncated)`, "truncated");
  }

  // SHA-256 verification BEFORE the bytes are returned for cache publication / decode.
  if (sha256 != null) {
    if (!digestImpl) fail("no SubtleCrypto available to verify sha256", "no-subtle");
    const actual = await sha256HexOf(digestImpl, body);
    if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
      fail(`sha256 mismatch: expected ${sha256}, got ${actual}`, "sha-mismatch");
    }
  }

  // Return a tight ArrayBuffer sized exactly to the body.
  return body.buffer.byteLength === body.length
    ? body.buffer
    : body.slice().buffer;
}

/**
 * Stream `res.body`, enforcing the byte cap DURING reception. Aborts (and cancels the reader) the
 * instant accumulated bytes exceed `cap`, so a lying Content-Length or chunked body cannot make us
 * buffer more than the cap.
 * @param {any} res
 * @param {number} cap
 * @returns {Promise<Uint8Array>}
 */
async function readCapped(res, cap) {
  const stream = res.body;
  // Environments without a readable stream (or a mock that only offers arrayBuffer): fall back, but
  // STILL cap the result.
  if (!stream || typeof stream.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > cap) fail(`body ${buf.length} exceeds cap ${cap}`, "overrun");
    return buf;
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > cap) {
        try { await reader.cancel(); } catch { /* ignore */ }
        fail(`body overran cap ${cap} (received > ${cap} bytes)`, "overrun");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* ignore */ }
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Hex SHA-256 of `bytes` via the injected SubtleCrypto. */
async function sha256HexOf(subtle, bytes) {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
  const digest = await subtle.digest("SHA-256", view);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}
