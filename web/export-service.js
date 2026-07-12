// export-service.js — full-resolution Export Selected + metadata privacy policy.
//
// Fixes (re-done — findings 13, 44, 45; see docs/superpowers/plans/
// 2026-07-11-opportunity-04-web-product-workflows.md):
//
//   I-A / finding 13 (P0): the previous service read `state._lightbox`, which the
//     worker builds at a 1800px long-edge cap (worker.js `targetDims(w,h,1800)`).
//     That is the PREVIEW, not full resolution.  The genuinely-full developed
//     output is the full-res developed JXL (`_blobUrl` / the ENCODE_REQUEST
//     result), whose dims are the full sensor (`msg.w`×`msg.h`).  This service now
//     sources full resolution from that developed output — NEVER from `_lightbox`.
//
//   I-B / finding 13 (formats): `encodePixels` used to ignore `outputFmt` and
//     always emit JXL, so PNG/JPEG/TIFF wrote JXL bytes into a mislabeled file.
//     Now only the formats that genuinely encode are allowed: JXL (native encoder)
//     and PNG (real PNG bytes from the full-res RGBA).  JPEG/TIFF are gated with a
//     clear "packet-3" error — we never write a file whose bytes don't match its
//     extension/MIME.
//
//   I-C / finding 44: `applyMetadataPolicy` yields a JS exif OBJECT, but the
//     encoder wants EXIF `Uint8Array` bytes.  The policy result is now serialised
//     (exif-serialize.js) and threaded into the encoder as the `metadata` arg, so
//     the privacy policy actually reaches the output bytes.  GPS is ABSENT from the
//     serialised EXIF under strip-gps / strip-all (proven by decoding it back).
//
//   Finding 45 (kept): `formatLabel` derives the real format + bit-depth.

'use strict';

import { serializeExif } from './exif-serialize.js';

// ---------------------------------------------------------------------------
// Format gating — which output formats genuinely encode right now.
// ---------------------------------------------------------------------------
// jxl : native libjxl encoder (full-res developed output).
// png : real PNG bytes (png-encode.js) from the full-res RGBA.
// jpeg/tiff : NOT implemented — a real encoder is packet-3 scope.  We reject
//   rather than emit mislabeled bytes.
export const ENCODABLE_FORMATS = Object.freeze(['jxl', 'png']);
export const GATED_FORMATS = Object.freeze(['jpeg', 'tiff']);

export function isFormatEncodable(fmt) {
    return ENCODABLE_FORMATS.includes(fmt);
}

// ---------------------------------------------------------------------------
// formatLabel — finding 45: real format + bit-depth for the info panel
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable "Format" label from the exif object emitted by the
 * worker (finding 45).  Replaces the hardcoded "ORF (Olympus 12-bit)".
 * @param {object|null} exif
 * @returns {string}
 */
export function formatLabel(exif) {
    if (!exif || !exif.format) return 'Unknown';
    const { format, bitDepth } = exif;
    if (bitDepth && bitDepth > 0) return `${format} (${bitDepth}-bit)`;
    return format;
}

// ---------------------------------------------------------------------------
// applyMetadataPolicy — finding 44: GPS and/or full EXIF privacy stripping
// ---------------------------------------------------------------------------

/**
 * Return a (shallow) copy of exif with the requested privacy policy applied.
 * Does NOT mutate the input.
 * @param {object|null} exif
 * @param {'keep'|'strip-gps'|'strip-all'} policy
 * @returns {object|null}
 */
export function applyMetadataPolicy(exif, policy) {
    if (!exif) return null;
    if (policy === 'keep') return { ...exif };
    if (policy === 'strip-gps') {
        return { ...exif, gps: null };
    }
    // strip-all: keep only structural/technical fields; zero out privacy-sensitive
    return {
        width:       exif.width       ?? null,
        height:      exif.height      ?? null,
        orientation: exif.orientation ?? 1,
        format:      exif.format      ?? null,
        bitDepth:    exif.bitDepth    ?? null,
        make:          null,
        model:         null,
        lens:          null,
        datetime:      null,
        exposure:      null,
        fnumber:       null,
        focalLength:   null,
        focalLength35: null,
        iso:           null,
        gps:           null,
        quality:       null,
        wbMode:        null,
        wbR:           NaN,
        wbB:           NaN,
        wbFromCamera:  false,
    };
}

