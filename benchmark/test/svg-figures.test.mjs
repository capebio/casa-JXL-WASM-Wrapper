import { test } from "node:test";
import assert from "node:assert/strict";
import { rdCurve, barChart, scatterPlot, slopeChart } from "../svg-figures.mjs";

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

test("scatterPlot emits one labelled dot per point, no connecting polyline", () => {
  const svg = scatterPlot({ points: [{ x: 5, y: 1, label: "jxl", color: "#f00" }, { x: 50, y: 2, label: "avif", color: "#00f" }], xLabel: "enc ms", yLabel: "bpp" });
  assert.equal((svg.match(/<circle/g) || []).length, 2);
  assert.equal((svg.match(/<polyline/g) || []).length, 0);
  assert.match(svg, />avif<\/text>/);
});

test("slopeChart draws a line per metric from baseline to value", () => {
  const svg = slopeChart({ metrics: [{ label: "size", value: 105, color: "#f00" }, { label: "enc", value: 48, color: "#00f" }], leftLabel: "orig", rightLabel: "ours" });
  assert.match(svg, />orig<\/text>/);
  assert.match(svg, />ours<\/text>/);
  assert.match(svg, /size: 105%/);
  assert.match(svg, /enc: 48%/);
});
