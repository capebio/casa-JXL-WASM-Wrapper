// iNaturalist computer-vision client. Plants AND animals.
// API: POST https://api.inaturalist.org/v1/computervision/score_image
// Needs an OAuth API token (Authorization: Bearer ...). Get one while logged in
// at https://www.inaturalist.org/users/api_token (JWT, ~24h lifetime).
// Optional lat/lng sharpen results via geographic prior — we pass GPS when known.

const ENDPOINT = "https://api.inaturalist.org/v1/computervision/score_image";

export const meta = { id: "inat", label: "iNaturalist", scope: "plants+animals", needsKey: "INAT_TOKEN" };

export async function identify({ buffer, filename, key, signal, lat, lng }) {
  if (!key) throw new Error("INAT_TOKEN not set");
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/jpeg" }), filename);
  if (typeof lat === "number" && typeof lng === "number") {
    form.append("lat", String(lat));
    form.append("lng", String(lng));
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: key.startsWith("Bearer") ? key : `Bearer ${key}` },
    body: form,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const results = (json.results || []).slice(0, 5).map((r) => ({
    name: r.taxon?.name ?? "?",
    common: r.taxon?.preferred_common_name ?? null,
    rank: r.taxon?.rank ?? null,
    score: r.combined_score ?? r.vision_score ?? null,
  }));
  return { results, raw: json };
}