/**
 * Serialise a policy-filtered exif object into the { exif, xmp } byte payload
 * the JXL encoder expects.  Returns { exif: Uint8Array|null, xmp: null }.
 * Under strip-gps / strip-all the serialised EXIF contains NO GPS.
 * @param {object|null} exif  already filtered by applyMetadataPolicy
 * @returns {{ exif: Uint8Array|null, xmp: Uint8Array|null }}
 */
export function serializeMetadata(exif) {
    return { exif: serializeExif(exif), xmp: null };
}

// ---------------------------------------------------------------------------
// deriveOutputFilename — clean output name from source name + format
// ---------------------------------------------------------------------------

const RAW_EXTS = /\.(orf|cr2|cr3|crw|dng|nef|nrw|arw|rw2|rwl|raf|pef|srw|x3f|mos|mrw|3fr|fff|iiq|rwz|bay|dcr|kdc|erf|mef|raw|tif|tiff|jpg|jpeg|jfif|png|webp|heic|heif|avif|jxl)$/i;

/**
 * @param {string} sourceName
 * @param {'jxl'|'jpeg'|'png'|'tiff'} outputFmt
 * @param {Set<string>|null} [existingNames]
 * @returns {string}
 */
export function deriveOutputFilename(sourceName, outputFmt, existingNames = null) {
    const ext = outputFmt === 'jpeg' ? 'jpeg' : outputFmt;
    const stem = sourceName.replace(RAW_EXTS, '');
    let candidate = `${stem}.${ext}`;
    if (!existingNames) return candidate;
    let n = 2;
    while (existingNames.has(candidate)) {
        candidate = `${stem}-${n}.${ext}`;
        n++;
    }
    existingNames.add(candidate);
    return candidate;
}

// ---------------------------------------------------------------------------
// ExportService — finding 13: single entry point for all export paths
// ---------------------------------------------------------------------------

/**
 * ExportService processes an ExportRequest and yields per-asset progress/result
 * events as an AsyncGenerator.
 *
 * The full-resolution source is the DEVELOPED FULL-RES OUTPUT — never the 1800px
 * `_lightbox` preview.  Injected capabilities (all testable without a browser):
 *
 *   getDevelopedOutput(state) → ({ jxlBytes: Uint8Array, w, h } | null) | Promise<…>
 *     Returns the already-produced full-res developed JXL for the asset, at FULL
 *     sensor dims.  May be async (main.js fetches the JXL bytes from the developed
 *     blob URL lazily).  Null when it has not been produced yet.
 *
 *   ensureDeveloped(assetId) → Promise<void>   [optional]
 *     Triggers the existing full-res develop flow when getDevelopedOutput() is
 *     null, and resolves when the developed output is available.  If absent and
 *     the developed output is missing, the asset errors ("still developing").
 *
 *   decodeFullRes(jxlBytes) → Promise<{ pixels: Uint8Array, w, h, format }>  [optional]
 *     Decodes the developed full-res JXL back to full-res pixels.  Required for
 *     non-JXL output and for JXL output that must re-embed metadata.
 *
 *   encodePixels(pixels, w, h, format, orientation, outputFmt, metadata) → Promise<Uint8Array>  [optional]
 *     Re-encodes full-res pixels to the requested format, embedding the
 *     policy-serialised `metadata` ({ exif, xmp } Uint8Arrays).  Required
 *     whenever a re-encode is needed (any non-JXL output, or JXL under a
 *     non-'keep' metadata policy).
 *
 * ExportRequest:
 *   { assetIds: string[], output: 'jxl'|'jpeg'|'png'|'tiff',
 *     metadata: 'keep'|'strip-gps'|'strip-all', resolution: 'full' }
 *
 * Yielded events:
 *   { type: 'progress', assetId, phase }
 *   { type: 'done',     assetId, filename, bytes, exif, width, height, source }
 *   { type: 'error',    assetId, error }
 */
export class ExportService {
    constructor(opts) {
        this._getState       = opts.getCardStateByAssetId;
        this._getDeveloped   = opts.getDevelopedOutput ?? null;
        this._ensureDev      = opts.ensureDeveloped ?? null;
        this._decodeFullRes  = opts.decodeFullRes ?? null;
        this._encodePixels   = opts.encodePixels ?? null;
        this._cancelled      = false;
    }

    cancel() { this._cancelled = true; }

