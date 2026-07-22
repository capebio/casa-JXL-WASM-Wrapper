// Real-content native band-parallel decode scaling (proves what WASM threads inherit per-band).
// Decode a full-res Gobabeb ORF → RGB → PPM → native `bliss enc` (many bands) → RAYON_NUM_THREADS sweep.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initAll, decodeOrfRgba, listOrf } from '../raw-converter-wasm/benchmark/_bench-util.mjs';

const SRC = String.raw`c:\Foo\raw-converter\tests\Gobabeb 10`;
const EXE = String.raw`C:\Foo\bliss\target\release\bliss.exe`;
const median = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };

async function main(){
  await initAll();
  const name = listOrf(SRC,1)[0];
  const img = decodeOrfRgba(`${SRC}\\${name}`, 4000); // large → many bands
  const { w, h } = img, npx = w*h;
  const rgb = Buffer.alloc(npx*3); const u = img.rgba;
  for (let i=0;i<npx;i++){ rgb[i*3]=u[i*4]; rgb[i*3+1]=u[i*4+1]; rgb[i*3+2]=u[i*4+2]; }
  const ppm=join(tmpdir(),'real.ppm'), blb=join(tmpdir(),'real.bliss'), out=join(tmpdir(),'real_o.ppm');
  writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]));
  const e = spawnSync(EXE,['enc',ppm,blb],{encoding:'utf8'});
  const bands = Math.max(1, Math.min(64, Math.floor(h/256)));
  console.log(`${name} → ${w}x${h} (${(npx/1e6).toFixed(1)} MP), ~${bands} bands. enc: ${(e.stderr||'').trim()}`);
  const re=/decoded in [\d.]+ ms \(([\d.]+) MPx\/s\)/;
  console.log('threads   MP/s    scaling   (native AVX2 band-parallel decode)');
  let base=0;
  for (const nt of [1,2,4,8]){ const v=[];
    for (let r=0;r<5;r++){ const p=spawnSync(EXE,['dec',blb,out],{encoding:'utf8',env:{...process.env,RAYON_NUM_THREADS:String(nt)}}); const m=(p.stderr||'').match(re); if(m)v.push(+m[1]); }
    const mp=median(v); if(nt===1)base=mp;
    console.log(`${String(nt).padStart(4)}    ${mp.toFixed(1).padStart(7)}    ${(mp/base).toFixed(2)}×`);
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
