// Classify an uploaded file into a decode route from its header bytes + name.
// Returns: 'raw' | 'jxl' | 'sdr' | 'tiff' | 'exr' | 'unknown'
//   raw  -> process_orf/dng/cr2     sdr -> createImageBitmap
//   tiff -> wasm decode_tiff        exr -> wasm decode_exr
//   jxl  -> existing jxl path
const RAW_EXT = /\.(orf|dng|cr2|raw|arw|nef|rw2)$/i;

export function detectFormat(bytes, name = '') {
  const b = bytes, n = name.toLowerCase();
  const m = (...s) => s.every((v, i) => b[i] === v);

  if (m(0x76, 0x2f, 0x31, 0x01)) return 'exr';                 // OpenEXR
  if (m(0xff, 0x0a) || n.endsWith('.jxl')) return 'jxl';       // JXL codestream
  if (m(0x00, 0x00, 0x00) && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return 'sdr';                                              // ISO-BMFF (avif/heic) -> browser
  if (m(0x89, 0x50, 0x4e, 0x47)) return 'sdr';                 // PNG
  if (m(0xff, 0xd8, 0xff)) return 'sdr';                       // JPEG
  if (m(0x47, 0x49, 0x46)) return 'sdr';                       // GIF
  if (m(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45
      && b[10] === 0x42 && b[11] === 0x50) return 'sdr';        // WEBP (RIFF…WEBP)
  if (m(0x49, 0x49, 0x2a, 0x00) || m(0x4d, 0x4d, 0x00, 0x2a)) {
    return RAW_EXT.test(n) ? 'raw' : 'tiff';                  // TIFF container
  }
  if (RAW_EXT.test(n)) return 'raw';
  return 'unknown';
}

// RAW extensions the WASM build has NO dedicated decoder for. They are TIFF- or
// rawTIFF-shaped, so a magic-only sniffer would silently misroute them to the
// DNG (ARW/NEF) or ORF (RW2) decoder and emit garbage. detectRawKind refuses
// them by extension so the caller can raise a loud, honest error.
const RAW_UNSUPPORTED_EXT = /\.(arw|nef|rw2)$/i;
const _EMPTY = new Uint8Array(0);

// Single-source RAW sub-router. Given a buffer already classified as 'raw' by
// detectFormat (or any candidate RAW buffer + name), decide which WASM decoder
// to use — WITHOUT the worker re-implementing its own magic sniffer.
// Returns: 'orf' | 'cr2' | 'dng' | 'unsupported' | 'unknown'
//   orf/cr2/dng -> process_{orf,cr2,dng}_with_flags
//   unsupported -> known RAW type with no WASM decoder (ARW/NEF/RW2) -> loud error
//   unknown     -> no recognizable RAW magic and no supported extension -> loud error
// K1 decode_raw contract: never guess a decoder; fail honestly on unknown input.
export function detectRawKind(bytes, name = '') {
  const b = bytes || _EMPTY;
  const n = name.toLowerCase();

  // Refuse the unsupported RAW families up front so their TIFF-shaped magic
  // cannot fall into the DNG/ORF branches below.
  if (RAW_UNSUPPORTED_EXT.test(n)) return 'unsupported';

  // Unambiguous magic wins first.
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x52) return 'orf'; // Olympus 'IIR'
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00 &&
      b[8] === 0x43 && b[9] === 0x52) return 'cr2';                                    // Canon 'II*\0' + 'CR'

  // Extension dispatch for the supported RAW types (explicit, name-led routing).
  if (n.endsWith('.orf')) return 'orf';
  if (n.endsWith('.cr2')) return 'cr2';
  if (n.endsWith('.dng')) return 'dng';

  // Generic TIFF container (little- or big-endian), no RAW-specific extension → DNG.
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'dng';

  // Other Olympus 'II*' variants (e.g. 'IIU…') historically routed to ORF.
  if (b.length >= 2 && b[0] === 0x49 && b[1] === 0x49) return 'orf';

  // Nothing matched — do not guess a decoder.
  return 'unknown';
}
