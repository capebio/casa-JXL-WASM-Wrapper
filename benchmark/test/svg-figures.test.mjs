import { test } from "node:test";
import assert from "node:assert/strict";
import { rdCurve, barChart } from "../svg-figures.mjs";

test("rdCurve emits an svg with one polyline per series + axis labels", () => {
  const svg = rdCurve({
    series: [
      { label: "jxl", color: "#f00", points: [{ x: 1, y: 4 }, { x: 4, y: 1 }] },
      { label: "jpeg", color: "#00f", points: [{ x: 2, y: 4 }, { x: 8, y: 1 }] },
    ],
    xLabel: "bpp", yLabel: "butteraugli", width: 800, height: 500,
  });
  assert.match(svg, /^<svg[^>]*viewBox="0 0 800 500"/);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, />bpp<\/text>/);
  assert.match(svg, />butteraugli<\/text>/);
  assert.match(svg, />jxl<\/text>/); // legend
});

test("barChart emits one rect per bar and labels", () => {
  const svg = barChart({ bars: [{ label: "jxl", value: 10, color: "#f00" }, { label: "jpeg", value: 20, color: "#00f" }], yLabel: "bytes", width: 600, height: 400 });
  assert.equal((svg.match(/<rect/g) || []).length >= 2, true);
  assert.match(svg, />jxl<\/text>/);
});
