#!/usr/bin/env node
// ORF dissector: dump TIFF IFD0/IFD1 tags, compression, and scan for embedded JPEGs.
// Usage: node tools/orf_dissect.mjs <file.orf> [more.orf ...]
import { readFileSync } from 'node:fs';

const TIFF_TYPE_SIZE = { 1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8 };
const TAGN = {
  256:'ImageWidth',257:'ImageLength',258:'BitsPerSample',259:'Compression',
  262:'PhotometricInterp',273:'StripOffsets',277:'SamplesPerPixel',278:'RowsPerStrip',
  279:'StripByteCounts',513:'JPEGInterchangeFormat(preview off)',514:'JPEGInterchangeFormatLength(preview len)',
  272:'Model',271:'Make',274:'Orientation',330:'SubIFDs',700:'XMP',
  0x014a:'SubIFD',0x0111:'StripOffsets',0x0117:'StripByteCounts',
  0x8769:'ExifIFD',0x927c:'MakerNote',0x8825:'GPSIFD',
};

function dumpIFD(buf, off, le, label, out) {
  const u16 = (o)=> le?buf.readUInt16LE(o):buf.readUInt16BE(o);
  const u32 = (o)=> le?buf.readUInt32LE(o):buf.readUInt32BE(o);
  if (off <= 0 || off + 2 > buf.length) return 0;
  const n = u16(off);
  const rows = [];
  for (let i=0;i<n;i++){
    const e = off+2+i*12;
    if (e+12>buf.length) break;
    const tag=u16(e), typ=u16(e+2), cnt=u32(e+4);
    const tsz=(TIFF_TYPE_SIZE[typ]||1)*cnt;
    let valOff = e+8;
    let inlineOff = (tsz<=4)? valOff : u32(valOff);
    let val;
    if (typ===3 && cnt<=2 && tsz<=4) val=u16(valOff);
    else if (typ===4 && cnt===1) val=u32(valOff);
    else if (typ===3 && cnt===1) val=u16(valOff);
    else val=`@${inlineOff} (${cnt}×t${typ})`;
    rows.push(`    ${TAGN[tag]||('0x'+tag.toString(16))} (t${typ} n${cnt}) = ${val}`);
  }
  const next = u32(off+2+n*12);
  out.push(`  ${label} @${off}: ${n} entries`);
  out.push(...rows);
  return next;
}

// Strict JPEG walk from a candidate SOI: validate every segment length, require an
// SOF with sane dims, and a terminating EOI. Returns {w,h,len} or null.
function parseJpegAt(buf, i){
  if (!(buf[i]===0xFF && buf[i+1]===0xD8 && buf[i+2]===0xFF)) return null;
  let j=i+2, w=0,h=0;
  while (j+2<=buf.length){
    if (buf[j]!==0xFF) return null;          // must land on a marker
    let m=buf[j+1];
    while (m===0xFF){ j++; m=buf[j+1]; }      // skip fill bytes
    if (m===0xD9) return (w&&h)?{off:i,w,h,len:(j+2)-i}:null; // EOI
    if (m>=0xD0 && m<=0xD7){ j+=2; continue; } // RSTn (no length)
    if (m===0x01){ j+=2; continue; }           // TEM
    if (j+4>buf.length) return null;
    const seglen=buf.readUInt16BE(j+2);
    if (seglen<2) return null;
    if ((m>=0xC0 && m<=0xCF) && m!==0xC4 && m!==0xC8 && m!==0xCC){ // SOF0..15 (frame headers)
      if (j+9>buf.length) return null;
      h=buf.readUInt16BE(j+5); w=buf.readUInt16BE(j+7);
      if (w<16||h<16||w>12000||h>12000) return null;
    }
    if (m===0xDA){ // SOS: entropy data follows; scan to next marker that isn't RSTn/FF00
      j+=2+seglen;
      while (j+1<buf.length){
        if (buf[j]===0xFF && buf[j+1]!==0x00 && !(buf[j+1]>=0xD0&&buf[j+1]<=0xD7)){ break; }
        j++;
      }
      continue;
    }
    j+=2+seglen;
  }
  return null;
}
function scanJpegs(buf, limit){
  const end = Math.min(limit||buf.length, buf.length);
  const found=[];
  for (let i=0;i+3<end;i++){
    if (buf[i]===0xFF && buf[i+1]===0xD8 && buf[i+2]===0xFF){
      const jp=parseJpegAt(buf,i);
      if (jp){ found.push(jp); i=jp.off+jp.len-1; }
    }
  }
  return found;
}

for (const path of process.argv.slice(2)){
  const buf=readFileSync(path);
  const out=[];
  out.push(`\n=== ${path}  (${(buf.length/1e6).toFixed(1)} MB) ===`);
  const m0=buf[0],m1=buf[1];
  const le = (m0===0x49); // 'I'
  const magic = buf.toString('latin1',0,4);
  out.push(`  magic="${magic}" endian=${le?'LE':'BE'}`);
  const u32=(o)=> le?buf.readUInt32LE(o):buf.readUInt32BE(o);
  let ifd=u32(4);
  let idx=0;
  while(ifd>0 && idx<6){ ifd=dumpIFD(buf,ifd,le,`IFD${idx}`,out); idx++; }
  const jpegs=scanJpegs(buf, 3_000_000).sort((a,b)=>b.w*b.h-a.w*a.h);
  out.push(`  embedded JPEGs (${jpegs.length}), largest first:`);
  for(const jp of jpegs.slice(0,6)) out.push(`    ${jp.w}×${jp.h}  off=${jp.off} len=${jp.len>0?(jp.len/1e3).toFixed(0)+'KB':'?'}`);
  console.log(out.join('\n'));
}
