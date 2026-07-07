// Dump all Olympus MakerNote IFD tags from an ORF file.
// Usage: bun dump-makernote.ts [path.ORF]

import { readFileSync } from "node:fs";

const ORF_PATH = process.argv[2] ?? String.raw`c:\Foo\raw-converter\tests\P1110226.ORF`;
const buf = readFileSync(ORF_PATH);
const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

if (data.byteLength < 8) throw new Error('File too short for TIFF header');

// TIFF helpers
const magic = data[0] === 0x49 && data[1] === 0x49;
const le = magic; // II = little-endian
function u16(off: number) { return le ? data[off] | (data[off+1]<<8) : (data[off]<<8)|data[off+1]; }
function u32(off: number) { return le ? data[off]|(data[off+1]<<8)|(data[off+2]<<16)|(data[off+3]<<24)>>>0 : (data[off]<<24)|(data[off+1]<<16)|(data[off+2]<<8)|data[off+3]; }
function i16(off: number) { const v = u16(off); return v >= 0x8000 ? v - 0x10000 : v; }

const ifd0_off = u32(4);
console.log(`Endian: ${le ? 'LE' : 'BE'}  IFD0 @ 0x${ifd0_off.toString(16)}`);

// Scan IFD0 for ExifIFD (0x8769), then MakerNote (0x927C) inside it
function scanIfd(ifd_start: number): { mn_off: number; mn_len: number } {
    const count = u16(ifd_start);
    for (let i = 0; i < count; i++) {
        const e = ifd_start + 2 + i * 12;
        const tag = u16(e);
        const val = u32(e + 8);
        if (tag === 0x927C) { return { mn_off: val, mn_len: u32(e+4) }; }
    }
    return { mn_off: -1, mn_len: 0 };
}

const ifd0_count = u16(ifd0_off);
let exif_ifd_off = -1;
for (let i = 0; i < ifd0_count; i++) {
    const e = ifd0_off + 2 + i * 12;
    const tag = u16(e);
    if (tag === 0x8769) { exif_ifd_off = u32(e+8); }
}
console.log(`ExifIFD @ 0x${exif_ifd_off < 0 ? '(none)' : exif_ifd_off.toString(16)}`);

// Search IFD0, then ExifIFD
let { mn_off, mn_len } = scanIfd(ifd0_off);
if (mn_off < 0 && exif_ifd_off >= 0) {
    ({ mn_off, mn_len } = scanIfd(exif_ifd_off));
}
if (mn_off < 0) { console.log('No MakerNote found'); process.exit(1); }
console.log(`MakerNote @ 0x${mn_off.toString(16)}, len ${mn_len}\n`);

// Detect header variant
const head12 = String.fromCharCode(...data.slice(mn_off, mn_off+16));
console.log(`MN header: ${JSON.stringify(head12.replace(/\0/g, '·'))}`);

let sub_off: number, base_off: number;
if (head12.startsWith('OLYMPUS\0')) {
    sub_off = mn_off + 12; base_off = mn_off;
} else if (head12.startsWith('OLYMP\0')) {
    sub_off = mn_off + 8; base_off = 0;
} else if (head12.startsWith('OM SYSTEM\0')) {
    sub_off = mn_off + 16; base_off = mn_off;
} else {
    sub_off = mn_off; base_off = 0;
}
console.log(`sub_off=0x${sub_off.toString(16)}  base_off=0x${base_off.toString(16)}\n`);

function abs(v: number) { return base_off + v; }

const count = u16(sub_off);
console.log(`MakerNote IFD: ${count} entries\n`);
console.log('Tag      Type  Count       Val/Ptr     Abs-ptr');
console.log('------   ----  ----------  ----------  ----------');

const DTYPE: Record<number,string> = {1:'BYTE',2:'ASCII',3:'SHORT',4:'LONG',5:'RATIO',6:'SBYTE',7:'UNDEF',8:'SSHORT',9:'SLONG',10:'SRATIO',11:'FLOAT',12:'DOUBLE'};

for (let i = 0; i < count; i++) {
    const e = sub_off + 2 + i * 12;
    if (e + 12 > data.length) break;
    const tag  = u16(e);
    const dtype= u16(e+2);
    const cnt  = u32(e+4);
    const val  = u32(e+8);
    const ap   = abs(val);
    const dt   = DTYPE[dtype] ?? `?${dtype}`;
    const tagHex = '0x'+tag.toString(16).padStart(4,'0');
    const line = `${tagHex}   ${dt.padEnd(6)}  ${String(cnt).padEnd(10)}  0x${val.toString(16).padStart(8,'0')}  0x${ap.toString(16).padStart(8,'0')}`;

    // Extra: for tag 0x1011 (ColorMatrix) dump the values
    if (tag === 0x1011 && dtype === 8 /* SSHORT */ && cnt === 9) {
        const m: number[][] = [];
        let p = ap;
        for (let r = 0; r < 3; r++) {
            const row: number[] = [];
            for (let c = 0; c < 3; c++) { row.push(i16(p)); p += 2; }
            m.push(row);
        }
        console.log(line + `  ← ColorMatrix`);
        for (const row of m) {
            const fr = row.map(v => (v/256).toFixed(4).padStart(8));
            console.log(`               raw=[${row.join(',')}]  /256=[${fr.join(', ')}]`);
        }
        continue;
    }
    // For tag 0x1011 with unexpected format
    if (tag === 0x1011) {
        console.log(line + `  ← ColorMatrix (dtype=${dtype} cnt=${cnt} — UNEXPECTED)`);
        continue;
    }
    // For tag 0x2040 (ImageProcessing sub-IFD)
    if (tag === 0x2040) {
        console.log(line + `  ← ImageProcessing sub-IFD`);
        continue;
    }
    // WB tags
    if (tag === 0x1017 || tag === 0x1018 || tag === 0x1029) {
        const name = tag===0x1017?'RedBalance':tag===0x1018?'BlueBalance':'WB_RBLevels';
        // inline shorts
        const v0 = le ? (val & 0xFFFF) : (val >>> 16);
        const v1 = le ? (val >>> 16) : (val & 0xFFFF);
        console.log(line + `  ← ${name}  inline=[${v0},${v1}]  /256=[${(v0/256).toFixed(3)},${(v1/256).toFixed(3)}]`);
        continue;
    }
    console.log(line);
}

