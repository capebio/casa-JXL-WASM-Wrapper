import { test, expect } from 'vitest';
import { detectFormat, detectRawKind, acceptExtensions, isPipelineInput } from './format-detect.js';

const bytes = (...b) => new Uint8Array(b);

test('magic bytes classify', () => {
  expect(detectFormat(bytes(0x76, 0x2f, 0x31, 0x01), 'x.exr')).toBe('exr');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'x.tif')).toBe('tiff');
  expect(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47), 'x.png')).toBe('sdr');
  expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.jpg')).toBe('jpeg');
  expect(detectFormat(bytes(0x47, 0x49, 0x46, 0x38), 'x.gif')).toBe('sdr');
});

test('RAW tiff containers disambiguate by extension', () => {
  // ORF/DNG/CR2 are TIFF-magic but route to RAW, not the tiff decoder
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.orf')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.dng')).toBe('raw');
});

test('avif by ftyp brand', () => {
  const avif = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66);
  expect(detectFormat(avif, 'x.avif')).toBe('sdr');
});

test('webp fourCC matches full WEBP, not partial WE', () => {
  // RIFF....WEBP -> sdr
  const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
  expect(detectFormat(webp, 'x.webp')).toBe('sdr');
  // RIFF....WE.. (e.g. a non-WebP RIFF whose byte9 is 'E') must NOT classify as sdr
  const notWebp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x00, 0x00);
  expect(detectFormat(notWebp, 'x.bin')).toBe('unknown');
});

test('unknown', () => {
  expect(detectFormat(bytes(1, 2, 3, 4), 'x.bin')).toBe('unknown');
});

// Routing contract consumed by web/worker.js: EXR/TIFF take the image-format
// decode path (decode_exr/decode_tiff → LookRenderer live-edit), RAW keeps the
// ORF/CR2/DNG pipeline, and sdr/jxl/unknown are rejected rather than misrouted
// to the Olympus decoder. These are the exact branch strings worker.js switches
// on, so they must stay stable.
test('worker routing: EXR/TIFF go to the image-format pipeline path', () => {
  // EXR by magic bytes alone (no name needed).
  expect(detectFormat(bytes(0x76, 0x2f, 0x31, 0x01), '')).toBe('exr');
  // Developed TIFF (no RAW extension) → tiff, not raw.
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'render.tif')).toBe('tiff');
  expect(detectFormat(bytes(0x4d, 0x4d, 0x00, 0x2a), 'render.tiff')).toBe('tiff');
  // Big-endian TIFF magic with no name still classifies as tiff.
  expect(detectFormat(bytes(0x4d, 0x4d, 0x00, 0x2a), '')).toBe('tiff');
});

test('worker routing: RAW still wins over the new TIFF path', () => {
  // TIFF-magic RAW must remain raw so it hits pickRawDecoderWithFlags.
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.orf')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.cr2')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.dng')).toBe('raw');
  expect(detectFormat(bytes(0x4d, 0x4d, 0x00, 0x2a), 'nikon.nef')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x55, 0x00), 'pana.rw2')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x1a, 0x00), 'canon.crw')).toBe('raw');
  expect(detectFormat(bytes(0x00, 0x00, 0x00, 0x18), 'canon.cr3')).toBe('raw');
});

test('worker routing: sdr/jxl/unknown are rejected, never sent to RAW decoder', () => {
  expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.jpg')).toBe('jpeg');
  expect(detectFormat(bytes(0xff, 0x0a), 'x.jxl')).toBe('jxl');
  expect(detectFormat(bytes(0, 0, 0, 0), 'x.weird')).toBe('unknown');
});

// ---------------------------------------------------------------------------
// detectRawKind — the single-source RAW sub-router the decode worker consumes
// (web/worker.js pickRawDecoderWithFlags). These are the exact kind strings the
// worker switches on: orf/cr2/dng -> decoder, unsupported/unknown -> loud error.
// ---------------------------------------------------------------------------
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00]; // 'II*\0'
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a]; // 'MM\0*'

