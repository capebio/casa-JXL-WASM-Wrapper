/**
 * One-shot pyramid level decode through jxl-session + scheduler.
 * sourceKey = contenthash for dedupe. Skips streaming progressive overhead.
 * format rgba16 returns packed Uint8Array (byteLength = w*h*8) for webgl float + export.
 */

/**
 * @param {import('@casabio/jxl-session').JxlContext} ctx
 * @param {Uint8Array} bytes
 * @param {{ contenthash: string; format?: 'rgba8'|'rgba16'; priority?: 'visible'|'near'|'background'; signal?: AbortSignal; tiled?: boolean; region?: {x:number;y:number;w:number;h:number} }} opts
 */
export async function decodePyramidLevel(ctx, bytes, opts) {
  if (opts.tiled) {
    if (!opts.region) throw new Error('tiled decode requires a viewport region');
    const { decodeTiledViewportPooled } = await import('../../packages/jxl-pyramid/dist/tiled-decode-pool.js');
    // Only options the pooled decoder actually declares are forwarded (finding 78): `format`,
    // `priority`, and `sourceKey` were silently ignored by decodeTiledViewportPooled — that option
    // drift is removed. The container's own JXTC header carries bits-per-sample (rgba8/rgba16), so
    // the pool derives format itself; dedupe/priority are scheduler concerns that do not apply to the
    // tile-container fast path. This ad-hoc pool (own worker per call) is used only when NO runtime is
    // injected; the gallery routes tiled decodes through the single owned runtime (grid-controller).
    const tiled = await decodeTiledViewportPooled(bytes, opts.region, {
      parallel: true,
      signal: opts.signal ?? undefined,
      workerFactory: () => new Worker(
        new URL('../lightbox/tiled-decode-worker.js', import.meta.url),
        { type: 'module' },
      ),
    });
    // Align to the session branch shape ({ pixels, width, height }).
    return { pixels: tiled.pixels, width: tiled.width, height: tiled.height };
  }

  const session = ctx.decode({
    format: opts.format ?? 'rgba8',
    region: opts.region ?? undefined,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    priority: opts.priority ?? 'visible',
    sourceKey: opts.contenthash,
    signal: opts.signal ?? undefined,
  });

  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  await session.push(view);
  await session.close();

  let rgba = null;
  let width = 0;
  let height = 0;
  // jxl-session frames() yields frame events keyed by `stage` (header|dc|pass|final),
  // NOT `type` — the terminal frame is stage === 'final'. (The facade decoder.events()
  // used by decodePyramidRegion below is a different contract that keys on `type`.)
  // Errors surface by frames() throwing, not as an event, so they propagate out of this loop.
  for await (const ev of session.frames()) {
    if (ev.stage === 'final') {
      // Preserve packed bytes for rgba16 (len = w*h*8); Uint8Array container passed through to webgl-pipeline / export.
      rgba = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
      width = ev.info.width;
      height = ev.info.height;
    }
  }
  await session.done();
  if (!rgba) throw new Error('decode produced no final frame');
  return { pixels: rgba, width, height };
}

/**
 * ROI export decode via decodeRegionLod (region + optional long-edge fit).
 * Used for high-precision crop export without decoding the full frame.
 *
 * @param {Uint8Array} bytes
 * @param {{ format?: 'rgba8'|'rgba16'; region: {x:number;y:number;w:number;h:number}; targetLongEdge?: number }} opts
 */
export async function decodePyramidRegion(bytes, opts) {
  const format = opts.format ?? 'rgba8';

  // Tiled levels are JXTC tile containers (magic 'JXTC' = 0x4A,0x58,0x54,0x43), not
  // plain JXL bitstreams. The createDecoder path below cannot parse them ("JXL decode
  // error: 1"); decode the requested region through the tile-container path instead
  // (each overlapping tile is a standalone JXL). This is the same decode the tiled-pool
  // worker runs, called directly for a single on-demand ROI (lightbox display + export).
  if (bytes.length >= 4 && bytes[0] === 0x4A && bytes[1] === 0x58 && bytes[2] === 0x54 && bytes[3] === 0x43) {
    if (!opts.region) throw new Error('tiled region decode requires a region');
    const { decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } = await import('@casabio/jxl-wasm');
    const fn = format === 'rgba16' ? decodeTileContainerRegionRgba16 : decodeTileContainerRegionRgba8;
    const r = opts.region;
    const { pixels, width, height } = await fn(bytes, { x: r.x, y: r.y, w: r.w, h: r.h });
    return { pixels, width, height };
  }

  const { createDecoder } = await import('@casabio/jxl-wasm');
  const decoder = createDecoder({
    format,
    region: opts.region,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    ...(opts.targetLongEdge
      ? { targetWidth: opts.targetLongEdge, targetHeight: opts.targetLongEdge, fitMode: 'contain' }
      : {}),
  });

  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  let pixels = null;
  let width = 0;
  let height = 0;
  const drain = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'final') {
        // Preserve packed byte buffer (Uint8Array stride-8 for rgba16); callers (webgl/export) consume via format.
        pixels = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        width = ev.info.width;
        height = ev.info.height;
      } else if (ev.type === 'error') {
        throw new Error(`${ev.code}: ${ev.message}`);
      }
    }
  })();

  // dispose() must always run (handle leak otherwise); the drain rejection must always be
  // awaited so push/close failures don't leave an unhandled rejection on the drain promise.
  try {
    await decoder.push(view);
    await decoder.close();
    await drain;
  } finally {
    // Swallow a late drain rejection here only to avoid an unhandledrejection; the original
    // error (if any) still propagates from the awaited statements above.
    drain.catch(() => {});
    await decoder.dispose();
  }
  if (!pixels) throw new Error('region decode produced no final frame');
  return { pixels, width, height };
}