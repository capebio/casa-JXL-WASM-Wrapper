import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFiguresFull } from "../codec-paper-figures-full.mjs";

function sweep16Rows() {
  const rows = [];
  for (const codec of ["jxl", "avif16"]) for (const q of [40, 70, 95]) {
    rows.push({
      image: "P1.ORF", class: "raw", codec, runtime: codec === "jxl" ? "wasm" : "native",
      quality: q, bytes: 1000 * (100 - q), bpp: (100 - q) / 10,
      butteraugli16: (100 - q) / 40, psnr16: 20 + q / 3, ssim16: 0.8 + q / 500,
    });
  }
  return rows;
}

test("writeFiguresFull emits 16-bit RD figures from sweep16", () => {
  const dir = mkdtempSync(join(tmpdir(), "fig16-"));
  const { files } = writeFiguresFull({
    outDir: dir, sweep: [], timed: [], fixed: [], lossless: [],
    sweep16: sweep16Rows(), corpus: [{ id: "P1.ORF", class: "raw" }],
  });
  for (const f of ["rd-butteraugli-16bit.svg", "rd-psnr-16bit.svg", "rd-ssim-16bit.svg"]) {
    assert.ok(files.includes(f), `missing ${f}`);
    assert.ok(existsSync(join(dir, "figures", f)), `${f} not written`);
    assert.ok(readFileSync(join(dir, "figures", f), "utf8").includes("<svg"), `${f} not svg`);
  }
});

test("writeFiguresFull omits butteraugli-16 figure when metric absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "fig16b-"));
  const rows = sweep16Rows().map(r => { const { butteraugli16, ...rest } = r; return rest; });
  const { files } = writeFiguresFull({
    outDir: dir, sweep: [], timed: [], fixed: [], lossless: [],
    sweep16: rows, corpus: [],
  });
  assert.ok(!files.includes("rd-butteraugli-16bit.svg"), "butteraugli-16 should be omitted");
  assert.ok(files.includes("rd-psnr-16bit.svg"), "psnr-16 should still render");
});

test("writeFiguresFull emits the PNG-16 lossless floor bar from lossless16", () => {
  const dir = mkdtempSync(join(tmpdir(), "fig16c-"));
  const lossless16 = [
    { image: "P1.ORF", class: "raw", codec: "png16", runtime: "native", bytes: 400000, bpp: 6.2 },
    { image: "P2.CR2", class: "raw", codec: "png16", runtime: "native", bytes: 520000, bpp: 7.1 },
  ];
  const { files } = writeFiguresFull({
    outDir: dir, sweep: [], timed: [], fixed: [], lossless: [],
    sweep16: sweep16Rows(), lossless16, corpus: [],
  });
  assert.ok(files.includes("lossless-16bit-size.svg"), "missing lossless-16bit-size.svg");
  assert.ok(readFileSync(join(dir, "figures", "lossless-16bit-size.svg"), "utf8").includes("<svg"), "not svg");
  // absent when lossless16 empty
  const dir2 = mkdtempSync(join(tmpdir(), "fig16d-"));
  const { files: files2 } = writeFiguresFull({ outDir: dir2, sweep: [], timed: [], fixed: [], lossless: [], sweep16: sweep16Rows(), corpus: [] });
  assert.ok(!files2.includes("lossless-16bit-size.svg"), "lossless-16 bar should be absent when lossless16 empty");
});
