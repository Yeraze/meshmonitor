/**
 * Atmospheric refractivity and a per-column ducting index (#5734 spike).
 *
 * Radio refractivity (ITU-R P.453):
 *   N = 77.6 / T * (P + 4810 * e / T)      T in K, P and e in hPa
 * Modified refractivity folds in the earth's curvature:
 *   M = N + 157 * h                         h in km
 * A layer traps a signal (a duct) where M falls with height, which is the same
 * as dN/dh < -157 N/km. ITU-R P.453 calls -79 to -157 N/km super-refraction
 * (signals bend more than normal and reach past the usual horizon), and the
 * standard atmosphere is about -40 N/km.
 *
 * GFS pressure levels sit 200-500 m apart near the ground, so a sharp
 * inversion is averaged over a thick layer and its gradient comes out weaker
 * than it is. This index therefore under-reads ducts. It is a forecast of
 * "conditions favour long paths", not a measured duct.
 */

/** One point of a vertical profile. */
export interface ProfileLevel {
  /** Height above mean sea level, m (GFS geopotential height). */
  heightM: number;
  pressureHPa: number;
  temperatureK: number;
  relativeHumidityPct: number;
}

export type DuctingClass = 'sub-refractive' | 'normal' | 'super-refractive' | 'ducting';

export interface ColumnIndex {
  /** Most negative dN/dh between adjacent levels in the low layer, N/km. */
  minGradientNPerKm: number;
  /** Base and top of that layer, m above ground. */
  layerBaseM: number;
  layerTopM: number;
  /**
   * Largest drop in M across one run of falling-M layers, M units. 0 when no
   * layer traps. Stands in for how strong a duct is.
   */
  ductStrengthM: number;
  class: DuctingClass;
}

/** ITU-R P.453 gradient bounds, N/km. */
export const SUPER_REFRACTION_N_PER_KM = -79;
export const DUCTING_N_PER_KM = -157;
/** Gradients above this read as sub-refraction (signals bend less than normal). */
export const SUB_REFRACTION_N_PER_KM = 0;

/** Look only this far above ground. Ducts that matter to ground stations sit low. */
export const MAX_LAYER_TOP_M = 3000;
/** Skip layers thinner than this: their gradient is noise. */
const MIN_LAYER_THICKNESS_M = 10;

/** Saturation vapour pressure over water, hPa (Bolton 1980). */
export function saturationVapourPressureHPa(temperatureK: number): number {
  const c = temperatureK - 273.15;
  return 6.112 * Math.exp((17.67 * c) / (c + 243.5));
}

/** Radio refractivity N of one level. */
export function refractivityN(level: Pick<ProfileLevel, 'pressureHPa' | 'temperatureK' | 'relativeHumidityPct'>): number {
  const t = level.temperatureK;
  const rh = Math.min(Math.max(level.relativeHumidityPct, 0), 100);
  const e = (rh / 100) * saturationVapourPressureHPa(t);
  return (77.6 / t) * (level.pressureHPa + (4810 * e) / t);
}

/** Modified refractivity M at `heightAglM` above ground. */
export function modifiedRefractivityM(n: number, heightAglM: number): number {
  return n + 0.157 * heightAglM;
}

export function classifyGradient(nPerKm: number): DuctingClass {
  if (nPerKm <= DUCTING_N_PER_KM) return 'ducting';
  if (nPerKm <= SUPER_REFRACTION_N_PER_KM) return 'super-refractive';
  if (nPerKm > SUB_REFRACTION_N_PER_KM) return 'sub-refractive';
  return 'normal';
}

/**
 * Index one column. `levels` may be in any order; levels below ground or with
 * a missing value are dropped. Returns null when fewer than two usable levels
 * remain.
 */
export function indexColumn(levels: readonly ProfileLevel[], groundHeightM: number): ColumnIndex | null {
  const usable = levels
    .filter(
      (l) =>
        Number.isFinite(l.heightM) &&
        Number.isFinite(l.pressureHPa) &&
        Number.isFinite(l.temperatureK) &&
        Number.isFinite(l.relativeHumidityPct) &&
        l.temperatureK > 150 &&
        // 1 m of slack: an isobaric level's geopotential height can sit just
        // under the surface height from packing rounding; keep it.
        l.heightM >= groundHeightM - 1,
    )
    .map((l) => {
      const agl = Math.max(0, l.heightM - groundHeightM);
      const n = refractivityN(l);
      return { agl, n, m: modifiedRefractivityM(n, agl) };
    })
    .sort((a, b) => a.agl - b.agl);

  let best: ColumnIndex | null = null;
  let runDrop = 0;
  let maxDrop = 0;
  for (let i = 1; i < usable.length; i++) {
    const lo = usable[i - 1];
    const hi = usable[i];
    if (lo.agl >= MAX_LAYER_TOP_M) break;
    const dz = hi.agl - lo.agl;
    if (dz < MIN_LAYER_THICKNESS_M) continue;
    const gradient = (hi.n - lo.n) / (dz / 1000);
    if (!best || gradient < best.minGradientNPerKm) {
      best = { minGradientNPerKm: gradient, layerBaseM: lo.agl, layerTopM: hi.agl, ductStrengthM: 0, class: 'normal' };
    }
    if (hi.m < lo.m) {
      runDrop += lo.m - hi.m;
      maxDrop = Math.max(maxDrop, runDrop);
    } else {
      runDrop = 0;
    }
  }
  if (!best) return null;
  best.ductStrengthM = maxDrop;
  best.class = classifyGradient(best.minGradientNPerKm);
  return best;
}
