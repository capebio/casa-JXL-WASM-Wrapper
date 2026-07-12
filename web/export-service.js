// export-service.js — full-resolution Export Selected + metadata privacy policy.
//
// Fixes:
//   Finding 13 (P0): "Export Selected" button was unwired; single-lightbox
//     download used preview-resolution canvas bytes, not full sensor pixels.
//   Finding 44: source EXIF/GPS not carried through export; metadata privacy
//     policy (keep / strip-gps / strip-all) now enforced.
//   Finding 45: format/bit-depth row in the info panel was the hardcoded string
//     "ORF (Olympus 12-bit)"; now derived from exif.format + exif.bitDepth.
//
// NOTE — packet-3 integration point:
//   When resident full-res pixels (packet-3 resident-full-res path) land, replace
//   the lightbox pixel source here with the resident buffer which skips the
//   full re-decode. The `encodePixels` dependency injection slot already accepts
//   the same (pixels, w, h, format, orientation, outputFmt) signature.

'use strict';

// ---------------------------------------------------------------------------
// formatLabel — finding 45: real format + bit-depth for the info panel
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable "Format" label from the exif object emitted by
 * the worker (finding 45).  Replaces the hardcoded "ORF (Olympus 12-bit)".
 *
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
 *
 * @param {object|null} exif  The exif blob from worker onThumb / getCardState._exif
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
        // Technical / structural (needed for display and encode)
        width:       exif.width       ?? null,
        height:      exif.height      ?? null,
        orientation: exif.orientation ?? 1,
        format:      exif.format      ?? null,
        bitDepth:    exif.bitDepth    ?? null,
        // Privacy-sensitive → null
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

// ---------------------------------------------------------------------------
// deriveOutputFilename — clean output name from source name + format
// ---------------------------------------------------------------------------

// Known RAW + image extensions to strip before adding the output extension.
const RAW_EXTS = /\.(orf|cr2|cr3|crw|dng|nef|nrw|arw|rw2|rwl|raf|pef|srw|x3f|mos|mrw|3fr|fff|iiq|rwz|bay|dcr|kdc|erf|mef|raw|tif|tiff|jpg|jpeg|jfif|png|webp|heic|heif|avif|jxl)$/i;

/**
 * Derive the output filename for an export item.  If `existingNames` is a Set,
 * deduplicates by appending -2, -3, … until the name is free.  Mutates the Set
 * (adds the chosen name) so subsequent calls within the same batch avoid it.
 *
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
 * Constructor options:
 *   getCardStateByAssetId(assetId) → CardState|null
 *     Returns the per-card state kept by main.js (lightbox pixels, exif, etc.).
 *     The lightbox field { rgb, w, h, orientation } holds FULL-RESOLUTION sensor
 *     pixels (finding 13: NEVER export the preview canvas bytes).
 *
 *   encodePixels(pixels, w, h, format, orientation, outputFmt) → Promise<Uint8Array>
 *     Encoder dependency (injectable for testing; production wires to
 *     encodeJxlSession or the equivalent for other output formats).
 *     `format` is the pixel buffer layout ('rgb8', 'rgba8', etc.).
 *     `outputFmt` is the user-requested output ('jxl'|'jpeg'|'png'|'tiff').
 *
 * ExportRequest:
 *   { assetIds: string[], output: 'jxl'|'jpeg'|'png'|'tiff',
 *     metadata: 'keep'|'strip-gps'|'strip-all', resolution: 'full' }
 *
 * Yielded event shapes:
 *   { type: 'progress', assetId, phase: string }
 *   { type: 'done',     assetId, filename, bytes: Uint8Array, exif }
 *   { type: 'error',    assetId, error: string }
 */
export class ExportService {
    /** @param {{ getCardStateByAssetId: Function, encodePixels?: Function }} opts */
    constructor(opts) {
        this._getState   = opts.getCardStateByAssetId;
        this._encodePixels = opts.encodePixels ?? _defaultEncoder;
        this._cancelled  = false;
    }

    /** Stop processing after the current asset. */
    cancel() {
        this._cancelled = true;
    }

    /**
     * Export assets according to the request.
     * Yields progress/done/error events for each asset in order.
     *
     * @param {{ assetIds: string[], output: string, metadata: string, resolution: string }} req
     * @returns {AsyncGenerator}
     */
    async *export(req) {
        const { assetIds, output, metadata } = req;
        const usedFilenames = new Set();
        this._cancelled = false;

        for (const assetId of assetIds) {
            if (this._cancelled) break;

            yield { type: 'progress', assetId, phase: 'preparing' };

            const state = this._getState(assetId);
            if (!state) {
                yield { type: 'error', assetId, error: `Asset state not found: ${assetId}` };
                continue;
            }

            // Finding 13: use full-resolution lightbox pixels, NOT the canvas.
            // _lightbox is { rgb: Uint8Array, w, h, orientation } from worker onLightbox.
            // Packet-3 integration point: when a resident full-res buffer is available,
            // prefer it here over the lightbox buffer (which may be downscaled to 1800px).
            const lb = state._lightbox;
            if (!lb || !lb.rgb || !lb.w || !lb.h) {
                yield {
                    type: 'error', assetId,
                    error: 'Full-resolution pixels not available — file may still be decoding',
                };
                continue;
            }

            yield { type: 'progress', assetId, phase: 'encoding' };

            let bytes;
            try {
                const orientation = lb.orientation ?? state._exif?.orientation ?? 1;
                bytes = await this._encodePixels(
                    lb.rgb, lb.w, lb.h,
                    'rgb8',        // lightbox is always rgb8 (3-channel sensor output)
                    orientation,
                    output,
                );
            } catch (err) {
                yield { type: 'error', assetId, error: String(err?.message ?? err) };
                continue;
            }

            // Finding 44: apply metadata privacy policy before emitting.
            const rawExif   = state._exif ?? null;
            const exportExif = applyMetadataPolicy(rawExif, metadata);

            const sourceName = state._file?.name ?? (assetId + '.raw');
            const filename   = deriveOutputFilename(sourceName, output, usedFilenames);

            yield { type: 'done', assetId, filename, bytes, exif: exportExif };
        }
    }
}

// ---------------------------------------------------------------------------
// Default encoder stub (replaced by main.js with encodeJxlSession)
// ---------------------------------------------------------------------------

async function _defaultEncoder(pixels, w, h, format, orientation, outputFmt) {
    throw new Error(
        'ExportService: no encoder provided. ' +
        'Pass encodePixels to ExportService constructor.'
    );
}
