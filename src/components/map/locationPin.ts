/** Pure helpers for LocationPinPicker (kept apart so the component file exports only components). */

/** (0, 0) is what both firmwares report for "no position", so treat it as unset. */
export function hasPinPosition(lat: number | null, lon: number | null): lat is number {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/** Round to `decimals` places and wrap longitude into -180..180 (Leaflet allows panning past the antimeridian). */
export function normalizePinPosition(lat: number, lon: number, decimals: number): [number, number] {
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const clampedLat = Math.max(-90, Math.min(90, lat));
  const f = 10 ** decimals;
  return [Math.round(clampedLat * f) / f, Math.round(wrappedLon * f) / f];
}
