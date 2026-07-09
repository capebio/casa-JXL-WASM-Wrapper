const IDENTITY_MATRIX = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function librawChannelAt(filters, row, col, cdesc) {
  if (!filters || typeof cdesc !== 'string' || cdesc.length < 3) return null;
  const shift = ((((row << 1) & 14) + (col & 1)) << 1);
  const idx = (filters >>> shift) & 3;
  return cdesc[idx] || null;
}

export function cfaPhaseFromLibRawFilters(filters, cdesc = 'RGBG') {
  if (!filters) return null;
  const cells = [
    librawChannelAt(filters, 0, 0, cdesc),
    librawChannelAt(filters, 0, 1, cdesc),
    librawChannelAt(filters, 1, 0, cdesc),
    librawChannelAt(filters, 1, 1, cdesc),
  ];
  const counts = cells.reduce((acc, ch) => {
    acc[ch] = (acc[ch] || 0) + 1;
    return acc;
  }, {});
  if (counts.R !== 1 || counts.G !== 2 || counts.B !== 1) return null;
  const rIndex = cells.indexOf('R');
  if (rIndex < 0) return null;
  return rIndex;
}

export function orientationFromLibRawFlip(flip) {
  switch (flip | 0) {
    case 3: return 3;
    case 5: return 8;
    case 6: return 6;
    default: return 1;
  }
}

function extractWb(color) {
  const cam = Array.isArray(color?.cam_mul) ? color.cam_mul : null;
  if (!cam || cam.length < 3) return [1, 1];
  const gCandidates = [cam[1], cam[3]].filter(isFiniteNumber).filter((v) => v > 0);
  const g = gCandidates.length ? gCandidates.reduce((a, b) => a + b, 0) / gCandidates.length : 1;
  const wbR = isFiniteNumber(cam[0]) && cam[0] > 0 ? cam[0] / g : 1;
  const wbB = isFiniteNumber(cam[2]) && cam[2] > 0 ? cam[2] / g : 1;
  return [wbR, wbB];
}

function extractMatrix(color) {
  const rgbCam = color?.rgb_cam;
  if (!Array.isArray(rgbCam) || rgbCam.length < 3) return IDENTITY_MATRIX.slice();
  const out = [];
  for (let row = 0; row < 3; row++) {
    if (!Array.isArray(rgbCam[row]) || rgbCam[row].length < 3) return IDENTITY_MATRIX.slice();
    out.push(Number(rgbCam[row][0]) || 0, Number(rgbCam[row][1]) || 0, Number(rgbCam[row][2]) || 0);
  }
  return out;
}

function cropVisibleRaw(rawImageData) {
  const raw = rawImageData?.data;
  const width = rawImageData?.width >>> 0;
  const height = rawImageData?.height >>> 0;
  const rawWidth = rawImageData?.raw_width >>> 0;
  const rawHeight = rawImageData?.raw_height >>> 0;
  const left = rawImageData?.left_margin >>> 0;
  const top = rawImageData?.top_margin >>> 0;
  if (!(raw instanceof Uint16Array)) throw new Error('LibRaw rawImageData.data must be Uint16Array');
  if (!width || !height) throw new Error('LibRaw rawImageData missing visible dimensions');
  if (raw.length === width * height) return raw;
  if (!rawWidth || !rawHeight || raw.length !== rawWidth * rawHeight) {
    throw new Error('LibRaw rawImageData length ' + raw.length + ' does not match visible or raw dimensions');
  }
  if (left + width > rawWidth || top + height > rawHeight) {
    throw new Error('LibRaw rawImageData visible crop outside raw bounds');
  }
  const cropped = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcStart = (top + y) * rawWidth + left;
    cropped.set(raw.subarray(srcStart, srcStart + width), y * width);
  }
  return cropped;
}

export function metadataToRawMosaicPayload(meta, rawImageData, decoderName = 'libraw') {
  const color = meta?.color_data || {};
  const cfaPhase = cfaPhaseFromLibRawFilters(meta?.filters, meta?.cdesc || 'RGBG');
  if (cfaPhase == null) {
    throw new Error(('Unsupported LibRaw CFA pattern for ' + (meta?.camera_make || '') + ' ' + (meta?.camera_model || '')).trim());
  }
  const [wbR, wbB] = extractWb(color);
  const white = isFiniteNumber(color.maximum) && color.maximum > 0
    ? color.maximum
    : (isFiniteNumber(color.data_maximum) && color.data_maximum > 0 ? color.data_maximum : 65535);
  return {
    raw: cropVisibleRaw(rawImageData),
    width: rawImageData.width >>> 0,
    height: rawImageData.height >>> 0,
    cfaPhase,
    black: isFiniteNumber(color.black) && color.black >= 0 ? color.black : 0,
    white,
    wbR,
    wbB,
    orientation: orientationFromLibRawFlip(meta?.flip ?? 0),
    colorMatrix: extractMatrix(color),
    make: String(meta?.camera_make || meta?.normalized_make || '').trim(),
    model: String(meta?.camera_model || meta?.normalized_model || '').trim(),
    decoder: decoderName,
  };
}