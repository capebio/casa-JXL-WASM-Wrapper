import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJxtcContainer } from "@casabio/jxl-pyramid";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { ingestImage } from "../src/ingest";
import { createJxlBackend, type DecodedMaster, type RawBackend, type RawFormat } from "../src/backends";
import { imageIdForPath } from "../src/hash";
import type { Manifest } from "../src/manifest";
import { parseManifest } from "../src/schema";
import { loadScalarModule, scalarFactory } from "./scalar";

async function writeMaster(dir: string, name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, new Uint8Array([0, 1, 2, 3]));
  return p;
}

afterEach(() => setJxlModuleFactoryForTesting(null));

const WASM_TIMEOUT = 180_000;

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = (x * 31 + y * 17) & 0xff;
      px[o + 1] = (x * 7 + y * 53) & 0xff;
      px[o + 2] = (x * 13 + y * 29) & 0xff;
      px[o + 3] = 255;
    }
  }
  return px;
}

function fakeRaw(w: number, h: number): RawBackend {
  return {
    async decode(_bytes: Uint8Array, _format: RawFormat): Promise<DecodedMaster> {
      return { rgba: gradientRgba(w, h), width: w, height: h, orientation: "baked" };
    },
  };
}

async function tmpOut(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyramid-ingest-tile-"));
}

test("massive RAW ingest tiles only the full level; sidecars stay whole-frame", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const backends = { raw: fakeRaw(8001, 400), jxl: createJxlBackend() };
  const master = await writeMaster(out, "scan.orf");

  expect((await ingestImage(master, backends, { outDir: out })).outcome).toBe("written");

  const imageId = await imageIdForPath(master);
  const manifest = parseManifest(
    await readFile(join(out, "images", imageId, "manifest.json")),
  ) as Manifest;

  const full = manifest.levels.find((l) => l.size === "full");
  expect(full).toBeDefined();
  expect(full!.tiled).toBe(true);
  for (const l of manifest.levels) {
    if (l.size !== "full") expect(l.tiled).toBe(false);
  }

  const fullBytes = new Uint8Array(await readFile(join(out, "levels", `${full!.contenthash}.jxl`)));
  expect(isJxtcContainer(fullBytes)).toBe(true);
  expect((await stat(join(out, "levels", `${full!.contenthash}.jxl`))).size).toBe(full!.bytes);
});

test("standard RAW ingest keeps whole-frame full level", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const backends = { raw: fakeRaw(1280, 960), jxl: createJxlBackend() };
  const master = await writeMaster(out, "photo.orf");

  expect((await ingestImage(master, backends, { outDir: out })).outcome).toBe("written");

  const imageId = await imageIdForPath(master);
  const manifest = parseManifest(
    await readFile(join(out, "images", imageId, "manifest.json")),
  ) as Manifest;

  const full = manifest.levels.find((l) => l.size === "full");
  expect(full?.tiled).toBe(false);
  const fullBytes = new Uint8Array(await readFile(join(out, "levels", `${full!.contenthash}.jxl`)));
  expect(isJxtcContainer(fullBytes)).toBe(false);
});