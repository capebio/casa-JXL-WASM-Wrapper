// exif-serialize.js — minimal EXIF (TIFF-in-APP1) writer + reader for the
// export metadata privacy policy (finding 44).
//
// The RAW worker emits a JS `exif` OBJECT (make/model/gps/iso/...), but the JXL
// encoder (`encodeJxlSession` / facade `createEncoder`) wants EXIF as a
// `Uint8Array` of TIFF bytes.  This module bridges the two: it serialises the
// policy-filtered exif object into a standards-shaped little-endian TIFF/EXIF
// block, and can parse it back (for tests + for a byte-level GPS-absence proof).
//
// Scope: we write only the tags the app actually surfaces + a GPS IFD.  This is
// NOT a full EXIF encoder — a metadata-PRESERVING re-encoder (that carries the
// camera's original maker-notes byte-for-byte) is packet-3 work.  What we
// guarantee here is the property the privacy policy needs: under `strip-gps` /
// `strip-all` the serialised bytes contain NO GPS IFD and NO GPS pointer.
//
// Browser-safe: no Node built-ins.  Big/valueless fields are omitted rather than
// written empty, so the output is deterministic and round-trippable.

'use strict';

// --- EXIF TIFF tag ids (subset we surface) --------------------------------
const T = {
    Make:            0x010F, // IFD0 ASCII
    Model:           0x0110, // IFD0 ASCII
    Orientation:     0x0112, // IFD0 SHORT
    DateTime:        0x0132, // IFD0 ASCII
    ExifIFDPointer:  0x8769, // IFD0 LONG → offset of Exif sub-IFD
    GPSIFDPointer:   0x8825, // IFD0 LONG → offset of GPS sub-IFD
    // Exif sub-IFD
    ExposureTime:    0x829A, // RATIONAL
    FNumber:         0x829D, // RATIONAL
    ISOSpeedRatings: 0x8827, // SHORT
    DateTimeOriginal:0x9003, // ASCII
    FocalLength:     0x920A, // RATIONAL
    LensModel:       0xA434, // ASCII
    FocalLengthIn35mmFilm: 0xA405, // SHORT
    // GPS sub-IFD
    GPSLatitudeRef:  0x0001, // ASCII 'N'/'S'
    GPSLatitude:     0x0002, // RATIONAL[3] deg/min/sec
    GPSLongitudeRef: 0x0003, // ASCII 'E'/'W'
    GPSLongitude:    0x0004, // RATIONAL[3]
    GPSAltitudeRef:  0x0005, // BYTE 0=above sea level
    GPSAltitude:     0x0006, // RATIONAL
};

// TIFF field types
const TY = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
const TY_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

// ---------------------------------------------------------------------------
// Small growable little-endian byte writer.
// ---------------------------------------------------------------------------
class ByteWriter {
    constructor() { this.bytes = []; }
    get length() { return this.bytes.length; }
    u8(v)  { this.bytes.push(v & 0xFF); }
    u16(v) { this.u8(v); this.u8(v >>> 8); }
    u32(v) { this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24); }
    ascii(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xFF); this.u8(0); }
    raw(arr) { for (const b of arr) this.u8(b & 0xFF); }
    toU8() { return Uint8Array.from(this.bytes); }
}

// Convert a value into a list of "entries" (one IFD entry) + optional overflow
// bytes appended in the data area.  We keep this small: we only need ASCII,
// SHORT, LONG and RATIONAL, plus RATIONAL[3] for GPS coordinates.

function asciiEntry(tag, str) {
    // ASCII includes the trailing NUL.
    const data = [];
    for (let i = 0; i < str.length; i++) data.push(str.charCodeAt(i) & 0xFF);
    data.push(0);
    return { tag, type: TY.ASCII, count: data.length, data };
}
function shortEntry(tag, v) {
    return { tag, type: TY.SHORT, count: 1, inlineShort: v & 0xFFFF };
}
function longEntry(tag, v) {
    return { tag, type: TY.LONG, count: 1, inlineLong: v >>> 0 };
}
function rationalEntry(tag, num, den) {
    const data = [];
    pushU32(data, num >>> 0); pushU32(data, den >>> 0);
    return { tag, type: TY.RATIONAL, count: 1, data };
}
function rational3Entry(tag, triples) {
    // triples: [[n,d],[n,d],[n,d]]
    const data = [];
    for (const [n, d] of triples) { pushU32(data, n >>> 0); pushU32(data, d >>> 0); }
    return { tag, type: TY.RATIONAL, count: 3, data };
}
function byteEntry(tag, v) {
    return { tag, type: TY.BYTE, count: 1, inlineByte: v & 0xFF };
}
function pushU32(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }

