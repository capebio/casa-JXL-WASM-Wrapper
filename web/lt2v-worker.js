// LT2V decode worker.
// Messages from main: { type: 'load', wasmUrl, data: Uint8Array }
//                     { type: 'seek', frame: number }
//                     { type: 'pause' } / { type: 'resume' }
// Messages to main:   { type: 'ready', width, height, frameCount, fpsNum, fpsDen, isLossless, fileSize }
//                     { type: 'frame', idx: number, rgb: ArrayBuffer }   (rgb is transferred)
//                     { type: 'end' }
//                     { type: 'error', message }

let decoder = null;
let paused  = false;
let frameIdx = 0;
let decodeCount = 0;
let decodeStart = 0;

async function load(wasmUrl, data) {
  try {
    const { default: init, Lt2vDecoder } = await import(wasmUrl);
    await init();
    decoder = new Lt2vDecoder(data);
    const fileSize = data.byteLength;
    self.postMessage({
      type: 'ready',
      width:       decoder.width(),
      height:      decoder.height(),
      frameCount:  decoder.frame_count(),
      fpsNum:      decoder.fps_num(),
      fpsDen:      decoder.fps_den(),
      isLossless:  decoder.is_lossless(),
      fileSize,
    });
    decodeStart = performance.now();
    pump();
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e) });
  }
}

// Pump frames as fast as possible (main thread will buffer/gate playback).
// We send each decoded frame and let the main thread queue them.
// We throttle to avoid allocating the entire video at once.
const MAX_QUEUED = 8;
let queued = 0;

function pump() {
  if (paused) return;
  if (!decoder) return;

  while (queued < MAX_QUEUED) {
    const rgb = decoder.decode_next_frame();
    if (rgb == null) {
      self.postMessage({ type: 'end' });
      return;
    }
    const idx = frameIdx++;
    decodeCount++;
    const decFps = decodeCount / ((performance.now() - decodeStart) / 1000);
    self.postMessage({ type: 'frame', idx, rgb: rgb.buffer, decFps }, [rgb.buffer]);
    queued++;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'load':
      load(msg.wasmUrl, msg.data);
      break;
    case 'ack':
      // Main thread consumed a frame; allow one more decode
      queued = Math.max(0, queued - 1);
      pump();
      break;
    case 'seek':
      try {
        decoder.seek(msg.frame);
        frameIdx = msg.frame;
        queued = 0;
        paused = false;
        decodeCount = 0;
        decodeStart = performance.now();
        pump();
      } catch (e) {
        self.postMessage({ type: 'error', message: String(e) });
      }
      break;
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      pump();
      break;
  }
};
