// JXL codec worker using @casabio/jxl-wasm facade
// Replaces icodec-based worker with streaming encoder/decoder via new WASM bridge
import { createDecoder, createEncoder, recommendedEffort, preloadJxlModule } from '../packages/jxl-wasm/dist/index.js';

// One-shot shim for backward compatibility with icodec protocol
// (newer callers should use session-based protocol via decode-handler/encode-handler)

const decoders = new Map(); // sessionId → decoder state
const encoders = new Map(); // sessionId → encoder state

preloadJxlModule().catch(err => console.warn('Failed to preload JXL module:', err));

self.onmessage = async ({ data }) => {
  // Decode protocol: decode_jxl message with decodeId and url (one-shot)
  if (data.type === 'decode_jxl') {
    const { decodeId, url } = data;
    try {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();

      const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: true,
        preserveMetadata: true,
      });

      decoder.push(buf);
      decoder.close();

      let pixels = null;
      let width = 0;
      let height = 0;

      for await (const event of decoder.events()) {
        if (event.type === 'final') {
          pixels = event.pixels;
          width = event.info.width;
          height = event.info.height;
        } else if (event.type === 'error') {
          throw new Error(`${event.code}: ${event.message}`);
        }
      }

      await decoder.dispose();

      if (!pixels) {
        throw new Error('No pixels decoded');
      }

      // Convert to Uint8Array if needed (pixels might be ArrayBuffer)
      const pixelsArray = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);

      self.postMessage(
        { type: 'jxl_decoded', decodeId, rgba: pixelsArray, w: width, h: height },
        [pixelsArray.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: 'decode_error',
        decodeId,
        error: String(err?.message ?? err),
      });
    }
    return;
  }

  // Encode protocol: no type field, expects rgba, width, height, quality, effort
  // Returns { id, type: 'done', jxl, jxlMs, w, h, effortUsed, effortRequested }
  const { id, rgba, width, height, quality, effort, progressive } = data;
  const t0 = performance.now();

  try {
    // Convert quality (0-100) to distance (0-15, where 0=lossless, 15=worst)
    // Approximate: distance ≈ (100 - quality) / 6.67
    const distance = quality === 100 ? 0 : Math.max(0.01, (100 - quality) / 6.67);
    const effortLevel = effort ?? recommendedEffort();

    const encoder = createEncoder({
      format: 'rgba8',
      width,
      height,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance,
      quality: null, // distance takes precedence
      effort: effortLevel,
      progressive: !!progressive,
      previewFirst: false,
      chunked: false,
      // This worker owns `rgba` (structured-cloned / transferred in via onmessage)
      // and never touches it before finish() resolves, so skip the facade's
      // defensive pushPixels .slice() — saves one full-frame copy + GC per encode.
      copyInput: false,
    });

    // Collect all chunks. Start the chunks() drain in a separate task BEFORE
    // pushing/finishing, then await pushPixels()/finish() — pushPixels() is async
    // (see facade.ts EncoderImpl.pushPixels) and must be awaited so a push error
    // surfaces here rather than only via chunks(). Matches the sibling encode call
    // sites (e.g. encodeToProgressiveJxl in jxl-progressive-gallery.js).
    const jxlChunks = [];
    const chunksTask = (async () => {
      for await (const chunk of encoder.chunks()) {
        jxlChunks.push(chunk);
      }
    })();

    await encoder.pushPixels(new Uint8Array(rgba));
    await encoder.finish();
    await chunksTask;

    const stats = encoder.getStats();
    await encoder.dispose();

    // Concatenate chunks into single buffer
    const totalSize = jxlChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const jxl = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of jxlChunks) {
      jxl.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    const jxlMs = performance.now() - t0;

    self.postMessage(
      {
        id,
        type: 'done',
        jxl,
        jxlMs,
        w: width,
        h: height,
        effortUsed: effortLevel,
        // Surface the caller-requested effort (may be undefined → defaulted via
        // recommendedEffort()); effortUsed is what the encoder actually applied.
        effortRequested: effort ?? effortLevel,
        ratio: stats?.ratio ?? (jxl.byteLength / (width * height * 4)),
      },
      [jxl.buffer],
    );
  } catch (err) {
    self.postMessage({
      id,
      type: 'encode_error',
      error: String(err?.message ?? err),
    });
  }
};
