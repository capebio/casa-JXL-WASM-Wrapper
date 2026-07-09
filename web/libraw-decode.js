import { metadataToRawMosaicPayload } from './libraw-normalize.js';

const LIBRAW_OPEN_SETTINGS = Object.freeze({
  noInterpolation: true,
  outputBps: 16,
  noAutoBright: true,
  useCameraWb: true,
  useCameraMatrix: 1,
  outputColor: 0,
});

function rawKindFromName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'raw';
}

async function loadLibRawClass(injected) {
  if (injected?.LibRawClass) return injected.LibRawClass;
  const mod = await import('./vendor/libraw-wasm/index.js');
  return mod.default;
}

export async function decodeWithLibRaw(bytes, name = '', injected = {}) {
  const LibRawClass = await loadLibRawClass(injected);
  const raw = new LibRawClass();
  try {
    await raw.open(bytes, LIBRAW_OPEN_SETTINGS);
    const meta = await raw.metadata(true);
    if (!meta) throw new Error('LibRaw returned no metadata');
    const rawImageData = await raw.rawImageData();
    if (!rawImageData) throw new Error('LibRaw returned no raw image data');
    return metadataToRawMosaicPayload(meta, rawImageData, 'libraw:' + rawKindFromName(name));
  } finally {
    if (typeof raw.dispose === 'function') raw.dispose();
  }
}