import { expect, test } from 'bun:test';
import { createProgressiveDecodeRequest } from './jxl-progressive-decode.js';

// Task 6 (finding 2): the progressive-prefix LOD path REUSES this existing decode request to feed
// range-fetched prefix bytes. The reuse is additive and non-behavioral: attaching a `lod`
// descriptor exposes which prefix the request represents WITHOUT changing the decode_start
// message the worker receives (the opportunistic-flush / chunk-feeding contract is untouched).

class FakeWorker {
    messages = [];
    listeners = new Set();
    postMessage(message, transfer = []) { this.messages.push({ message, transfer }); }
    addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
    removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }
    emit(data) { for (const l of this.listeners) l({ data }); }
    listenerCount() { return this.listeners.size; }
}

test('lod descriptor is exposed on the request but NOT sent in decode_start (message unchanged)', () => {
    const worker = new FakeWorker();
    const request = createProgressiveDecodeRequest({
        worker,
        sessionId: 'lod-1',
        lod: { kind: 'progressive-prefix', byteEnd: 12345 },
    });
    request.start();

    // The request surfaces the LOD it represents (informational, for telemetry / cache keys).
    expect(request.lod).toEqual({ kind: 'progressive-prefix', byteEnd: 12345 });

    // The decode_start message is byte-for-byte the same shape as without a lod: NO `lod` key,
    // and the flush-relevant defaults are untouched.
    const start = worker.messages[0].message;
    expect(start.type).toBe('decode_start');
    expect('lod' in start).toBe(false);
    expect(start).toMatchObject({ progressionTarget: 'final', emitEveryPass: true });
});

test('a request without a lod descriptor exposes null and behaves exactly as before', () => {
    const worker = new FakeWorker();
    const request = createProgressiveDecodeRequest({ worker, sessionId: 'lod-2' });
    request.start();
    expect(request.lod).toBeNull();
    const start = worker.messages[0].message;
    expect('lod' in start).toBe(false);
    expect(start).toMatchObject({ progressionTarget: 'final', emitEveryPass: true });
});

test('range-fetched prefix bytes are fed through the EXISTING push (queue not recreated)', () => {
    const worker = new FakeWorker();
    const request = createProgressiveDecodeRequest({
        worker, sessionId: 'lod-3', lod: { kind: 'progressive-prefix', byteEnd: 8 },
    });
    request.start();
    // The resolved prefix (e.g. from imageStore.getLevelRange) is a single ArrayBuffer fed via push.
    const prefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    request.push(prefix);
    request.close();
    expect(worker.messages.map((m) => m.message.type)).toEqual(['decode_start', 'decode_chunk', 'decode_close']);
    expect(worker.messages[1].transfer).toEqual([prefix]);
});
