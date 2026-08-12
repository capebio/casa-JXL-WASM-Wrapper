// Node embedded-JPEG preview extractor for RAW files (CR2/DNG/etc).
//
// The pure byte scanner lives in jpeg-streams.mjs (shared with the browser
// chain in browser-adapter.js); this module only adds the node:fs read.
// No external tools (exiftool/dcraw) required.

import { readFileSync } from "node:fs";
import { findJpegStreams, pickLargestViewable } from "./jpeg-streams.mjs";

// Back-compat re-export: findJpegStreams historically lived here.
export { findJpegStreams };

/** Extract the largest viewable embedded preview JPEG. Returns {buffer,w,h,sof,allStreams}. */
export function extractPreview(filePath) {
  const buf = readFileSync(filePath);
  const streams = findJpegStreams(buf);
  const best = pickLargestViewable(streams);
  if (!best) {
    throw new Error(`no viewable JPEG preview found (streams: ${JSON.stringify(streams)})`);
  }
  return {
    buffer: buf.subarray(best.start, best.end),
    w: best.w, h: best.h, sof: best.sof,
    allStreams: streams,
  };
}