test('detectRawKind: Olympus ORF by magic and by extension', () => {
  // 'IIRO' magic → orf regardless of name.
  expect(detectRawKind(bytes(0x49, 0x49, 0x52, 0x4f), '')).toBe('orf');
  expect(detectRawKind(bytes(0x49, 0x49, 0x52, 0x4f), 'x.orf')).toBe('orf');
  // .orf extension with generic TIFF magic still routes to orf.
  expect(detectRawKind(bytes(...TIFF_LE), 'photo.orf')).toBe('orf');
});

test('detectRawKind: Canon CR2 by magic and by extension', () => {
  // 'II*\0' + 'CR' at offset 8 → cr2.
  const cr2 = bytes(0x49, 0x49, 0x2a, 0x00, 0x10, 0, 0, 0, 0x43, 0x52, 0, 0);
  expect(detectRawKind(cr2, 'x.cr2')).toBe('cr2');
  expect(detectRawKind(cr2, '')).toBe('cr2');
  // .cr2 extension with plain TIFF magic (no CR marker) still routes to cr2.
  expect(detectRawKind(bytes(...TIFF_LE), 'photo.cr2')).toBe('cr2');
});

test('detectRawKind: Adobe/DNG-family TIFF → dng', () => {
  expect(detectRawKind(bytes(...TIFF_LE), 'photo.dng')).toBe('dng');
  expect(detectRawKind(bytes(...TIFF_BE), 'photo.dng')).toBe('dng');
  // Generic TIFF container with no RAW-specific extension → dng.
  expect(detectRawKind(bytes(...TIFF_LE), '')).toBe('dng');
  expect(detectRawKind(bytes(...TIFF_BE), '')).toBe('dng');
});

test('detectRawKind: non-native RAW families route by exact kind for LibRaw/hand decoders', () => {
  // TIFF-shaped RAW must NOT reach the DNG decoder. Exact kinds let the worker
  // try hand decoders for selected families before falling back to LibRaw.
  expect(detectRawKind(bytes(...TIFF_LE), 'sony.arw')).toBe('arw');
  expect(detectRawKind(bytes(...TIFF_LE), 'sony.srf')).toBe('srf');
  expect(detectRawKind(bytes(...TIFF_LE), 'sony.sr2')).toBe('sr2');
  expect(detectRawKind(bytes(...TIFF_LE), 'sony.arq')).toBe('arq');
  expect(detectRawKind(bytes(...TIFF_BE), 'nikon.nef')).toBe('nef');
  expect(detectRawKind(bytes(...TIFF_BE), 'nikon.nrw')).toBe('nrw');
  // Panasonic RW2 magic is 'IIU\0' - previously fell through to the ORF decoder.
  expect(detectRawKind(bytes(0x49, 0x49, 0x55, 0x00), 'pana.rw2')).toBe('rw2');
  expect(detectRawKind(bytes(...TIFF_LE), 'leica.rwl')).toBe('rwl');
  expect(detectRawKind(bytes(0x49, 0x49, 0x1a, 0x00), 'canon.crw')).toBe('crw');
  expect(detectRawKind(bytes(0x00, 0x00, 0x00, 0x18), 'canon.cr3')).toBe('cr3');
  expect(detectRawKind(bytes(...TIFF_BE), 'fuji.raf')).toBe('raf');
  expect(detectRawKind(bytes(...TIFF_LE), 'pentax.pef')).toBe('pef');
  expect(detectRawKind(bytes(...TIFF_LE), 'samsung.srw')).toBe('srw');
  expect(detectRawKind(bytes(...TIFF_LE), 'sigma.x3f')).toBe('x3f');
  expect(detectRawKind(bytes(...TIFF_LE), 'hassy.3fr')).toBe('3fr');
  expect(detectRawKind(bytes(...TIFF_LE), 'hassy.fff')).toBe('fff');
  expect(detectRawKind(bytes(...TIFF_LE), 'phase.iiq')).toBe('iiq');
  // Case-insensitive on the extension.
  expect(detectRawKind(bytes(...TIFF_LE), 'SONY.ARW')).toBe('arw');
});

test('detectRawKind: unrecognized magic with no supported ext → unknown (loud error)', () => {
  // A RAW-extension file whose bytes are neither II- nor MM-TIFF must not be
  // guessed into the ORF decoder; it fails honestly.
  expect(detectRawKind(bytes(0x00, 0x01, 0x02, 0x03), 'mystery.raw')).toBe('unknown');
  expect(detectRawKind(bytes(0x00, 0x01, 0x02, 0x03), '')).toBe('unknown');
  // Empty / missing buffer is handled gracefully.
  expect(detectRawKind(bytes(), 'x.raw')).toBe('unknown');
  expect(detectRawKind(undefined, '')).toBe('unknown');
});