// Dump ImageProcessing sub-IFD if present
const ip_mn_val = (() => {
    for (let i = 0; i < count; i++) {
        const e = sub_off + 2 + i * 12;
        if (u16(e) === 0x2040) return { mn_rel: u32(e+8), cnt: u32(e+4) };
    }
    return null;
})();

// FILE-SPECIFIC DEBUG: Direct read of ColorMatrix at a hardcoded absolute offset.
// 0x280a is where tag 0x0200 data lives in P1110226.ORF only — do NOT use for
// other files.  The IFD-parsed version in the ImageProcessing sub-IFD block
// below is the authoritative path.  Uncomment only for per-file offset probing.
//
// const SPECIFIC_FILE_OFFSET = 0x280a; // P1110226.ORF only
// {
//     const cmOff = SPECIFIC_FILE_OFFSET;
//     if (cmOff + 18 > data.length) throw new Error('Hardcoded offset out of bounds');
//     const vals: number[] = [];
//     for (let k = 0; k < 9; k++) vals.push(i16(cmOff + k * 2));
//     console.log(`\nColorMatrix (direct read @ 0x${cmOff.toString(16)}):`);
//     for (let r = 0; r < 3; r++) {
//         const row = vals.slice(r*3, r*3+3);
//         const frow = row.map(v => (v/256).toFixed(4).padStart(8));
//         console.log(`  raw=[${row.join(', ')}]  /256=[${frow.join(', ')}]`);
//     }
//     const rowSums = [0,1,2].map(r => vals.slice(r*3,r*3+3).reduce((a,v)=>a+v/256,0));
//     console.log(`  row sums: [${rowSums.map(s=>s.toFixed(3)).join(', ')}]  (should be ~1.0 each)`);
// }

if (ip_mn_val) {
    const ip_off = abs(ip_mn_val.mn_rel);
    console.log(`\n── ImageProcessing sub-IFD @ abs 0x${ip_off.toString(16)} (mn-rel 0x${ip_mn_val.mn_rel.toString(16)})`);
    const ip_count = u16(ip_off);
    console.log(`   ${ip_count} entries`);
    console.log('   Tag      Type  Count       Val/Ptr     AbsPtr');
    for (let i = 0; i < ip_count; i++) {
        const e = ip_off + 2 + i * 12;
        if (e + 12 > data.length) break;
        const tag = u16(e), dtype = u16(e+2), cnt = u32(e+4), val = u32(e+8);
        const ap = base_off + val; // IP sub-IFD vals also MN-relative
        const dt = DTYPE[dtype] ?? `?${dtype}`;
        const tagHex = '0x'+tag.toString(16).padStart(4,'0');
        let extra = '';
        if (tag === 0x0200 && cnt === 9) { // ColorMatrix in IP sub-IFD
        const p = ap; // ap = base_off + val, already computed above
        const vals: number[] = [];
        for (let k = 0; k < 9; k++) vals.push(i16(p + k*2));
        console.log(`   0x0200   SHORT  9  ← ColorMatrix`);
        for (let r = 0; r < 3; r++) {
            const row = vals.slice(r*3, r*3+3);
            const frow = row.map(v => (v/256).toFixed(4).padStart(8));
            console.log(`      raw=[${row.join(',')}]  /256=[${frow.join(', ')}]`);
        }
        continue;
    }
    if (tag === 0x0100) { // WB_RGBGLevels
            if (dtype === 3 && cnt >= 4) {
                const p = ap;
                const r = u16(p), g1 = u16(p+2), b = u16(p+4), g2 = u16(p+6);
                extra = `  ← WB_RGBGLevels R=${r}(${(r/256).toFixed(3)}) G=${g1}(${(g1/256).toFixed(3)}) B=${b}(${(b/256).toFixed(3)}) G2=${g2}`;
            }
        }
        console.log(`   ${tagHex}   ${dt.padEnd(6)}  ${String(cnt).padEnd(10)}  0x${val.toString(16).padStart(8,'0')}  0x${ap.toString(16).padStart(8,'0')}${extra}`);
    }
}
