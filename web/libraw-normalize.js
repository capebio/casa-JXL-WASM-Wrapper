const IDENTITY_MATRIX = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveFinite(value) {
  return isFiniteNumber(value) && value > 0 ? value : null;
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

function multipliersToWb(mul) {
  if (!Array.isArray(mul) || mul.length < 3) return null;
  const gs = [mul[1], mul[3]].filter(isFiniteNumber).filter((v) => v > 0);
  const g = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0;
  if (!(g > 0) || !isFiniteNumber(mul[0]) || mul[0] <= 0 || !isFiniteNumber(mul[2]) || mul[2] <= 0) return null;
  return [mul[0] / g, mul[2] / g];
}
function extractWb(color) {
  // Prefer the camera white balance (cam_mul). LibRaw leaves cam_mul invalid
  // (e.g. [0,1,0,0]) for some bodies — notably old Canon CRW — where its own
  // useCameraWb render falls back to pre_mul (the default/daylight multipliers).
  // Mirror that: cam_mul -> pre_mul -> neutral. Without this the raw green-heavy
  // sensor colour renders as a green cast (verified: canon_a570is/ixus900ti CRW).
  return multipliersToWb(color?.cam_mul) || multipliersToWb(color?.pre_mul) || [1, 1];
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

// LibRaw folds the sensor pedestal into per-channel cblack and reports color.black = 0
// for many bodies (EOS M200 CR3, old-Canon CRW), yet rawImageData is the UN-subtracted
// mosaic with the pedestal intact — and this binding does not expose cblack. Recover the
// black from the masked optical-black margin so process_raw_mosaic subtracts the right
// pedestal; without it, higher-ISO / old-Canon frames render with a colour cast (verified
// EOS M200 CR3 magenta, ixus900ti CRW). Take the MEAN of each masked margin (top rows,
// left cols) and use the MIN: masked pixels are the darkest region, so a "margin" that
// actually overlaps active pixels (brighter) is ignored.
function blackFromMaskedMargins(rawImageData) {
  const raw = rawImageData?.data;
  const rawWidth = rawImageData?.raw_width >>> 0;
  const rawHeight = rawImageData?.raw_height >>> 0;
  const left = rawImageData?.left_margin >>> 0;
  const top = rawImageData?.top_margin >>> 0;
  if (!(raw instanceof Uint16Array) || !rawWidth || !rawHeight || raw.length !== rawWidth * rawHeight) return null;
  const means = [];
  if (top >= 2) {
    let s = 0, n = 0;
    for (let y = 0; y < top - 1; y++) for (let x = 0; x < rawWidth; x++) { s += raw[y * rawWidth + x]; n++; }
    if (n) means.push(s / n);
  }
  if (left >= 2) {
    let s = 0, n = 0;
    for (let y = 0; y < rawHeight; y++) for (let x = 0; x < left - 1; x++) { s += raw[y * rawWidth + x]; n++; }
    if (n) means.push(s / n);
  }
  if (!means.length) return null;
  const black = Math.round(Math.min(...means));
  return black >= 0 ? black : null;
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

function extractIso(meta) {
  // LibRaw surfaces ISO speed in multiple locations depending on format and binding version.
  // Check the most common paths; positiveFinite rejects 0, NaN, Infinity, and non-numbers.
  return positiveFinite(meta?.iso_speed)
    ?? positiveFinite(meta?.other?.iso_speed)
    ?? positiveFinite(meta?.shootinginfo?.iso_speed)
    ?? null;
}

function extractBlackLevels(color, scalarBlack) {
  // LibRaw per-channel black levels (cblack[0..3] after pedestal fold).
  // When available as an array of 4 positive values, use them; otherwise replicate scalar.
  const cb = color?.cblack;
  if (Array.isArray(cb) && cb.length >= 4) {
    const levels = [cb[0], cb[1], cb[2], cb[3]];
    if (levels.every((v) => isFiniteNumber(v) && v >= 0)) {
      return levels;
    }
  }
  // Replicate the scalar black across all 4 channels
  return [scalarBlack, scalarBlack, scalarBlack, scalarBlack];
}

function extractWhiteLevels(color, scalarWhite) {
  // LibRaw per-channel white levels (linear_max[0..3]).
  const lm = color?.linear_max;
  if (Array.isArray(lm) && lm.length >= 4) {
    const levels = [lm[0], lm[1], lm[2], lm[3]];
    if (levels.every((v) => isFiniteNumber(v) && v > 0)) {
      return levels;
    }
  }
  return [scalarWhite, scalarWhite, scalarWhite, scalarWhite];
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
  // Prefer a genuine reported black (>0); else recover it from the masked margin, since
  // rawImageData is un-subtracted and LibRaw usually reports 0 here. Clamp below white.
  const reportedBlack = isFiniteNumber(color.black) && color.black > 0 ? color.black : null;
  const recoveredBlack = reportedBlack ?? blackFromMaskedMargins(rawImageData) ?? 0;
  const black = Math.max(0, Math.min(recoveredBlack, white - 1));

  // ISO: surface from the LibRaw metadata, null when absent
  const iso = extractIso(meta);

  // Per-channel black and white levels for noise calibration consumers
  const blackLevels = extractBlackLevels(color, black);
  const whiteLevels = extractWhiteLevels(color, white);

  return {
    raw: cropVisibleRaw(rawImageData),
    width: rawImageData.width >>> 0,
    height: rawImageData.height >>> 0,
    cfaPhase,
    black,
    white,
    blackLevels,
    whiteLevels,
    iso,
    wbR,
    wbB,
    orientation: orientationFromLibRawFlip(meta?.flip ?? 0),
    colorMatrix: extractMatrix(color),
    make: String(meta?.camera_make || meta?.normalized_make || '').trim(),
    model: String(meta?.camera_model || meta?.normalized_model || '').trim(),
    decoder: decoderName,
  };
}