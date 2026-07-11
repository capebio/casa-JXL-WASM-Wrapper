// Gemini vision identifier — scriptable "everything" service (replaces un-automatable Lens).
// Uses GEMINI_API_KEY. Sends the proxy JPEG + a biologist prompt, asks for JSON.
// Model override: GEMINI_MODEL (default gemini-2.0-flash).

export const meta = { id: "gemini", label: "Gemini", scope: "everything", needsKey: "GEMINI_API_KEY" };

const PROMPT =
  "You are a field biologist. Identify the single main organism (plant or animal) in this photo " +
  "to the most specific taxonomic level you can. Return ONLY a JSON array of up to 5 candidates, " +
  "ordered by confidence, each object: " +
  '{"scientific_name": string, "common_name": string, "confidence": number between 0 and 1, "kind": "plant" | "animal"}. ' +
  "No markdown, no prose, JSON only.";

export async function identify({ buffer, key, signal }) {
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "image/jpeg", data: Buffer.from(buffer).toString("base64") } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };
  let res, text;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    text = await res.text();
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); // backoff on rate-limit
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`non-JSON model reply: ${raw.slice(0, 200)}`); }
  const arr = Array.isArray(parsed) ? parsed : (parsed.candidates || parsed.results || []);
  const results = arr.slice(0, 5).map((r) => ({
    name: r.scientific_name ?? r.name ?? "?",
    common: r.common_name ?? null,
    kind: r.kind ?? null,
    score: typeof r.confidence === "number" ? r.confidence : null,
  }));
  return { results, raw: json };
}
