import { LIBRAW_RAW_EXTENSION_PATTERN, RAW_EXTENSION_PATTERN, RAW_EXTENSIONS } from './raw-extensions.js';

// Classify an uploaded file into a decode route from its header bytes + name.
// Returns: 'raw' | 'jxl' | 'sdr' | 'tiff' | 'exr' | 'jpeg' | 'unknown'
//   raw  -> process_orf/dng/cr2     sdr -> createImageBitmap
//   tiff -> wasm decode_tiff        exr -> wasm decode_exr
//   jpeg -> wasm decode_jpeg (editable dev-image path; lossless archival via transcodeJpegToJxl)
//   jxl  -> existing jxl path

// Finding 14 (P4 T5): single source of truth for every format the pipeline accepts.
// The file picker `accept` attribute and the drag/drop filter both derive from this
// list — never a hand-maintained divergent copy.
// Includes: RAW (all families), JPEG (jpg/jpeg/jfif), TIFF (tif/tiff), EXR.
// Excludes: sdr-only (PNG/GIF/WebP/AVIF) and JXL (handled by a separate decode path).
const PIPELINE_NON_RAW_EXTS = Object.freeze(['jpg', 'jpeg', 'jfif', 'tif', 'tiff', 'exr']);

// Returns a comma-separated accept string suitable for <input type="file" accept="...">.
// Both lower-case and UPPER-CASE variants are included (some OS file dialogs are case-sensitive).
export function acceptExtensions() {
  const all = [...RAW_EXTENSIONS, ...PIPELINE_NON_RAW_EXTS];
  return all.flatMap(e => ['.' + e, '.' + e.toUpperCase()]).join(',');
}

const PIPELINE_NON_RAW_PATTERN = /\.(jpg|jpeg|jfif|tif|tiff|exr)$/i;

// Returns true when a filename (or File.name) would be handled by the worker pipeline.
// Mirrors isPipelineInputFile in main.js but derives from this canonical list.
export function isPipelineInput(name = '') {
  const n = String(name);
  return RAW_EXTENSION_PATTERN.test(n) || PIPELINE_NON_RAW_PATTERN.test(n);
}

export function detectFormat(bytes, name = '') {
  const b = bytes, n = name.toLowerCase();
  const m = (...s) => s.every((v, i) => b[i] === v);

  if (m(0x76, 0x2f, 0x31, 0x01)) return 'exr';                 // OpenEXR
  if (m(0xff, 0x0a) || n.endsWith('.jxl')) return 'jxl';       // JXL codestream
  if (m(0x00, 0x00, 0x00) && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return 'sdr';                                              // ISO-BMFF (avif/heic) -> browser
  if (m(0x89, 0x50, 0x4e, 0x47)) return 'sdr';                 // PNG
  if (m(0xff, 0xd8, 0xff)) return 'jpeg';                      // JPEG -> editable dev-image path
  if (m(0x47, 0x49, 0x46)) return 'sdr';                       // GIF
  if (m(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45
      && b[10] === 0x42 && b[11] === 0x50) return 'sdr';        // WEBP (RIFF…WEBP)
  if (m(0x49, 0x49, 0x2a, 0x00) || m(0x4d, 0x4d, 0x00, 0x2a)) {
    return RAW_EXTENSION_PATTERN.test(n) ? 'raw' : 'tiff';                  // TIFF container
  }
  if (RAW_EXTENSION_PATTERN.test(n)) return 'raw';
  return 'unknown';
}

// RAW extensions beyond ORF/CR2/DNG route to LibRaw, with selected families
// optionally trying hand decoders first in worker.js. Keep explicit routing so
// TIFF-shaped files never silently fall into the DNG or ORF decoder.
const _EMPTY = new Uint8Array(0);

// Single-source RAW sub-router. Given a buffer already classified as 'raw' by
// detectFormat (or any candidate RAW buffer + name), decide which WASM decoder
// to use — WITHOUT the worker re-implementing its own magic sniffer.
// Returns: native kinds ('orf' | 'cr2' | 'dng'), LibRaw/hand kinds
// ('arw' | 'nef' | 'rw2' | ...), or 'unknown'.
//   orf/cr2/dng -> process_{orf,cr2,dng}_with_flags
//   other known RAW -> worker LibRaw path, with hand-first attempts for selected kinds
//   unknown -> loud error
// K1 decode_raw contract: never guess a decoder; fail honestly on unknown input.
export function detectRawKind(bytes, name = '') {
  const b = bytes || _EMPTY;
  const n = name.toLowerCase();

  // Unambiguous magic wins first.
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x52) return 'orf'; // Olympus 'IIR'
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00 &&
      b[8] === 0x43 && b[9] === 0x52) return 'cr2';                                    // Canon 'II*\0' + 'CR'

  // Extension dispatch for RAW types (explicit, name-led routing).
  if (n.endsWith('.orf')) return 'orf';
  if (n.endsWith('.cr2')) return 'cr2';
  if (n.endsWith('.dng')) return 'dng';
  const librawMatch = n.match(LIBRAW_RAW_EXTENSION_PATTERN);
  if (librawMatch) return librawMatch[1].toLowerCase();

  // Generic TIFF container (little- or big-endian), no RAW-specific extension → DNG.
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'dng';

  // Other Olympus 'II*' variants (e.g. 'IIU…') historically routed to ORF.
  if (b.length >= 2 && b[0] === 0x49 && b[1] === 0x49) return 'orf';

  // Nothing matched — do not guess a decoder.
  return 'unknown';
}
