// Pure helpers for the casava-ai/1 sidecar: normalize EXIF datetime and GPS.

/** EXIF datetime "YYYY:MM:DD HH:MM:SS" → ISO 8601 "YYYY-MM-DDTHH:MM:SS". null if absent/malformed. */
export function exifDatetimeToIso(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

/** Decoded-result GPS getters → decimal geo block, or null when absent. */
export function geoBlock(decoded) {
  if (!decoded?.has_gps) return null;
  return { lat: decoded.gps_lat, lon: decoded.gps_lon, alt: decoded.gps_alt };
}
