// Pre-generate real-Gobabeb .bliss files for the browser MT bench to fetch + decode.
// Two sizes: lightbox 1800px (~4 bands = the real use case) and large 3400px (~8 bands = scaling headroom).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initAll, decodeOrfRgba, downscale_rgba, listOrf } from '../raw-converter-wasm/benchmark/_bench-util.mjs';
import initV128, { bliss_encode } from './pkg/bliss_wasm_sandbox.js';
import { readFileSync } from 'node:fs';

const SRC = String.raw`c:\Foo\raw-converter\tests\Gobabeb 10`;
const OUT = new URL('./mt-data/', import.meta.url);

async function main(){
  await initAll();
  await initV128(readFileSync(new URL('./pkg/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
  mkdirSync(OUT, { recursive:true });
  const name = listOrf(SRC,1)[0];
  const meta = [];
  for (const [longEdge, tag] of [[512,'thumbnail'],[1800,'lightbox'],[3400,'large']]){
    const img = decodeOrfRgba(`${SRC}\\${name}`, longEdge);
    const w = img.w&~1, h = img.h&~1, npx = w*h;
    const rgbaU8 = (r=>r instanceof Uint8Array?r:new Uint8Array(r))(downscale_rgba(img.rgba,img.w,img.h,w,h));
    const rgb = new Uint8Array(npx*3); for(let i=0;i<npx;i++){rgb[i*3]=rgbaU8[i*4];rgb[i*3+1]=rgbaU8[i*4+1];rgb[i*3+2]=rgbaU8[i*4+2];}
    const enc = bliss_encode(rgb,w,h,2,2);
    const u8 = enc instanceof Uint8Array?enc:new Uint8Array(enc);
    writeFileSync(new URL(`./${tag}.bliss`, OUT), Buffer.from(u8));
    const bands = Math.max(1,Math.min(8,Math.floor(h/256)));
    meta.push({ tag, w, h, mp:+(npx/1e6).toFixed(2), bytes:u8.length, bands });
    console.log(`${tag}: ${w}x${h} (${(npx/1e6).toFixed(2)} MP) ~${bands} bands → ${(u8.length/1024).toFixed(0)} KB`);
  }
  writeFileSync(new URL('./manifest.json', OUT), JSON.stringify(meta,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
