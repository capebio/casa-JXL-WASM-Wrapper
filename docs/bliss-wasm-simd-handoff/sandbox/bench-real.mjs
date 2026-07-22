// Proper real-content numbers for the paper: scalar-WASM vs v128-WASM BLISS decode on real Gobabeb
// RAW pixels (not synthetic). Same bytes decoded by both builds → byte-identical check + MP/s speedup.
// Root pkg decodes ORF→RGBA + downscales; the two sandbox pkgs (pkg = v128, pkg-scalar = no-simd) decode.
import { readFileSync } from 'node:fs';
import { initAll, decodeOrfRgba, downscale_rgba, listOrf } from '../raw-converter-wasm/benchmark/_bench-util.mjs';
import initV128,  { bliss_encode as encV128, bliss_decode as decV128 } from './pkg/bliss_wasm_sandbox.js';
import initScalar,{ bliss_decode as decScalar } from './pkg-scalar/bliss_wasm_sandbox.js';

const SRC = String.raw`c:\Foo\raw-converter\tests\Gobabeb 10`;
const median = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
const mps = (npx,ms) => npx/(ms/1e3)/1e6;
const timeDec = (fn,reps) => { for(let i=0;i<4;i++) fn(); const t=[]; for(let r=0;r<reps;r++){ const s=performance.now(); fn(); t.push(performance.now()-s);} return median(t); };

async function main(){
  await initAll();
  await initV128(readFileSync(new URL('./pkg/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
  await initScalar(readFileSync(new URL('./pkg-scalar/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
  const files = listOrf(SRC, 4);

  for (const [size,reps,tag] of [[512,40,'thumbnail 512px'],[1800,12,'lightbox 1800px']]){
    const rowsScalar=[], rowsV128=[]; let identical=true;
    for (const name of files){
      const img = decodeOrfRgba(`${SRC}\\${name}`);
      const s = size/Math.max(img.w,img.h);
      const w = Math.max(2,Math.round(img.w*s)&~1), h = Math.max(2,Math.round(img.h*s)&~1), npx=w*h;
      const rgbaU8 = (r=>r instanceof Uint8Array?r:new Uint8Array(r))(downscale_rgba(img.rgba,img.w,img.h,w,h));
      const rgb = new Uint8Array(npx*3); for(let i=0;i<npx;i++){rgb[i*3]=rgbaU8[i*4];rgb[i*3+1]=rgbaU8[i*4+1];rgb[i*3+2]=rgbaU8[i*4+2];}
      const enc = encV128(rgb,w,h,2,2); // q2 near-lossless cache tier
      const u8 = enc instanceof Uint8Array?enc:new Uint8Array(enc);
      // byte-identical decode check (both builds, real content)
      const a = decScalar(u8), b = decV128(u8);
      if (a.length!==b.length){ identical=false; } else for(let i=0;i<a.length;i++){ if(a[i]!==b[i]){ identical=false; break; } }
      rowsScalar.push(mps(npx, timeDec(()=>decScalar(u8),reps)));
      rowsV128.push(  mps(npx, timeDec(()=>decV128(u8),  reps)));
    }
    const sc = median(rowsScalar), v1 = median(rowsV128);
    console.log(`${tag.padEnd(16)} scalar ${sc.toFixed(1)} MP/s  →  v128 ${v1.toFixed(1)} MP/s   = ${(v1/sc).toFixed(2)}×   [byte-identical: ${identical?'yes':'NO'}]  (median of ${files.length} real ORFs)`);
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
