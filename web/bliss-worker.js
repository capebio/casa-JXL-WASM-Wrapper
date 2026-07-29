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
        const rgb = out.slice(8).buffer;
        self.postMessage({ type: 'bliss_decoded', seq, rgb, w, h }, [rgb]);
    } catch (e) {
        self.postMessage({ type: 'bliss_decoded', seq, rgb: null, error: String(e) });
    }
};
