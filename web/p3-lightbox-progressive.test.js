import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const mainJs = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const cachePolicyJs = readFileSync(new URL('./jxl-decode-cache-policy.js', import.meta.url), 'utf8');
const decodeWorkerJs =readFileSync(new URL('./jxl-decode-worker.js', import.meta.url), 'utf8');

test('P3.1 JXL decode worker emits progressive frames before final with jsquash fallback', () => {
    expect(decodeWorkerJs).toContain("import { createDecoder, preloadJxlModule } from '../packages/jxl-wasm/dist/index.js';");
    expect(decodeWorkerJs).toContain("import decodeFallback from './vendor/jsquash-jxl/decode.js';");
    expect(decodeWorkerJs).toContain("if (data.type === 'preload')");
    expect(decodeWorkerJs).toContain('data.progressive');
    expect(decodeWorkerJs).toContain("progressiveDetail: progressiveDetail ?? 'lastPasses'");
    expect(decodeWorkerJs).toContain("type: 'jxl_progress'");
    expect(decodeWorkerJs).toContain('postProgress(decodeId, event, false)');
    expect(decodeWorkerJs).toContain("isFinal: true");
    expect(decodeWorkerJs).toContain("type: 'jxl_decoded'");
    expect(decodeWorkerJs).toContain('const copy = new Uint8ClampedArray(rgba)');
    expect(decodeWorkerJs).toContain('decodeWithJsquashFallback');
});

// The WorkerPool decodeJxl became decodeJxlViaSession on the shared jxl-session
// scheduler (0f300f87); progressive is now on unless a caller passes false.
test('P3.1 session decode forwards progressive options and fans out until final', () => {
    expect(mainJs).toContain('function decodeJxlViaSession(url, callback, priority = \'normal\', options = {})');
    expect(mainJs).toContain('options: { ...options }');
    expect(mainJs).toContain('emitEveryPass: options?.progressive !== false');
    expect(mainJs).toContain("progressiveDetail: options?.progressiveDetail ?? 'lastPasses'");
    expect(mainJs).toContain("listener.options?.cachePolicy ?? 'never'");
    expect(mainJs).toContain("msg.type === 'jxl_progress'");
    expect(mainJs).toContain("const isFinal = msg.type === 'jxl_decoded' || msg.isFinal === true;");
});

// The policy branches moved into jxl-decode-cache-policy.js (7a47d330, finding 48).
test('P3.1 main-thread cache policy and the three production call sites are wired', () => {
    expect(mainJs).toContain("The default cache policy for visible lightbox JXL paints is currently 'onFirstProgress'");
    expect(mainJs).toContain('function applyJxlDecodeCachePolicy(');
    expect(mainJs).toContain('target: getCardState(card)');
    expect(cachePolicyJs).toContain("policy === 'onFirstProgress'");
    expect(cachePolicyJs).toContain("policy === 'onFinal' && isFinal");
    expect(cachePolicyJs).toContain('target._jxlProgressCacheDecodeId = decodeId');
    expect(mainJs).toContain("cachePolicy: 'onFirstProgress'");
    const onFinalCallSites = mainJs.match(/cachePolicy: 'onFinal'/g) ?? [];
    expect(onFinalCallSites.length).toBeGreaterThanOrEqual(2);
});