    /**
     * @param {{ assetIds: string[], output: string, metadata: string, resolution: string }} req
     * @returns {AsyncGenerator}
     */
    async *export(req) {
        const { assetIds, output, metadata } = req;
        const usedFilenames = new Set();
        this._cancelled = false;

        // I-B: reject un-encodable formats up front — never write mislabeled bytes.
        if (!isFormatEncodable(output)) {
            for (const assetId of assetIds) {
                yield {
                    type: 'error', assetId,
                    error: `Output format "${output}" is not available yet ` +
                           `(${output.toUpperCase()} export lands with packet-3). ` +
                           `Available now: ${ENCODABLE_FORMATS.map(f => f.toUpperCase()).join(', ')}.`,
                };
            }
            return;
        }

        for (const assetId of assetIds) {
            if (this._cancelled) break;

            yield { type: 'progress', assetId, phase: 'preparing' };

            const state = this._getState(assetId);
            if (!state) {
                yield { type: 'error', assetId, error: `Asset state not found: ${assetId}` };
                continue;
            }

            try {
                const result = await this._exportOne(assetId, state, output, metadata);
                if (this._cancelled) break;
                const sourceName = state._file?.name ?? (assetId + '.raw');
                const filename = deriveOutputFilename(sourceName, output, usedFilenames);
                yield {
                    type: 'done', assetId, filename,
                    bytes: result.bytes, exif: result.exif,
                    width: result.width, height: result.height,
                    source: result.source,
                };
            } catch (err) {
                yield { type: 'error', assetId, error: String(err?.message ?? err) };
            }
        }
    }

    // --- one asset: source full-res developed output, apply policy + format ---
    async _exportOne(assetId, state, output, metadata) {
        // I-A: obtain the developed FULL-RES output.  Trigger develop if absent.
        // getDevelopedOutput may be sync or async (main.js fetches JXL bytes from
        // the developed blob URL lazily) — await handles both.
        let dev = this._getDeveloped ? await this._getDeveloped(state) : null;
        if (!dev && this._ensureDev) {
            await this._ensureDev(assetId);
            dev = this._getDeveloped ? await this._getDeveloped(state) : null;
        }
        if (!dev || !dev.jxlBytes || !dev.w || !dev.h) {
            throw new Error(
                'Full-resolution developed output not available — ' +
                'the file is still developing. Try again once conversion completes.',
            );
        }

        // Policy applied → JS object; serialise to encoder-ready bytes (I-C).
        const rawExif    = state._exif ?? null;
        const exportExif = applyMetadataPolicy(rawExif, metadata);
        const metaBytes  = serializeMetadata(exportExif);

        // Fast path (I-A + I-C): JXL output with 'keep' policy → the developed
        // full-res JXL already carries the source metadata; emit its bytes
        // directly (no decode/re-encode of the preview or the full image).
        const canPassThrough = output === 'jxl' && metadata === 'keep';
        if (canPassThrough) {
            return {
                bytes: dev.jxlBytes, exif: exportExif,
                width: dev.w, height: dev.h, source: 'developed-jxl-passthrough',
            };
        }

        // Otherwise a re-encode is required (non-JXL format, or JXL that must
        // re-embed a stripped-metadata block).  Decode the FULL-RES developed
        // JXL (full dims) — NOT the preview — then re-encode.
        if (!this._decodeFullRes) {
            throw new Error('decodeFullRes capability required to re-encode developed output');
        }
        if (!this._encodePixels) {
            throw new Error('encodePixels capability required to re-encode developed output');
        }
        const decoded = await this._decodeFullRes(dev.jxlBytes);
        if (this._cancelled) return { bytes: new Uint8Array(0), exif: exportExif, width: dev.w, height: dev.h, source: 'cancelled' };

        // Guard: the decode MUST yield full resolution, not a preview.  Compare
        // pixel COUNT (area), not exact w×h: a rotated image decodes to
        // display-oriented dims (axis-swapped vs the sensor dims in `dev`), which
        // is correct for a PNG re-encode, so an exact-dims check would false-fail.
        // A downscaled preview would have a much smaller area and is rejected.
        if (decoded.w * decoded.h !== dev.w * dev.h) {
            throw new Error(
                `Decoded developed output is not full resolution ` +
                `(${decoded.w}×${decoded.h}=${decoded.w * decoded.h}px, ` +
                `expected ${dev.w * dev.h}px)`,
            );
        }

        const orientation = state._exif?.orientation ?? 1;
        const bytes = await this._encodePixels(
            decoded.pixels, decoded.w, decoded.h,
            decoded.format ?? 'rgba8',
            orientation, output, metaBytes,
        );
        return {
            bytes, exif: exportExif,
            width: decoded.w, height: decoded.h,
            source: output === 'jxl' ? 'developed-jxl-reencode' : `reencode-${output}`,
        };
    }
}
