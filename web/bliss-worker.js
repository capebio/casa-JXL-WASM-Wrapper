import init, { bliss_decode, bliss_decode_preview } from './pkg/raw_converter_wasm.js';

const ready = init();

self.onmessage = async (ev) => {
    const { type, seq } = ev.data;
    if (type === 'preload') { await ready; return; }
    if (type !== 'bliss_decode' && type !== 'bliss_decode_preview') return;
    await ready;
    const bliss = new Uint8Array(ev.data.bliss);
    try {
        const out = type === 'bliss_decode_preview' ? bliss_decode_preview(bliss) : bliss_decode(bliss);
        const dv = new DataView(out.buffer, out.byteOffset);
        const w = dv.getUint32(0, true);
        const h = dv.getUint32(4, true);
        // Transfer the whole wasm-owned copy with an offset past the 8-byte
        // header instead of slice(8) — that slice duplicated the full lightbox
        // RGB (~6.5 MB at 1800px) on the instant-preview critical path.
        const off = out.byteOffset + 8;
        self.postMessage({ type: 'bliss_decoded', seq, rgb: out.buffer, off, w, h }, [out.buffer]);
    } catch (e) {
        self.postMessage({ type: 'bliss_decoded', seq, rgb: null, error: String(e) });
    }
};
