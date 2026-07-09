const TYPE_SIZE = new Map([
  [1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [7, 1], [9, 4], [10, 8],
]);

const TAG = Object.freeze({
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  make: 271,
  model: 272,
  stripOffsets: 273,
  orientation: 274,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  subIfds: 330,
  cfaRepeatPatternDim: 33421,
  cfaPattern: 33422,
  blackLevel: 50714,
  whiteLevel: 50717,
});

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function isCiffCrw(bytes, ext) {
  return ext === 'crw' || (bytes?.length >= 4 && bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x1a && bytes[3] === 0x00);
}

function readAscii(ctx, entry) {
  const bytes = entryBytes(ctx, entry);
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder('ascii').decode(bytes.subarray(0, end)).trim();
}

function readOne(ctx, type, offset) {
  switch (type) {
    case 1:
    case 7:
      return ctx.bytes[offset];
    case 3:
      return ctx.dv.getUint16(offset, ctx.le);
    case 4:
      return ctx.dv.getUint32(offset, ctx.le);
    case 9:
      return ctx.dv.getInt32(offset, ctx.le);
    default:
      return null;
  }
}

function entryBytes(ctx, entry) {
  const size = TYPE_SIZE.get(entry.type);
  if (!size) return new Uint8Array(0);
  const byteLen = size * entry.count;
  const start = byteLen <= 4 ? entry.valueOffset : ctx.dv.getUint32(entry.valueOffset, ctx.le);
  if (start < 0 || start + byteLen > ctx.bytes.length) return new Uint8Array(0);
  return ctx.bytes.subarray(start, start + byteLen);
}

function entryValues(ctx, entry) {
  const size = TYPE_SIZE.get(entry.type);
  if (!size || entry.type === 2) return [];
  const byteLen = size * entry.count;
  const start = byteLen <= 4 ? entry.valueOffset : ctx.dv.getUint32(entry.valueOffset, ctx.le);
  if (start < 0 || start + byteLen > ctx.bytes.length) return [];
  const values = [];
  for (let i = 0; i < entry.count; i++) {
    const v = readOne(ctx, entry.type, start + i * size);
    if (v == null) return [];
    values.push(v);
  }
  return values;
}

function firstValue(ctx, ifd, tag, fallback = 0) {
  const entry = ifd.tags.get(tag);
  if (!entry) return fallback;
  const values = entryValues(ctx, entry);
  return values.length ? values[0] : fallback;
}

function parseIfd(ctx, offset) {
  if (!offset || offset + 2 > ctx.bytes.length) return null;
  const count = ctx.dv.getUint16(offset, ctx.le);
  const entriesStart = offset + 2;
  const entriesEnd = entriesStart + count * 12;
  if (entriesEnd + 4 > ctx.bytes.length) return null;
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const p = entriesStart + i * 12;
    const tag = ctx.dv.getUint16(p, ctx.le);
    tags.set(tag, {
      tag,
      type: ctx.dv.getUint16(p + 2, ctx.le),
      count: ctx.dv.getUint32(p + 4, ctx.le),
      valueOffset: p + 8,
    });
  }
  return { offset, tags, next: ctx.dv.getUint32(entriesEnd, ctx.le) };
}

function collectIfds(ctx, firstOffset) {
  const out = [];
  const queue = [firstOffset];
  const seen = new Set();
  while (queue.length) {
    const offset = queue.shift();
    if (!offset || seen.has(offset)) continue;
    seen.add(offset);
    const ifd = parseIfd(ctx, offset);
    if (!ifd) continue;
    out.push(ifd);
    if (ifd.next) queue.push(ifd.next);
    const sub = ifd.tags.get(TAG.subIfds);
    if (sub) queue.push(...entryValues(ctx, sub));
  }
  return out;
}

