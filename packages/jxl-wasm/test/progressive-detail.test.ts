import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDecoder, createEncoder, setJxlModuleFactoryForTesting } from '../src/index';

const facade = readFileSync(new URL('../src/facade.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/bridge.cpp', import.meta.url), 'utf8');

test('decoder facade exposes finer progressive detail than DC-only', () => {
  expect(facade).toContain('export type ProgressiveDetail = "dc" | "lastPasses" | "passes" | "dcProgressive";');
  expect(facade).toContain('progressiveDetail?: ProgressiveDetail;');
  expect(facade).toContain('resolveDecoderProgressiveDetail');
  // Explicit progressiveDetail must enable libjxl progressive even when emitEveryPass is false.
  expect(facade).toContain('options.progressiveDetail === undefined');
  expect(bridge).toContain('kLastPasses');
  expect(bridge).toContain('kPasses');
  expect(bridge).not.toContain('JxlDecoderSetProgressiveDetail(dec, kDC)');
});

test('progressiveDetail is plumbed through DecodeOptions, MsgDecodeStart, session, and worker handlers', () => {
  const types = readFileSync(new URL('../../jxl-core/src/types.ts', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../../jxl-core/src/protocol.ts', import.meta.url), 'utf8');
  const decodeSession = readFileSync(new URL('../../jxl-session/src/decode-session.ts', import.meta.url), 'utf8');
  const browserHandler = readFileSync(new URL('../../jxl-worker-browser/src/decode-handler.ts', import.meta.url), 'utf8');
  const nodeHandler = readFileSync(new URL('../../jxl-worker-node/src/decode-handler.ts', import.meta.url), 'utf8');

  expect(types).toContain('progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive"');
  expect(protocol).toContain('progressiveDetail: "dc" | "lastPasses" | "passes" | "dcProgressive" | null');
  expect(decodeSession).toContain('progressiveDetail: opts.progressiveDetail ?? null');
  expect(browserHandler).toContain('this.opts.progressiveDetail !== null');
  expect(nodeHandler).toContain('this.opts.progressiveDetail !== null');
});

test('libjxl is pinned to v0.11.2 or later for VarDCT progressive fix', () => {
  const buildScript = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const tagMatch = buildScript.match(/libjxlTag:\s*"v(\d+)\.(\d+)\.(\d+)"/);
  expect(tagMatch).not.toBeNull();
  const [, major, minor, patch] = tagMatch!;
  const version = [Number(major), Number(minor), Number(patch)];
  // VarDCT progressive decode fix (libjxl #4223) landed in v0.11.2.
  const min = [0, 11, 2];
  const ge =
    version[0]! > min[0]! ||
    (version[0] === min[0] && version[1]! > min[1]!) ||
    (version[0] === min[0] && version[1] === min[1] && version[2]! >= min[2]!);
  expect(ge).toBe(true);
});

test('groupOrder (center-out) is exposed in EncoderOptions and plumbed through FFI/bridge (predator next heat)', () => {
  expect(facade).toContain('groupOrder?: 0 | 1');
  expect(bridge).toContain('JXL_ENC_FRAME_SETTING_GROUP_ORDER');
  expect(bridge).toContain('enc_group_order');
  expect(bridge).toContain('group_order');
});

test('correlation matrix (encode-space benchmark tool) treats progressiveDc + groupOrder as first-class sweep factors and forwards to createEncoder (predator continuation heat)', () => {
  const matrix = readFileSync(new URL('../../../web/jxl-correlation-matrix.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../../../web/jxl-correlation-worker.js', import.meta.url), 'utf8');

  // Factors + bias + N/A (UI side)
  expect(matrix).toContain('progressiveDc:');
  expect(matrix).toContain('groupOrder:');
  expect(matrix).toContain('Predator bias');
  expect(matrix).toContain('progressiveDc requires progressive');

  // Forwarding in the off-main encode worker (the actual call site for the matrix)
  expect(worker).toContain('progressiveDc: combo.progressive');
  expect(worker).toContain('groupOrder: combo.progressive');

  // Decode-side layer metrics collection (progressEvents / firstProgress*) now lives in worker so matrix surfaces
  // Prog Events + 1st Prog KB for predator sweeps (Dc x group). Matches the collection in predator-progressive-metrics.
  expect(worker).toContain('exactBuffer');
  expect(worker).toContain('createDecoder');
  expect(worker).toContain("progressiveDetail: 'passes'");
  expect(worker).toContain('for await (const ev of decoder.events())');
  expect(worker).toContain('progressEvents');
  expect(worker).toContain('firstProgressBytes');
  expect(worker).toContain('decode-side layer metrics');

  // Prefix-probe for minBytesToFirstProgress (handoff headroom: true early bytes independent of chunk feed)
  expect(worker).toContain('probeMinBytesToFirstProgress');
  expect(worker).toContain('minBytesToFirstProgress');
  expect(matrix).toContain('Min 1st KB (probe)'); // UI label in matrix table
  expect(worker).toContain('Prefix-probe helper');
});

test('progressive encoder enables responsive ordering like cjxl --progressive', () => {
  expect(bridge).toContain('JXL_ENC_FRAME_SETTING_RESPONSIVE');
  expect(bridge).toContain('ApplyProgressiveFrameSettings');
  expect(bridge).toContain('progressive_dc > 0 || progressive_ac > 0 || qprogressive_ac > 0');
});

test('encoder exposes explicit VarDCT AC/Q-progressive overrides for progressive truth matrix', () => {
  const distFacade = readFileSync(new URL('../dist/facade.js', import.meta.url), 'utf8');
  const distTypes = readFileSync(new URL('../dist/facade.d.ts', import.meta.url), 'utf8');

  expect(facade).toContain('progressiveAc?: 0 | 1 | 2');
  expect(facade).toContain('qProgressiveAc?: 0 | 1 | 2');
  expect(facade).toContain('options.progressiveAc != null');
  expect(facade).toContain('options.qProgressiveAc != null');
  expect(distFacade).toContain('options.progressiveAc != null');
  expect(distFacade).toContain('options.qProgressiveAc != null');
  expect(distTypes).toContain('progressiveAc?: 0 | 1 | 2');
  expect(distTypes).toContain('qProgressiveAc?: 0 | 1 | 2');
});

test('stateful progressive decoder releases prior input before appending stream chunks', () => {
  expect(bridge).toContain('JxlDecoderReleaseInput(s->dec)');
  expect(bridge).toContain('unprocessed tail + newly appended bytes');
  expect(bridge).toContain('memmove(s->input_buf');
  expect(bridge).toContain('JxlDecoderSetInput(s->dec, s->input_buf, s->input_size)');
});

test('stateful progressive decoder flushes on JXL_DEC_FRAME_PROGRESSION and one open-stream snapshot per input generation', () => {
  // Real pass boundaries come from FRAME_PROGRESSION; the generation gate adds chunk-visible
  // paint checkpoints for streams where libjxl exposes only coarse progression events.
  expect(bridge).toContain('TryFlushProgressiveImage');
  expect(bridge).toContain('status == JXL_DEC_FRAME_PROGRESSION');
  expect(bridge).toContain('status == JXL_DEC_NEED_MORE_INPUT');
  expect(bridge).toContain('s->frame_started');
  expect(bridge).toContain('opportunistic_flush_generation != s->input_generation');
  expect(bridge).toContain('s->opportunistic_flush_generation = s->input_generation');
  expect(bridge).not.toContain('prev_flush_checksum');
  // All-zero scan skipped after first flush via flush_count guard.
  expect(bridge).toContain('flush_count');
  expect(bridge).toContain('s->flush_count == 0');
  expect(bridge).toContain('progressive UI');
});

test('stateful progressive decoder exposes progress snapshots as borrowed buffers', () => {
  expect(bridge).toContain('MakeBufferBorrowed');
  expect(bridge).toContain('JxlWasmBuffer* buf = MakeBufferBorrowed(s->pixels');
  expect(bridge).not.toContain('memcpy(s->flushed, s->pixels, s->pixels_size)');
  expect(bridge).toContain('owned_data');
  expect(bridge).toContain('if (buffer->owned_data && buffer->data != nullptr');
});

test('duplicate progressive flush suppression is opt-in experiment only', () => {
  expect(facade).toContain('suppressDuplicateProgress?: boolean');
  expect(facade).toContain('DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS');
  expect(facade).toContain('options.suppressDuplicateProgress ? DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS : 0');
  expect(facade).toContain('_jxl_wasm_dec_create_x');
  expect(bridge).toContain('jxl_wasm_dec_create_x');
  expect(bridge).toContain('suppress_duplicate_progress');
  expect(bridge).toContain('last_progress_hash');
});

test('progressive bridge exposes flush metrics to facade', () => {
  expect(bridge).toContain('flush_attempts');
  expect(bridge).toContain('flush_successes');
  expect(bridge).toContain('flush_zero_skips');
  expect(bridge).toContain('flush_duplicate_skips');
  expect(bridge).toContain('flush_image_ms');
  expect(bridge).toContain('jxl_wasm_dec_flush_attempts');
  expect(bridge).toContain('jxl_wasm_dec_flush_successes');
  expect(bridge).toContain('jxl_wasm_dec_flush_zero_skips');
  expect(bridge).toContain('jxl_wasm_dec_flush_duplicate_skips');
  expect(bridge).toContain('jxl_wasm_dec_flush_image_ms');
  expect(facade).toContain('bridge_flush_attempts');
  expect(facade).toContain('bridge_flush_successes');
  expect(facade).toContain('bridge_flush_zero_skips');
  expect(facade).toContain('bridge_flush_duplicate_skips');
  expect(facade).toContain('bridge_flush_image_ms');
  const exportsDec = readFileSync(new URL('../exports-dec.txt', import.meta.url), 'utf8');
  const exportsEnc = readFileSync(new URL('../exports-enc.txt', import.meta.url), 'utf8');
  const exportsMono = readFileSync(new URL('../exports.txt', import.meta.url), 'utf8');
  for (const name of [
    '_jxl_wasm_dec_flush_attempts',
    '_jxl_wasm_dec_flush_successes',
    '_jxl_wasm_dec_flush_zero_skips',
    '_jxl_wasm_dec_flush_duplicate_skips',
    '_jxl_wasm_dec_flush_image_ms',
  ]) {
    expect(exportsDec).toContain(name);
    expect(exportsEnc).toContain(name);
    expect(exportsMono).toContain(name);
  }
});

test('progressive paint-target knob is wired core -> C API -> bridge -> facade', () => {
  const decFrameH = readFileSync(new URL('../../../external/libjxl-012/lib/jxl/dec_frame.h', import.meta.url), 'utf8');
  const decodeCc = readFileSync(new URL('../../../external/libjxl-012/lib/jxl/decode.cc', import.meta.url), 'utf8');
  const decodeApiH = readFileSync(new URL('../../../external/libjxl-012/lib/include/jxl/decode.h', import.meta.url), 'utf8');

  // Core FrameDecoder: paint-target field + even-spaced schedule builder, and the
  // per-frame reset of the pause schedule (no cross-frame accumulation).
  expect(decFrameH).toContain('void SetProgressivePaintTarget(size_t paints)');
  expect(decFrameH).toContain('void BuildPassPauseSchedule()');
  expect(decFrameH).toContain('size_t progressive_paint_target_ = 0;');
  expect(decFrameH).toContain('passes_to_pause_.clear();');

  // Public C API extension + driver wiring at the TOC stage.
  expect(decodeApiH).toContain('JxlDecoderSetProgressivePaintTarget(JxlDecoder* dec, uint32_t paints)');
  expect(decodeCc).toContain('JxlDecoderStatus JxlDecoderSetProgressivePaintTarget(');
  expect(decodeCc).toContain('dec->frame_dec->SetProgressivePaintTarget(dec->prog_paint_target)');

  // Bridge export + facade plumbing (option, module decl, call site).
  expect(bridge).toContain('void jxl_wasm_dec_set_paint_target(JxlWasmDecState* s, uint32_t paints)');
  expect(bridge).toContain('JxlDecoderSetProgressivePaintTarget(s->dec, paints)');
  expect(facade).toContain('progressivePaintTarget?: number;');
  expect(facade).toContain('_jxl_wasm_dec_set_paint_target?(state: number, paints: number): void;');
  expect(facade).toContain('module._jxl_wasm_dec_set_paint_target(dec, paintTarget)');
});

test('alpha-progressive opt-in is wired core -> C API -> bridge flag -> facade', () => {
  const decFrameH = readFileSync(new URL('../../../external/libjxl-012/lib/jxl/dec_frame.h', import.meta.url), 'utf8');
  const decodeCc = readFileSync(new URL('../../../external/libjxl-012/lib/jxl/decode.cc', import.meta.url), 'utf8');
  const decodeApiH = readFileSync(new URL('../../../external/libjxl-012/lib/include/jxl/decode.h', import.meta.url), 'utf8');

  // Core: member-flag guard relaxation (env hack must be gone).
  expect(decFrameH).toContain('void SetAllowExtraChannelProgressive(bool allow)');
  expect(decFrameH).toContain('allow_extra_channel_progressive_');
  expect(decFrameH).not.toContain('JXL_ALLOW_ALPHA_PROGRESSIVE');
  expect(decFrameH).not.toContain('std::getenv');
  // Public C API + driver wiring.
  expect(decodeApiH).toContain('JxlDecoderSetAllowAlphaProgressive(JxlDecoder* dec, JXL_BOOL allow)');
  expect(decodeCc).toContain('JxlDecoderStatus JxlDecoderSetAllowAlphaProgressive(');
  expect(decodeCc).toContain('dec->frame_dec->SetAllowExtraChannelProgressive(');
  // Bridge reuses the create flags channel (bit 1) — no new export needed.
  expect(bridge).toContain('flags & 2u');
  expect(bridge).toContain('JxlDecoderSetAllowAlphaProgressive(dec, JXL_TRUE)');
  // Facade: flag constant + option + OR into decFlags.
  expect(facade).toContain('DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE = 2;');
  expect(facade).toContain('allowAlphaProgressive?: boolean;');
  expect(facade).toContain('this.options.allowAlphaProgressive ? DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE : 0');
});

test('paint-target symbol is exported from dec + enc + monolithic builds', () => {
  const exportsDec = readFileSync(new URL('../exports-dec.txt', import.meta.url), 'utf8');
  const exportsEnc = readFileSync(new URL('../exports-enc.txt', import.meta.url), 'utf8');
  const exportsMono = readFileSync(new URL('../exports.txt', import.meta.url), 'utf8');
  expect(exportsDec).toContain('_jxl_wasm_dec_set_paint_target');
  expect(exportsEnc).toContain('_jxl_wasm_dec_set_paint_target');
  expect(exportsMono).toContain('_jxl_wasm_dec_set_paint_target');
});

test('reusable ProcessSections scratch replaces per-call vectors (byte-exact, flattened)', () => {
  const decFrameCc = readFileSync(new URL('../../../external/libjxl-012/lib/jxl/dec_frame.cc', import.meta.url), 'utf8');
  const decFrameH = readFileSync(new URL('../../../external/libjxl-012/lib/jxl/dec_frame.h', import.meta.url), 'utf8');
  // The former per-call vector-of-vectors must be gone (one heap alloc per AC group/call).
  expect(decFrameCc).not.toContain('std::vector<std::vector<size_t>> ac_group_sec');
  // Decoder-owned reusable scratch, flattened to [group * num_passes + pass].
  expect(decFrameH).toContain('ps_ac_group_sec_');
  expect(decFrameCc).toContain('std::vector<size_t>& ac_group_sec = ps_ac_group_sec_;');
  expect(decFrameCc).toContain('ac_group_sec.assign(num_groups * num_passes, num);');
  expect(decFrameCc).toContain('ac_group_sec[acg * num_passes + acp] = i;');
});

describe('VarDCT progressive decode emits multiple passes (libjxl 0.11.2 fix)', () => {
  // Synthetic noise image: enough entropy that the encoder cannot collapse to a
  // single trivial pass under VarDCT progressive_ac.
  function makeNoisePixels(width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    let state = 0x9e3779b9 >>> 0;
    for (let i = 0; i < width * height; i++) {
      state = (state * 1103515245 + 12345) >>> 0;
      out[i * 4 + 0] = (state >>> 16) & 0xff;
      state = (state * 1103515245 + 12345) >>> 0;
      out[i * 4 + 1] = (state >>> 16) & 0xff;
      state = (state * 1103515245 + 12345) >>> 0;
      out[i * 4 + 2] = (state >>> 16) & 0xff;
      out[i * 4 + 3] = 0xff;
    }
    return out;
  }

  test('progressiveDetail="passes" round-trips a VarDCT bitstream without error', async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModuleForTest);
    const width = 128;
    const height = 128;
    const pixels = makeNoisePixels(width, height);

    const encoder = createEncoder({
      format: 'rgba8',
      width,
      height,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: null,
      quality: 70,
      effort: 3,
      progressive: true,
      progressiveFlavor: 'ac',
      previewFirst: true,
      progressiveDc: 2,
      chunked: false,
      groupOrder: 1,
    });
    encoder.pushPixels(pixels);
    encoder.finish();

    const chunks: Uint8Array[] = [];
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    await encoder.dispose();
    const encoded = concatUint8(chunks);
    expect(encoded.byteLength).toBeGreaterThan(0);

    // progressiveDetail="passes" maps to kPasses (JxlProgressiveDetail=3) — the
    // detail level that exercises the libjxl 0.11.2 VarDCT progressive fix path.
    const decoder = createDecoder({
      format: 'rgba8',
      region: null,
      downsample: 1,
      progressionTarget: 'final',
      emitEveryPass: true,
      progressiveDetail: 'passes',
      preserveIcc: false,
      preserveMetadata: false,
    });
    decoder.push(encoded);
    decoder.close();

    const eventTypes: string[] = [];
    let finalPixels: ArrayBuffer | Uint8Array | null = null;
    for await (const ev of decoder.events()) {
      eventTypes.push(ev.type);
      if (ev.type === 'final') finalPixels = ev.pixels;
      if (ev.type === 'error') throw new Error(ev.message);
    }
    await decoder.dispose();

    expect(eventTypes[0]).toBe('header');
    expect(eventTypes[eventTypes.length - 1]).toBe('final');
    expect(finalPixels).not.toBeNull();
    expect(finalPixels!.byteLength).toBe(width * height * 4);

    // Test/measurement improvement (handoff): with progressiveDc=2 + groupOrder=1 + 'passes' + noise,
    // expect multiple distinct progress events (header + >=1 progress + final) so benchmark surfaces show layers.
    // (Total >=3 events signals the early/more passes win is live in the encode codestream.)
    expect(eventTypes.length).toBeGreaterThanOrEqual(3);
    expect(eventTypes).toContain('progress');
  }, 30000);
});

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function loadPreferredLibjxlModuleForTest() {
  try {
    const imported = await import('../dist/jxl-core.scalar.js');
    if (typeof (imported as { default?: unknown }).default === 'function') {
      const baseUrl = new URL('../dist/', import.meta.url);
      const factory = (imported as { default: (cfg: { locateFile: (p: string) => string }) => Promise<unknown> }).default;
      const module = await factory({ locateFile: (path: string) => new URL(path, baseUrl).href });
      if (module && typeof (module as { _malloc?: unknown })._malloc === 'function') {
        return module as never;
      }
    }
  } catch {}
  // Fallback: return a minimal stub object — tests will see no progress events.
  return {} as never;
}