// Serialise one IFD (list of entries) at absolute offset `ifdOffset` within the
// TIFF, given a running data-area offset.  Returns { ifdBytes, dataBytes,
// nextDataOffset }.  Values that don't fit in 4 bytes go to the data area and
// the entry stores their offset.
function serializeIfd(entries, ifdOffset, dataOffset, patchNext = 0) {
    // IFD layout: u16 count, then count*12-byte entries, then u32 nextIFD.
    const ifdSize = 2 + entries.length * 12 + 4;
    let curData = dataOffset;
    const dataW = new ByteWriter();

    const ifd = new ByteWriter();
    ifd.u16(entries.length);
    for (const e of entries) {
        ifd.u16(e.tag);
        ifd.u16(e.type);
        ifd.u32(e.count);
        const byteLen = TY_SIZE[e.type] * e.count;
        if (e.inlineShort !== undefined) {
            ifd.u16(e.inlineShort); ifd.u16(0);
        } else if (e.inlineLong !== undefined) {
            ifd.u32(e.inlineLong);
        } else if (e.inlineByte !== undefined) {
            ifd.u8(e.inlineByte); ifd.u8(0); ifd.u16(0);
        } else if (byteLen <= 4) {
            // Inline data (ASCII short strings, etc.), pad to 4 bytes.
            for (let i = 0; i < 4; i++) ifd.u8(i < e.data.length ? e.data[i] : 0);
        } else {
            // Overflow → data area.
            ifd.u32(curData);
            for (const b of e.data) dataW.u8(b);
            curData += e.data.length;
            if (curData & 1) { dataW.u8(0); curData++; } // word-align
        }
    }
    ifd.u32(patchNext); // next IFD offset (0 = none)
    return { ifdBytes: ifd.toU8(), dataBytes: dataW.toU8(), ifdSize, nextDataOffset: curData };
}

// ---------------------------------------------------------------------------
// serializeExif — JS exif object → little-endian TIFF/EXIF Uint8Array.
//
// Returns null when there is nothing worth writing (so the encoder omits the
// EXIF box entirely rather than embedding an empty header).
// ---------------------------------------------------------------------------
/**
 * @param {object|null} exif  policy-FILTERED exif (from applyMetadataPolicy)
 * @returns {Uint8Array|null}
 */
export function serializeExif(exif) {
    if (!exif) return null;

    // --- collect entries per IFD ---
    const ifd0 = [];
    const exifSub = [];
    const gps = [];

    const str = (v) => (typeof v === 'string' && v.length ? v : null);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const rat = (v) => (v && num(v.n) != null && num(v.d) != null && v.d !== 0 ? v : null);

    if (str(exif.make))     ifd0.push(asciiEntry(T.Make, exif.make));
    if (str(exif.model))    ifd0.push(asciiEntry(T.Model, exif.model));
    if (num(exif.orientation)) ifd0.push(shortEntry(T.Orientation, exif.orientation));
    if (str(exif.datetime)) ifd0.push(asciiEntry(T.DateTime, exif.datetime));

    if (rat(exif.exposure))     exifSub.push(rationalEntry(T.ExposureTime, exif.exposure.n, exif.exposure.d));
    if (rat(exif.fnumber))      exifSub.push(rationalEntry(T.FNumber, exif.fnumber.n, exif.fnumber.d));
    if (num(exif.iso))          exifSub.push(shortEntry(T.ISOSpeedRatings, exif.iso));
    if (str(exif.datetime))     exifSub.push(asciiEntry(T.DateTimeOriginal, exif.datetime));
    if (rat(exif.focalLength))  exifSub.push(rationalEntry(T.FocalLength, exif.focalLength.n, exif.focalLength.d));
    if (str(exif.lens))         exifSub.push(asciiEntry(T.LensModel, exif.lens));
    if (num(exif.focalLength35)) exifSub.push(shortEntry(T.FocalLengthIn35mmFilm, exif.focalLength35));

    // GPS: ONLY when policy kept it. `applyMetadataPolicy` sets gps=null for
    // strip-gps / strip-all, so this branch never runs under those policies —
    // guaranteeing no GPS IFD and no GPS pointer in the output.
    if (exif.gps && num(exif.gps.lat) != null && num(exif.gps.lon) != null) {
        const { lat, lon } = exif.gps;
        gps.push(asciiEntry(T.GPSLatitudeRef, lat >= 0 ? 'N' : 'S'));
        gps.push(rational3Entry(T.GPSLatitude, dmsTriples(Math.abs(lat))));
        gps.push(asciiEntry(T.GPSLongitudeRef, lon >= 0 ? 'E' : 'W'));
        gps.push(rational3Entry(T.GPSLongitude, dmsTriples(Math.abs(lon))));
        if (num(exif.gps.alt) != null) {
            gps.push(byteEntry(T.GPSAltitudeRef, exif.gps.alt >= 0 ? 0 : 1));
            gps.push(rationalEntry(T.GPSAltitude, Math.round(Math.abs(exif.gps.alt) * 100), 100));
        }
    }

    // Sort entries by tag id (TIFF requires ascending tag order per IFD).
    ifd0.sort((a, b) => a.tag - b.tag);
    exifSub.sort((a, b) => a.tag - b.tag);
    gps.sort((a, b) => a.tag - b.tag);

    if (ifd0.length === 0 && exifSub.length === 0 && gps.length === 0) return null;

    // --- lay out the TIFF ---
    // header(8) | IFD0 | Exif-IFD | GPS-IFD | data-area
    // Pointers to sub-IFDs are added to IFD0 before size computation.
    const hasExif = exifSub.length > 0;
    const hasGps  = gps.length > 0;
    if (hasExif) ifd0.push(longEntry(T.ExifIFDPointer, 0)); // placeholder, patched below
    if (hasGps)  ifd0.push(longEntry(T.GPSIFDPointer, 0));
    ifd0.sort((a, b) => a.tag - b.tag);

    const ifd0Size  = 2 + ifd0.length * 12 + 4;
    const exifSize  = hasExif ? 2 + exifSub.length * 12 + 4 : 0;
    const gpsSize   = hasGps  ? 2 + gps.length * 12 + 4 : 0;

    const ifd0Offset = 8;
    const exifOffset = ifd0Offset + ifd0Size;
    const gpsOffset  = exifOffset + exifSize;
    const dataStart  = gpsOffset + gpsSize;

    // Patch sub-IFD pointer values now that offsets are known.
    for (const e of ifd0) {
        if (e.tag === T.ExifIFDPointer) e.inlineLong = exifOffset;
        if (e.tag === T.GPSIFDPointer)  e.inlineLong = gpsOffset;
    }

    // Serialise each IFD; data areas accumulate after dataStart.
    let dataCursor = dataStart;
    const s0 = serializeIfd(ifd0, ifd0Offset, dataCursor);
    dataCursor = s0.nextDataOffset;
    const sE = hasExif ? serializeIfd(exifSub, exifOffset, dataCursor) : null;
    if (sE) dataCursor = sE.nextDataOffset;
    const sG = hasGps ? serializeIfd(gps, gpsOffset, dataCursor) : null;

    // --- assemble ---
    const out = new ByteWriter();
    out.u8(0x49); out.u8(0x49);          // 'II' little-endian
    out.u16(0x002A);                     // TIFF magic
    out.u32(ifd0Offset);                 // offset of IFD0
    out.raw(s0.ifdBytes);
    if (sE) out.raw(sE.ifdBytes);
    if (sG) out.raw(sG.ifdBytes);
    out.raw(s0.dataBytes);
    if (sE) out.raw(sE.dataBytes);
    if (sG) out.raw(sG.dataBytes);
    return out.toU8();
}