function cfaPhaseFromPattern(pattern) {
  if (!pattern || pattern.length < 4) return null;
  const cells = Array.from(pattern.subarray(0, 4));
  const counts = cells.reduce((acc, v) => {
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
  if (counts[0] !== 1 || counts[1] !== 2 || counts[2] !== 1) return null;
  return cells.indexOf(0);
}

function selectRawIfd(ctx, ifds) {
  const candidates = ifds.filter((ifd) => {
    const w = firstValue(ctx, ifd, TAG.imageWidth);
    const h = firstValue(ctx, ifd, TAG.imageLength);
    const offsets = ifd.tags.get(TAG.stripOffsets);
    const counts = ifd.tags.get(TAG.stripByteCounts);
    return w > 0 && h > 0 && offsets && counts;
  });
  candidates.sort((a, b) => {
    const areaA = firstValue(ctx, a, TAG.imageWidth) * firstValue(ctx, a, TAG.imageLength);
    const areaB = firstValue(ctx, b, TAG.imageWidth) * firstValue(ctx, b, TAG.imageLength);
    return areaB - areaA;
  });
  return candidates.find((ifd) => firstValue(ctx, ifd, TAG.samplesPerPixel, 1) === 1) || candidates[0] || null;
}

function decodeUncompressedTiffMosaic(ctx, format) {
  const ifds = collectIfds(ctx, ctx.firstIfdOffset);
  if (!ifds.length) return { ok: false, format, reason: 'no TIFF IFDs found' };
  const root = ifds[0];
  const rawIfd = selectRawIfd(ctx, ifds);
  if (!rawIfd) return { ok: false, format, reason: 'no strip-backed raw IFD found' };

  const compression = firstValue(ctx, rawIfd, TAG.compression, 1);
  if (compression !== 1) return { ok: false, format, reason: 'compressed ' + format.toUpperCase() + ' raw data needs LibRaw' };
  const samples = firstValue(ctx, rawIfd, TAG.samplesPerPixel, 1);
  if (samples !== 1) return { ok: false, format, reason: 'non-mosaic ' + format.toUpperCase() + ' IFD needs LibRaw' };
  const bits = firstValue(ctx, rawIfd, TAG.bitsPerSample, 0);
  if (bits !== 16) return { ok: false, format, reason: 'packed ' + bits + '-bit ' + format.toUpperCase() + ' data needs LibRaw' };

  const dimEntry = rawIfd.tags.get(TAG.cfaRepeatPatternDim) || root.tags.get(TAG.cfaRepeatPatternDim);
  const dims = dimEntry ? entryValues(ctx, dimEntry) : [];
  if (dims.length >= 2 && (dims[0] !== 2 || dims[1] !== 2)) {
    return { ok: false, format, reason: 'only 2x2 Bayer CFA is supported by hand decoder' };
  }
  const patternEntry = rawIfd.tags.get(TAG.cfaPattern) || root.tags.get(TAG.cfaPattern);
  const cfaPhase = patternEntry ? cfaPhaseFromPattern(entryBytes(ctx, patternEntry)) : null;
  if (cfaPhase == null) return { ok: false, format, reason: 'missing 2x2 Bayer CFA pattern' };

  const width = firstValue(ctx, rawIfd, TAG.imageWidth, 0) >>> 0;
  const height = firstValue(ctx, rawIfd, TAG.imageLength, 0) >>> 0;
  if (!width || !height) return { ok: false, format, reason: 'missing raw dimensions' };
  if (width * height > 50_000_000) return { ok: false, format, reason: 'raw dimensions too large for hand decoder' };

  const stripOffsets = entryValues(ctx, rawIfd.tags.get(TAG.stripOffsets));
  const stripByteCounts = entryValues(ctx, rawIfd.tags.get(TAG.stripByteCounts));
  const totalBytes = width * height * 2;
  const packed = new Uint8Array(totalBytes);
  let dst = 0;
  for (let i = 0; i < stripOffsets.length && i < stripByteCounts.length; i++) {
    const off = stripOffsets[i] >>> 0;
    const len = stripByteCounts[i] >>> 0;
    if (off + len > ctx.bytes.length) return { ok: false, format, reason: 'strip outside file bounds' };
    packed.set(ctx.bytes.subarray(off, off + Math.min(len, totalBytes - dst)), dst);
    dst += len;
    if (dst >= totalBytes) break;
  }
  if (dst < totalBytes) return { ok: false, format, reason: 'not enough raw strip data' };

  const raw = new Uint16Array(width * height);
  const pv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  for (let i = 0; i < raw.length; i++) raw[i] = pv.getUint16(i * 2, ctx.le);

  const makeEntry = root.tags.get(TAG.make);
  const modelEntry = root.tags.get(TAG.model);
  const black = firstValue(ctx, rawIfd, TAG.blackLevel, firstValue(ctx, root, TAG.blackLevel, 0));
  const white = firstValue(ctx, rawIfd, TAG.whiteLevel, firstValue(ctx, root, TAG.whiteLevel, (1 << bits) - 1));
  const orientation = firstValue(ctx, root, TAG.orientation, 1);

  return {
    ok: true,
    format,
    payload: {
      raw,
      width,
      height,
      cfaPhase,
      black,
      white,
      wbR: 1,
      wbB: 1,
      orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
      colorMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      make: makeEntry ? readAscii(ctx, makeEntry) : '',
      model: modelEntry ? readAscii(ctx, modelEntry) : '',
      decoder: 'hand:' + format,
    },
  };
}

function parseTiffLike(bytes, format) {
  if (!bytes || bytes.length < 8) return { ok: false, format, reason: 'file too small' };
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!le && !be) return { ok: false, format, reason: 'not TIFF endian marked' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint16(2, le);
  if (magic !== 42 && magic !== 85) return { ok: false, format, reason: 'not TIFF/RAW magic' };
  const firstIfdOffset = dv.getUint32(4, le);
  return decodeUncompressedTiffMosaic({ bytes, dv, le, firstIfdOffset }, format);
}

export function tryDecodeHandRaw(bytes, name = '') {
  const ext = extOf(name);
  if (isCiffCrw(bytes, ext)) {
    return { ok: false, format: 'crw', reason: 'Canon CRW CIFF compression needs LibRaw' };
  }
  if (ext === 'nef' || ext === 'nrw') return parseTiffLike(bytes, ext);
  if (ext === 'rw2' || ext === 'rwl') return parseTiffLike(bytes, ext);
  return { ok: false, format: ext || 'raw', reason: 'no hand decoder for this RAW family' };
}



