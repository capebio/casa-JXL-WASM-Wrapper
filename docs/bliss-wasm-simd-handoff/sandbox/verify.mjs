// Phase 1 verification: the v128 rANS decode kernel is bit-exact + native-interop holds.
//  A) lossless (q1) roundtrip bit-exact through v128 rANS — many image types & sizes
//     (noise / flat / gradient / sparse-rares; non-16-multiple widths; tiny/odd → tail+renorm edges)
//  B) stream magic == "BLSR"
//  C) native bliss.exe decode == WASM v128 decode (cross-substrate parity, near-lossless tier)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import init, { bliss_encode, bliss_decode } from './pkg/bliss_wasm_sandbox.js';

const BLISS_EXE = String.raw`C:\Foo\bliss\target\release\bliss.exe`;
const blissRgb = (u8) => u8.subarray(8);
const dimsOf = (u8) => [u8[0]|(u8[1]<<8)|(u8[2]<<16)|(u8[3]<<24), u8[4]|(u8[5]<<8)|(u8[6]<<16)|(u8[7]<<24)];

function gen(kind, w, h){ const rgb=new Uint8Array(w*h*3); let s=0x2545f491>>>0;
  const rnd=()=>{ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s; };
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*3;
    if (kind==='noise'){ rgb[i]=rnd()&255; rgb[i+1]=rnd()&255; rgb[i+2]=rnd()&255; }
    else if (kind==='flat'){ rgb[i]=40; rgb[i+1]=90; rgb[i+2]=140; }
    else if (kind==='gradient'){ rgb[i]=(x*255/w)&255; rgb[i+1]=(y*255/h)&255; rgb[i+2]=((x+y)*255/(w+h))&255; }
    else if (kind==='sparse'){ // mostly one value, rare outliers → freq==1 stress
      const rare=(rnd()%997===0); rgb[i]=rare?(rnd()&255):10; rgb[i+1]=rare?(rnd()&255):10; rgb[i+2]=rare?(rnd()&255):10; }
  }
  return rgb; }

async function main(){
  await init(readFileSync(new URL('./pkg/bliss_wasm_sandbox_bg.wasm', import.meta.url)));
  let pass = true, cases = 0;

  // A) lossless roundtrip bit-exact through v128, across types & sizes
  const sizes = [[512,384],[514,300],[100,64],[18,10],[2,2],[64,3],[256,257]]; // even widths; odd totals → tail
  const kinds = ['noise','flat','gradient','sparse'];
  for (const [w,h] of sizes) for (const kind of kinds){
    const rgb = gen(kind,w,h);
    const enc = bliss_encode(rgb,w,h,1,1); // lossless
    const dec = blissRgb(bliss_decode(enc));
    const [dw,dh] = dimsOf(bliss_decode(enc));
    let ok = dw===w && dh===h && dec.length===rgb.length;
    if (ok) for (let i=0;i<rgb.length;i++){ if (dec[i]!==rgb[i]){ ok=false; break; } }
    cases++; if(!ok){ pass=false; console.log(`  FAIL lossless ${kind} ${w}x${h}`); }
  }
  console.log(`A) lossless roundtrip bit-exact (v128 rANS): ${pass?'PASS':'FAIL'} — ${cases} cases (4 types × 7 sizes)`);

  // B) magic
  const enc0 = bliss_encode(gen('gradient',512,384),512,384,1,1);
  const magic = String.fromCharCode(enc0[0],enc0[1],enc0[2],enc0[3]);
  const magicOk = magic==='BLSR'; pass &&= magicOk;
  console.log(`B) stream magic: "${magic}" ${magicOk?'PASS':'FAIL'}`);

  // C) native == wasm on the near-lossless (q2) cache path
  const w=800,h=600, rgb=gen('gradient',w,h);
  const encQ2 = bliss_encode(rgb,w,h,2,2);
  const wasmDec = blissRgb(bliss_decode(encQ2));
  const blb=join(tmpdir(),'p1.bliss'), out=join(tmpdir(),'p1.ppm'); writeFileSync(blb, Buffer.from(encQ2));
  const p = spawnSync(BLISS_EXE,['dec',blb,out],{encoding:'utf8'});
  let crossOk = p.status===0;
  if (crossOk){ const ppm=readFileSync(out);
    const ws=b=>b===0x0a||b===0x20||b===0x09||b===0x0d; let i=2;
    for (let k=0;k<3;k++){ while(ws(ppm[i]))i++; while(ppm[i]>=0x30&&ppm[i]<=0x39)i++; } i++;
    const nat=ppm.subarray(i); crossOk = nat.length>=wasmDec.length;
    if (crossOk) for (let j=0;j<wasmDec.length;j++){ if (nat[j]!==wasmDec[j]){ crossOk=false; break; } }
  }
  pass &&= crossOk;
  console.log(`C) native decode == wasm v128 decode (q2): ${crossOk?'PASS':'FAIL'} (${(p.stderr||'').trim()})`);

  console.log(`\nPhase 1: ${pass?'ALL PASS — v128 rANS bit-exact':'FAILED'}`);
  process.exit(pass?0:1);
}
main().catch(e=>{console.error(e);process.exit(1)});
