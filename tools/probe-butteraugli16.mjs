// Verifies computeButteraugli16 exists and matches the 8-bit path on promoted input.
import * as facade from "../packages/jxl-wasm/dist/index.js";

function rgba8(w, h, f) { const o = new Uint8Array(w*h*4); for (let p=0;p<w*h;p++){ const [r,g,b]=f(p); o[p*4]=r;o[p*4+1]=g;o[p*4+2]=b;o[p*4+3]=255; } return o; }
function promote(u8) { const o = new Uint16Array(u8.length); for (let i=0;i<u8.length;i++) o[i]=u8[i]*257; return o; } // b*257: 0..255 -> 0..65535 exactly

async function main() {
  const w = 64, h = 64;
  const A8 = rgba8(w, h, p => [p & 255, (p*3) & 255, (p*7) & 255]);
  const B8 = rgba8(w, h, p => [(p + 5) & 255, (p*3) & 255, (p*7) & 255]); // shifted red
  const A16 = promote(A8), B16 = promote(B8);

  if (typeof facade.computeButteraugli16 !== "function") throw new Error("computeButteraugli16 not exported from facade");

  const self = await facade.computeButteraugli16(A16.buffer, A16.buffer, w, h);
  if (self !== 0) throw new Error(`compare16(x,x) = ${self}, expected 0`);

  const b16 = await facade.computeButteraugli16(A16.buffer, B16.buffer, w, h);
  const b8 = await facade.computeButteraugli(A8.buffer, B8.buffer, w, h);
  const rel = Math.abs(b16 - b8) / Math.max(b8, 1e-6);
  if (!(rel < 0.02)) throw new Error(`parity fail: b16=${b16} b8=${b8} rel=${rel}`);
  console.log(`OK butteraugli16: self=0, b16=${b16.toFixed(4)} b8=${b8.toFixed(4)} rel=${rel.toFixed(4)}`);
}
main().catch(e => { console.error("PROBE FAIL", e); process.exit(1); });
