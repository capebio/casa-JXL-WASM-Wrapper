import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const mainJs = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const decodeWorkerJs = readFileSync(new URL('./jxl-decode-worker.js', import.meta.url), 'utf8');

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

test('P3.1 WorkerPool forwards progressive options and keeps callbacks alive until final', () => {
    expect(mainJs).toContain('decodeJxl(url, callback, priority = \'normal\', options = {})');
    expect(mainJs).toContain('options: { ...options }');
    expect(mainJs).toContain('progressive: next.options?.progressive === true');
    expect(mainJs).toContain('cachePolicy: next.options?.cachePolicy');
    expect(mainJs).toContain('progressiveDetail: next.options?.progressiveDetail');
    expect(mainJs).toContain("data.type === 'jxl_progress'");
    expect(mainJs).toContain('const isTerminal = data.type === \'jxl_decoded\' || data.type === \'decode_error\';');
});

test('P3.1 main-thread cache policy and the three production call sites are wired', () => {
    expect(mainJs).toContain("The default cache policy for visible lightbox JXL paints is currently 'onFirstProgress'");
    expect(mainJs).toContain('function applyJxlDecodeCachePolicy(');
    expect(mainJs).toContain("policy === 'onFirstProgress'");
    expect(mainJs).toContain("policy === 'onFinal' && isFinal");
    expect(mainJs).toContain('getCardState(card)._jxlProgressCacheDecodeId = decodeId');
    expect(mainJs).toContain("cachePolicy: 'onFirstProgress'");
    const onFinalCallSites = mainJs.match(/cachePolicy: 'onFinal'/g) ?? [];
    expect(onFinalCallSites.length).toBeGreaterThanOrEqual(2);
});
