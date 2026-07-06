import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// K6#5 — FFI ABI contract test.
//
// Root cause of the metadata arg-shift HIGH bug: the facade's call site passed a
// different number of args than the compiled bridge symbol accepted, so pointers
// slid two slots (ICC → group_order, XMP dropped). TypeScript already enforces
// call-site ⟷ interface arity at compile time. This test enforces the OTHER half:
// interface ⟷ compiled-bridge arity. Together they make the arg-shift class
// impossible: call-site == interface == bridge.
//
// The expected-arity table is DERIVED from the `LibjxlWasmModule` interface in
// facade.ts (the single declared contract), not hand-maintained — so it can never
// drift from the declaration the facade call sites are written against. Every
// symbol present in the real shipped module must expose exactly the declared arity
// (WebAssembly/emscripten functions report their C parameter count via `.length`).

const FACADE_URL = new URL("../src/facade.ts", import.meta.url);

/** Parse `name -> { arity, optional }` from the `LibjxlWasmModule` interface. */
function parseAbiContract(): Map<string, { arity: number; optional: boolean }> {
  const src = readFileSync(fileURLToPath(FACADE_URL), "utf8");
  const start = src.indexOf("interface LibjxlWasmModule {");
  if (start < 0) throw new Error("LibjxlWasmModule interface not found in facade.ts");
  // Walk braces from the opening `{` to its match so we capture only the body.
  const openBrace = src.indexOf("{", start);
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(openBrace + 1, end);

  const out = new Map<string, { arity: number; optional: boolean }>();
  // Method members only: `_name(...args...): ret;` (optionally `_name?(...)`).
  // Every parameter is `ident: type` with no nested commas, so comma-count == arity.
  const re = /(_\w+)(\??)\(([^)]*)\)\s*:/g;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;
    re.lastIndex = 0;
    const m = re.exec(trimmed);
    if (!m) continue; // HEAPU8 etc. (properties, no call parens) are skipped
    const [, name, opt, params] = m;
    const arity = params.trim() === "" ? 0 : params.split(",").length;
    out.set(name, { arity, optional: opt === "?" });
  }
  return out;
}

async function loadRealModule(): Promise<any | null> {
  try {
    const imported = await import("../dist/jxl-core.scalar.js");
    if (typeof imported.default !== "function") return null;
    const baseUrl = new URL("../dist/", import.meta.url);
    const module = await imported.default({
      locateFile: (path: string) => new URL(path, baseUrl).href,
    });
    if (module && typeof module._malloc === "function") return module;
  } catch {}
  return null;
}

describe("FFI ABI contract (facade interface ⟷ compiled bridge)", () => {
  test("the interface parses to a non-trivial symbol table", () => {
    const contract = parseAbiContract();
    // Sanity: the widest known signatures must be captured with their exact arity,
    // so a parser regression can't silently empty the table and pass everything.
    expect(contract.get("_malloc")).toEqual({ arity: 1, optional: false });
    expect(contract.get("_jxl_wasm_encode_rgba8")).toEqual({ arity: 12, optional: false });
    expect(contract.get("_jxl_wasm_encode_rgba8_with_metadata")).toEqual({
      arity: 19,
      optional: true,
    });
    expect(contract.get("_jxl_wasm_encode_rgba8_with_metadata_adv")).toEqual({
      arity: 22,
      optional: true,
    });
    expect(contract.get("_jxl_wasm_enc_create_image_z")).toEqual({ arity: 30, optional: true });
    // At least the full decode/encode/buffer surface (dozens of symbols).
    expect(contract.size).toBeGreaterThan(40);
  });

  test("every compiled symbol matches its declared arity; required symbols present", async () => {
    const contract = parseAbiContract();
    const module = await loadRealModule();
    if (!module) return; // dist unavailable in this environment — skip (CI builds it)

    const mismatches: string[] = [];
    const missingRequired: string[] = [];
    for (const [name, { arity, optional }] of contract) {
      const fn = module[name];
      if (typeof fn !== "function") {
        if (!optional) missingRequired.push(name);
        continue; // optional capability-gated symbol absent in this build — fine
      }
      if (fn.length !== arity) {
        mismatches.push(`${name}: interface declares ${arity}, bridge compiled ${fn.length}`);
      }
    }

    expect(missingRequired, `required bridge symbols missing: ${missingRequired.join(", ")}`).toEqual(
      []
    );
    expect(mismatches, `ABI arity drift:\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });
});