// Decimal degrees → [[deg,1],[min,1],[sec×100,100]] RATIONAL triples.
function dmsTriples(dd) {
    const deg = Math.floor(dd);
    const minF = (dd - deg) * 60;
    const min = Math.floor(minF);
    const sec = (minF - min) * 60;
    return [[deg, 1], [min, 1], [Math.round(sec * 100), 100]];
}

// ---------------------------------------------------------------------------
// parseExif — minimal reader (for tests + byte-level GPS-absence assertions).
// Returns { hasGps, tags: Map<tagId, value>, gpsPointerPresent }.
// ---------------------------------------------------------------------------
/**
 * @param {Uint8Array} bytes
 * @returns {{ hasGps: boolean, gpsPointerPresent: boolean, ifd0Tags: number[], make: string|null, model: string|null }}
 */
export function parseExif(bytes) {
    if (!bytes || bytes.length < 8) return { hasGps: false, gpsPointerPresent: false, ifd0Tags: [], make: null, model: null };
    const le = bytes[0] === 0x49 && bytes[1] === 0x49;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o, le);
    const u32 = (o) => dv.getUint32(o, le);

    const ifd0Off = u32(4);
    const readIfd = (off) => {
        const n = u16(off);
        const entries = [];
        let p = off + 2;
        for (let i = 0; i < n; i++, p += 12) {
            entries.push({ tag: u16(p), type: u16(p + 2), count: u32(p + 4), valOff: p + 8 });
        }
        return { entries, nextOff: p };
    };

    const readAscii = (e) => {
        const byteLen = e.count;
        // All offsets here (valOff, and the pointer stored at valOff) are
        // TIFF-relative (measured from bytes[0]).  `bytes[i]` and `dv` are both
        // TIFF-relative too, so index `bytes` with the TIFF-relative offset.
        const base = byteLen <= 4 ? e.valOff : u32(e.valOff);
        let s = '';
        for (let i = 0; i < byteLen; i++) {
            const c = bytes[base + i];
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    };

    const { entries } = readIfd(ifd0Off);
    const ifd0Tags = entries.map(e => e.tag);
    let gpsPointerPresent = false;
    let make = null, model = null;
    for (const e of entries) {
        if (e.tag === T.GPSIFDPointer) gpsPointerPresent = true;
        if (e.tag === T.Make)  make  = readAscii(e);
        if (e.tag === T.Model) model = readAscii(e);
    }
    // hasGps = a GPS IFD pointer exists AND points to a non-empty IFD.
    let hasGps = false;
    if (gpsPointerPresent) {
        const gpsEntry = entries.find(e => e.tag === T.GPSIFDPointer);
        const gpsOff = u32(gpsEntry.valOff);
        if (gpsOff > 0 && gpsOff + 2 <= bytes.length) {
            hasGps = u16(gpsOff) > 0;
        }
    }
    return { hasGps, gpsPointerPresent, ifd0Tags, make, model };
}
