// Pure-Node embedded-JPEG preview extractor for RAW files (CR2/DNG/etc).
//
// RAW containers (Canon CR2, DNG) embed one or more full baseline/progressive
// JPEG previews alongside the sensor data. The sensor data itself is often a
// *lossless* JPEG (SOF3, marker 0xC3) — we must NOT pick that. We walk every
// JPEG stream in the file, read its Start-Of-Frame, and choose the largest
// *viewable* (baseline C0 / extended C1 / progressive C2) stream by pixel area.
//
// No external tools (exiftool/dcraw) required.

import { readFileSync } from "node:fs";

const VIEWABLE_SOF = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended, progressive
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

/** Extract the largest viewable embedded preview JPEG. Returns {buffer,w,h,sof}. */
export function extractPreview(filePath) {
  const buf = readFileSync(filePath);
  const streams = findJpegStreams(buf);
  const viewable = streams.filter((s) => VIEWABLE_SOF.has(s.sof));
  if (viewable.length === 0) {
    throw new Error(`no viewable JPEG preview found (streams: ${JSON.stringify(streams)})`);
  }
  viewable.sort((a, b) => b.w * b.h - a.w * a.h);
  const best = viewable[0];
  return {
    buffer: buf.subarray(best.start, best.end),
    w: best.w, h: best.h, sof: best.sof,
    allStreams: streams,
  };
}

// CLI: node extract-preview.mjs <file> [outdir] — writes preview + prints report.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("extract-preview.mjs")) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node extract-preview.mjs <rawfile> [outdir]"); process.exit(1); }
  const { buffer, w, h, sof, allStreams } = extractPreview(file);
  console.log(`file: ${file}`);
  console.log(`streams found: ${allStreams.length}`);
  for (const s of allStreams) {
    const kind = { 0xc0: "baseline", 0xc1: "extended", 0xc2: "progressive", 0xc3: "LOSSLESS(raw)" }[s.sof] || `SOF-0x${s.sof?.toString(16)}`;
    console.log(`  ${String(s.w).padStart(5)}x${String(s.h).padEnd(5)} ${(s.bytes / 1024).toFixed(0).padStart(7)}KB  ${kind}`);
  }
  console.log(`PICKED preview: ${w}x${h} (${(buffer.length / 1024).toFixed(0)}KB, SOF 0x${sof.toString(16)})`);
}
