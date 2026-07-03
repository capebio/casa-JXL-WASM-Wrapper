#!/usr/bin/env node
// Guard: relaxed-SIMD tier artifacts must contain ZERO relaxed-SIMD opcodes.
//
// The relaxed-simd-mt tier compiles with -mrelaxed-simd + -DHWY_WANT_WASM2, which only
// *permits* relaxed opcodes (0xFD 0x100..0x114: relaxed_madd/nmadd, relaxed trunc/min/max,
// laneselect, ...). Highway's wasm target sets HWY_NATIVE_FMA=0 and MulAdd stays an unfused
// mul+add, so today's artifacts carry none — which is what keeps them byte-exact with the
// simd-mt tier's float results. A future emscripten/LLVM default change (ffp-contract,
// relaxed_madd pattern-lowering) could silently fuse and break the HARD byte-exactness gate.
// This script parses the wasm container, decodes code-section function bodies at the
// instruction level, and fails loudly on any relaxed-SIMD opcode.
//
// Fail-safe: if precise decoding desyncs (unknown opcode), that function body falls back to
// a linear 0xFD+LEB scan restricted to the code section. The fallback can false-positive on
// immediate bytes — acceptable: a false positive fails the build and a human looks.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RELAXED_MIN = 0x100;
const RELAXED_MAX = 0x114;
const MAX_REPORTED_OFFSETS = 8;

function lebU32(b, c) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = b[c.o++];
    if (byte === undefined) throw new Error("truncated LEB128");
    result += (byte & 0x7f) * 2 ** shift; // multiply: (x << 28) overflows 32-bit ops
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 35) throw new Error("LEB128 too long");
  }
}

// Skip a signed LEB (s32/s33/s64 immediates) — only the byte length matters here.
function skipLeb(b, c) {
  while (b[c.o] !== undefined && (b[c.o++] & 0x80));
}

function skipSimdImmediates(b, c, sub) {
  if (sub <= 0x0b || sub === 0x5c || sub === 0x5d) { lebU32(b, c); lebU32(b, c); } // memarg
  else if (sub === 0x0c || sub === 0x0d) c.o += 16; // v128.const / i8x16.shuffle
  else if (sub >= 0x15 && sub <= 0x22) c.o += 1; // extract/replace lane idx
  else if (sub >= 0x54 && sub <= 0x5b) { lebU32(b, c); lebU32(b, c); c.o += 1; } // load/store lane
  // all other assigned SIMD ops (incl. relaxed 0x100..0x114): no immediates
}

function decodeInsn(b, c, hits) {
  const at = c.o;
  const op = b[c.o++];
  if (op === undefined) throw new Error("truncated body");
  if (op === 0xfd) { // SIMD prefix
    const sub = lebU32(b, c);
    if (sub >= RELAXED_MIN && sub <= RELAXED_MAX) hits.push({ offset: at, sub });
    else if (sub > RELAXED_MAX) throw new Error(`unknown simd sub-opcode 0x${sub.toString(16)}`);
    skipSimdImmediates(b, c, sub);
  } else if (op === 0xfe) { // atomics prefix (MT tiers)
    const sub = lebU32(b, c);
    if (sub === 0x03) c.o += 1; // atomic.fence
    else if (sub <= 0x4e) { lebU32(b, c); lebU32(b, c); } // memarg
    else throw new Error(`unknown atomic sub-opcode 0x${sub.toString(16)}`);
  } else if (op === 0xfc) { // misc prefix
    const sub = lebU32(b, c);
    if (sub <= 7); // sat truncs: no immediates
    else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) { lebU32(b, c); lebU32(b, c); }
    else if (sub <= 17) lebU32(b, c);
    else throw new Error(`unknown misc sub-opcode 0x${sub.toString(16)}`);
  } else if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x19 ||
             op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xc4) || op === 0xd1) {
    // unreachable/nop/else/end/catch_all/return/drop/select/numeric/ref.is_null: no immediates
  } else if ((op >= 0x02 && op <= 0x04) || op === 0x06) skipLeb(b, c); // blocktype (s33)
  else if (op === 0x0c || op === 0x0d || (op >= 0x07 && op <= 0x09) || op === 0x10 ||
           op === 0x12 || op === 0x18 || (op >= 0x20 && op <= 0x26) ||
           op === 0x3f || op === 0x40 || op === 0xd2) lebU32(b, c); // single index
  else if (op === 0x11 || op === 0x13) { lebU32(b, c); lebU32(b, c); } // call_indirect
  else if (op === 0x0e) { let n = lebU32(b, c); while (n-- > 0) lebU32(b, c); lebU32(b, c); } // br_table
  else if (op >= 0x28 && op <= 0x3e) { lebU32(b, c); lebU32(b, c); } // memarg loads/stores
  else if (op === 0x41 || op === 0x42) skipLeb(b, c); // i32/i64.const
  else if (op === 0x43) c.o += 4; // f32.const
  else if (op === 0x44) c.o += 8; // f64.const
  else if (op === 0x1c) c.o += lebU32(b, c); // select_t: vec(valtype)
  else if (op === 0xd0) c.o += 1; // ref.null heaptype
  else throw new Error(`unknown opcode 0x${op.toString(16)} at ${at}`);
}

