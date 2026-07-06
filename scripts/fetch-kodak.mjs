// Idempotent Kodak 24 download. Skips files already present. Node 18+ global fetch.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "outputs", "codec-paper", "corpus", "kodak");
const BASE = "https://r0k.us/graphics/kodak/kodak";

export async function fetchKodak({ log = console.log } = {}) {
  mkdirSync(OUT, { recursive: true });
  const got = [];
  for (let i = 1; i <= 24; i++) {
    const name = `kodim${String(i).padStart(2, "0")}.png`;
    const dest = join(OUT, name);
    if (existsSync(dest)) { got.push(dest); continue; }
    try {
      const res = await fetch(`${BASE}/${name}`);
      if (!res.ok) { log(`  [!] ${name}: HTTP ${res.status}`); continue; }
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      got.push(dest);
      log(`  fetched ${name}`);
    } catch (e) { log(`  [!] ${name}: ${e.message}`); }
  }
  return got;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("fetch-kodak.mjs")) {
  fetchKodak().then(g => console.log(`Kodak: ${g.length}/24 present at ${OUT}`));
}
