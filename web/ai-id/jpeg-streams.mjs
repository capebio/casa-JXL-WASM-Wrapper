// Pure JPEG-stream scanner for RAW containers (CR2/DNG/ORF/NEF/RW2/...).
// Extracted from embedded-preview.mjs so the BROWSER chain can use it too:
// no Node built-ins, no sharp, no DOM — just bytes in, stream table out.
//
// RAW containers embed one or more full baseline/progressive JPEG previews alongside the
// sensor data. The sensor data itself is often a *lossless* JPEG (SOF3, marker 0xC3) — we
// must NOT pick that. We walk every JPEG stream, read its Start-Of-Frame, and choose the
// largest *viewable* (baseline C0 / extended C1 / progressive C2) stream by pixel area.

export const VIEWABLE_SOF = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended, progressive
const NON_SOF = new Set([0xc4, 0xc8, 0xcc]); // DHT, JPG, DAC — not frame headers

/** Parse a single JPEG stream starting at `start` (points at FFD8). */
function parseJpegAt(buf, start) {
  let i = start + 2;
  let w = 0, h = 0, sof = null;
  const n = buf.length;
  while (i < n - 1) {
    if (buf[i] !== 0xff) { i++; continue; } // resync
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd9) return { sof, w, h, end: i + 2 }; // EOI
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; continue; // standalone markers (SOI/RSTn/TEM)
    }
    if (i + 3 >= n) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && !NON_SOF.has(marker)) {
      h = (buf[i + 5] << 8) | buf[i + 6];
      w = (buf[i + 7] << 8) | buf[i + 8];
      sof = marker;
    }
    if (marker === 0xda) {
      // Start of scan: skip header, scan entropy-coded data to next real marker.
      let j = i + 2 + len;
      while (j < n - 1) {
        if (buf[j] === 0xff) {
          const m = buf[j + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { j += 2; continue; } // stuffed / RST
          if (m === 0xff) { j++; continue; }
          break;
        }
        j++;
      }
      i = j; continue;
    }
    i += 2 + len;
  }
  return { sof, w, h, end: Math.min(i, n) };
}

/** Return every JPEG stream in the buffer with dims + type. */
export function findJpegStreams(buf) {
  const streams = [];
  const n = buf.length;
  for (let i = 0; i < n - 2; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const p = parseJpegAt(buf, i);
      if (p.w > 0 && p.h > 0 && p.end > i) {
        streams.push({ start: i, end: p.end, bytes: p.end - i, w: p.w, h: p.h, sof: p.sof });
        i = p.end - 1; // skip past this stream (avoid nested rescans)
      }
    }
  }
  return streams;
}

/** Pick the largest viewable preview stream, or null if none reaches `minEdge`. */
export function pickLargestViewable(streams, minEdge = 0) {
  const viewable = streams.filter((s) => VIEWABLE_SOF.has(s.sof));
  if (viewable.length === 0) return null;
  viewable.sort((a, b) => b.w * b.h - a.w * a.h);
  const best = viewable[0];
  if (Math.max(best.w, best.h) < minEdge) return null;
  return best;
}
