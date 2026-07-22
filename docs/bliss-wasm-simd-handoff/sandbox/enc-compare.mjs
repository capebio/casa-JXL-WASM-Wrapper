import { readFileSync } from 'node:fs';
import initV, { bliss_encode as encV } from './pkg/bliss_wasm_sandbox.js';
import initS, { bliss_encode as encS } from './pkg-scalar/bliss_wasm_sandbox.js';
await initV(readFileSync(new URL('./pkg/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
await initS(readFileSync(new URL('./pkg-scalar/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
const med=a=>{const q=[...a].sort((x,y)=>x-y);return q[q.length>>1];};
const time=(fn)=>{for(let i=0;i<3;i++)fn();const t=[];for(let r=0;r<9;r++){const s=performance.now();fn();t.push(performance.now()-s);}return med(t);};
// byte-identity across sizes/entropy, incl. non-16-multiple + tiny (tail/renorm edges)
let ident=true, cases=0;
for(const [w,h] of [[512,384],[514,300],[100,64],[18,10],[2,2],[1800,1344]])for(const kind of ['noise','flat','grad']){
  const npx=w*h; let s=0x2545f491>>>0; const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s;};
  const rgb=new Uint8Array(npx*3);
  for(let i=0;i<npx;i++){ if(kind==='noise'){rgb[i*3]=rnd()&255;rgb[i*3+1]=rnd()&255;rgb[i*3+2]=rnd()&255;}
    else if(kind==='flat'){rgb[i*3]=40;rgb[i*3+1]=90;rgb[i*3+2]=140;}
    else {const x=i%w,y=(i/w)|0;rgb[i*3]=(x*255/w)&255;rgb[i*3+1]=(y*255/h)&255;rgb[i*3+2]=((x+y)*127/w)&255;} }
  for(const q of [1,2]){ const a=encS(rgb,w,h,q,q), b=encV(rgb,w,h,q,q);
    let ok=a.length===b.length; if(ok)for(let i=0;i<a.length;i++){if(a[i]!==b[i]){ok=false;break;}}
    cases++; if(!ok){ident=false;console.log(`  BYTE-DIFF ${kind} ${w}x${h} q${q} (scalar ${a.length}B vs v128 ${b.length}B)`);} }
}
console.log(`byte-identical encode (scalar==v128): ${ident?'PASS':'FAIL'} — ${cases} cases`);
// speed on lightbox photo-like
const w=1800,h=1344,npx=w*h; let s=0x9e3779b1>>>0; const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s&255;};
const rgb=new Uint8Array(npx*3); for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*3;const n=rnd()>>3;rgb[i]=((x*255/w)+n)&255;rgb[i+1]=((y*255/h)+n)&255;rgb[i+2]=(((x+y)*127/w)+n)&255;}
const mps=ms=>npx/(ms/1e3)/1e6; const sMs=time(()=>encS(rgb,w,h,2,2)), vMs=time(()=>encV(rgb,w,h,2,2));
console.log(`encode ${w}x${h} ${(npx/1e6).toFixed(2)}MP:  scalar ${mps(sMs).toFixed(1)} → v128 ${mps(vMs).toFixed(1)} MP/s  = ${(sMs/vMs).toFixed(2)}×`);