test('detectRawKind: other Olympus II* variants fall through to orf', () => {
  // 'IIU…' with no supported extension historically routed to ORF.
  expect(detectRawKind(bytes(0x49, 0x49, 0x55, 0x53), '')).toBe('orf');
});

// ---------------------------------------------------------------------------
// Finding 14: acceptExtensions() + isPipelineInput() — single source of truth
// Every format the detector routes must appear in the accept list and pass
// isPipelineInput so the picker and drag/drop never silently reject a file
// that the worker pipeline can handle.
// ---------------------------------------------------------------------------

test('acceptExtensions returns a non-empty string with comma-separated dot-extensions', () => {
  const acc = acceptExtensions();
  expect(typeof acc).toBe('string');
  expect(acc.length).toBeGreaterThan(0);
  // Each token must start with a dot
  for (const tok of acc.split(',')) {
    expect(tok.trim()).toMatch(/^\.[a-zA-Z0-9]+$/);
  }
});

test('acceptExtensions includes every RAW extension (upper and lower case)', () => {
  const acc = acceptExtensions();
  const RAW_EXTS = ['orf','dng','cr2','raw','arw','srf','sr2','arq','nef','nrw',
                    'rw2','rwl','crw','cr3','raf','pef','srw','x3f','3fr','fff','iiq'];
  for (const ext of RAW_EXTS) {
    expect(acc).toContain(`.${ext}`);
    expect(acc).toContain(`.${ext.toUpperCase()}`);
  }
});

test('acceptExtensions includes JPEG extensions (jpg, jpeg, jfif — all cases)', () => {
  const acc = acceptExtensions();
  for (const ext of ['jpg','jpeg','jfif']) {
    expect(acc).toContain(`.${ext}`);
    expect(acc).toContain(`.${ext.toUpperCase()}`);
  }
});

test('acceptExtensions includes TIFF extensions', () => {
  const acc = acceptExtensions();
  for (const ext of ['tif','tiff']) {
    expect(acc).toContain(`.${ext}`);
    expect(acc).toContain(`.${ext.toUpperCase()}`);
  }
});

test('acceptExtensions includes EXR', () => {
  const acc = acceptExtensions();
  expect(acc).toContain('.exr');
  expect(acc).toContain('.EXR');
});

test('isPipelineInput matches every format the detector handles in the worker', () => {
  // RAW
  expect(isPipelineInput('photo.orf')).toBe(true);
  expect(isPipelineInput('photo.DNG')).toBe(true);
  expect(isPipelineInput('photo.cr2')).toBe(true);
  expect(isPipelineInput('photo.ARW')).toBe(true);
  expect(isPipelineInput('photo.nef')).toBe(true);
  expect(isPipelineInput('photo.rw2')).toBe(true);
  // JPEG
  expect(isPipelineInput('photo.jpg')).toBe(true);
  expect(isPipelineInput('photo.JPG')).toBe(true);
  expect(isPipelineInput('photo.jpeg')).toBe(true);
  expect(isPipelineInput('photo.jfif')).toBe(true);
  expect(isPipelineInput('photo.JFIF')).toBe(true);
  // TIFF
  expect(isPipelineInput('photo.tif')).toBe(true);
  expect(isPipelineInput('photo.TIFF')).toBe(true);
  // EXR
  expect(isPipelineInput('photo.exr')).toBe(true);
  expect(isPipelineInput('photo.EXR')).toBe(true);
});

test('isPipelineInput rejects sdr-only formats (PNG, GIF, WebP) and JXL', () => {
  expect(isPipelineInput('photo.png')).toBe(false);
  expect(isPipelineInput('photo.PNG')).toBe(false);
  expect(isPipelineInput('photo.gif')).toBe(false);
  expect(isPipelineInput('photo.webp')).toBe(false);
  expect(isPipelineInput('photo.jxl')).toBe(false);
  expect(isPipelineInput('photo.avif')).toBe(false);
  expect(isPipelineInput('')).toBe(false);
});
