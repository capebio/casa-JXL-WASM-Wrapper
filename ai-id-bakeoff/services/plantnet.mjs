// Pl@ntNet identification client. Plants only.
// API: POST https://my-api.plantnet.org/v2/identify/all?api-key=KEY
// Register a free key at https://my.plantnet.org/ (500 IDs/day).
// Docs: https://my.plantnet.org/account/doc

const ENDPOINT = "https://my-api.plantnet.org/v2/identify/all";

export const meta = { id: "plantnet", label: "Pl@ntNet", scope: "plants", needsKey: "PLANTNET_KEY" };

export async function identify({ buffer, filename, key, signal }) {
  if (!key) throw new Error("PLANTNET_KEY not set");
  const url = `${ENDPOINT}?api-key=${encodeURIComponent(key)}&include-related-images=false&nb-results=5`;
  const form = new FormData();
  form.append("images", new Blob([buffer], { type: "image/jpeg" }), filename);
  form.append("organs", "auto");

  const res = await fetch(url, { method: "POST", body: form, signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const results = (json.results || []).map((r) => ({
    name: r.species?.scientificNameWithoutAuthor ?? "?",
    common: (r.species?.commonNames || [])[0] ?? null,
    score: r.score ?? null,
  }));
  return { results, raw: json };
}
