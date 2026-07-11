// Pure helper for the casava-ai/1 sidecar: normalize EXIF datetime.
// (GPS normalization lives in gps.mjs.)

/** EXIF datetime "YYYY:MM:DD HH:MM:SS" → ISO 8601 "YYYY-MM-DDTHH:MM:SS". null if absent/malformed. */
export function exifDatetimeToIso(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}
