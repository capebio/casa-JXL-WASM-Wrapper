// Phase 0 baseline: scalar BLISS decode throughput in the simd128 sandbox build (no v128 kernels yet).
// This is the number the v128 port must beat, measured in the same harness for apples-to-apples.
import { readFileSync } from 'node:fs';
import init, { bliss_encode, bliss_decode } from './pkg/bliss_wasm_sandbox.js';

// photo-like: smooth gradients + pseudo-random noise (realistic rANS entropy; pure gradients decode unrealistically fast)
function photoRgb(w,h){ let s=0x9e3779b1>>>0; const rnd=()=>{ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s&255; };
  const rgb=new Uint8Array(w*h*3);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*3; const n=rnd()>>3;
    rgb[i]=((x*255/w)+n)&255; rgb[i+1]=((y*255/h)+n)&255; rgb[i+2]=(((x+y)*255/(w+h))+n)&255; }
  return rgb; }
const median = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };

async function main(){
  await init(readFileSync(new URL('./pkg/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
  for (const [w,h,reps,tag] of [[512,384,60,'thumbnail 512px'],[1800,1200,15,'lightbox 1800px']]){
    const rgb = photoRgb(w,h);
    const enc = bliss_encode(rgb, w, h, 2, 2); // q2 near-lossless = the cache tier
    const npx = w*h;
    // warm
    for (let i=0;i<5;i++) bliss_decode(enc);
    const ms=[]; for (let r=0;r<reps;r++){ const t=performance.now(); bliss_decode(enc); ms.push(performance.now()-t); }
    const med = median(ms), mps = npx/(med/1e3)/1e6;
    console.log(`${tag.padEnd(16)} ${w}x${h}  ${(enc.length/1024).toFixed(1)}KB  decode ${med.toFixed(2)}ms  ${mps.toFixed(1)} MP/s  [v128 rANS + v128 recon]`);
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