// Fallback: linear scan of one code body for 0xFD + LEB in the relaxed range.
function heuristicScan(b, start, end) {
  const hits = [];
  for (let i = start; i < end - 1; i++) {
    if (b[i] !== 0xfd) continue;
    try {
      const sub = lebU32(b, { o: i + 1 });
      if (sub >= RELAXED_MIN && sub <= RELAXED_MAX) hits.push({ offset: i, sub });
    } catch {}
  }
  return hits;
}

export function scanWasmForRelaxedSimd(bytes) {
  const b = bytes;
  if (b.length < 8 || b[0] !== 0x00 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) {
    throw new Error("not a wasm binary (bad magic)");
  }
  const c = { o: 8 };
  const hits = [];
  let codeBytes = 0;
  let functions = 0;
  let fallbackBodies = 0;
  while (c.o < b.length) {
    const id = b[c.o++];
    const size = lebU32(b, c);
    const end = c.o + size;
    if (end > b.length) throw new Error(`truncated section id ${id}`);
    if (id === 10) { // code section: scan ONLY here (data sections would false-positive)
      codeBytes += size;
      let count = lebU32(b, c);
      while (count-- > 0) {
        functions++;
        const bodySize = lebU32(b, c);
        const bodyEnd = c.o + bodySize;
        if (bodyEnd > end) throw new Error("truncated function body");
        const bodyStart = c.o;
        try {
          let locals = lebU32(b, c);
          while (locals-- > 0) { lebU32(b, c); c.o += 1; }
          while (c.o < bodyEnd) decodeInsn(b, c, hits);
          if (c.o !== bodyEnd) throw new Error("body length mismatch");
        } catch {
          fallbackBodies++;
          hits.push(...heuristicScan(b, bodyStart, bodyEnd));
        }
        c.o = bodyEnd;
      }
    }
    c.o = end;
  }
  return { hits, codeBytes, functions, fallbackBodies };
}

export function reportRelaxedSimdScan(path, result) {
  const { hits, codeBytes, functions, fallbackBodies } = result;
  const fallbackNote = fallbackBodies
    ? ` (${fallbackBodies} bodies via fallback linear scan — possible false positives, fails safe)`
    : "";
  if (!hits.length) {
    console.log(`[relaxed-simd-guard] ${path}: OK — 0 relaxed-SIMD opcodes in ${functions} functions / ${codeBytes} code bytes${fallbackNote}`);
    return true;
  }
  const shown = hits.slice(0, MAX_REPORTED_OFFSETS)
    .map((h) => `0x${h.offset.toString(16)} (sub 0x${h.sub.toString(16)})`)
    .join(", ");
  const message = `[relaxed-simd-guard] ${path}: ${hits.length} relaxed-SIMD opcode(s) found${fallbackNote}; first: ${shown}`;
  if (process.env.JXL_ALLOW_RELAXED_SIMD === "1") {
    console.warn(`${message}\n[relaxed-simd-guard] JXL_ALLOW_RELAXED_SIMD=1 set — downgraded to warning. Float results may differ from simd-mt; byte-exactness gate is NOT protected.`);
    return true;
  }
  console.error(`${message}\nRelaxed opcodes (e.g. fused madd) change float results and break the byte-exactness gate. Set JXL_ALLOW_RELAXED_SIMD=1 only to bypass deliberately.`);
  return false;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node assert-no-relaxed-simd.mjs <file.wasm> [...more]");
    process.exit(2);
  }
  let ok = true;
  for (const file of files) {
    ok = reportRelaxedSimdScan(file, scanWasmForRelaxedSimd(await readFile(file))) && ok;
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
