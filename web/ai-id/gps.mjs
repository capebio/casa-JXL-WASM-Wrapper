// GPS handler: when a fix exists, promote it to one standardized shape.
//
//   { lat: ±dd.ddddd, lon: ±dd.ddddd, accuracy_m: number|null, elevation_m: number|null }
//
// - lat/lon: signed decimal degrees (N/E positive, S/W negative), rounded to 5 dp
//   (~1.1 m — ample for identification's geographic prior).
// - accuracy_m / elevation_m: metres, 1 dp; null when unknown (elevation below sea level
//   is negative). Returns null entirely when there is no usable fix.

const round5 = (v) => Math.round(v * 1e5) / 1e5;
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * Normalize an explicit GPS reading to the standardized shape, or null.
 * `{ present=true, lat, lon, elevationM, accuracyM }`.
 */
export function normalizeGps({ present = true, lat, lon, elevationM = null, accuracyM = null } = {}) {
  if (!present) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat: round5(lat),
    lon: round5(lon),
    accuracy_m: round1(accuracyM),
    elevation_m: round1(elevationM),
  };
}

/**
 * Adapter from a decoded ProcessResult's GPS getters (has_gps/gps_lat/gps_lon/gps_alt,
 * plus gps_accuracy_m when a future decode path exposes it). Returns the standardized
 * shape or null when there is no fix.
 */
export function gpsFromDecoded(decoded) {
  if (!decoded?.has_gps) return null;
  return normalizeGps({
    present: true,
    lat: decoded.gps_lat,
    lon: decoded.gps_lon,
    elevationM: Number.isFinite(decoded.gps_alt) ? decoded.gps_alt : null,
    accuracyM: Number.isFinite(decoded.gps_accuracy_m) ? decoded.gps_accuracy_m : null,
  });
}
