/**
 * Turn decoded GFS messages into one vertical profile per grid point and index
 * each column (#5734 spike).
 */
import type { Grib2Grid, Grib2Message } from './grib2.js';
import { GFS_PRESSURE_LEVELS_HPA } from './gfsClient.js';
import { indexColumn, type ColumnIndex, type ProfileLevel } from './refractivity.js';

// GRIB2 discipline 0 parameters (code table 4.2) and surfaces (table 4.5).
const TMP = '0/0';
const RH = '1/1';
const HGT = '3/5';
const PRES = '3/0';
const GROUND = 1;
const ISOBARIC = 100;
const ABOVE_GROUND = 103;

export class GfsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GfsProfileError';
  }
}

const keyOf = (param: string, surfaceType: number, value: number): string => `${param}@${surfaceType}:${value}`;

function sameGrid(a: Grib2Grid, b: Grib2Grid): boolean {
  return a.ni === b.ni && a.nj === b.nj && a.lat1 === b.lat1 && a.lon1 === b.lon1 && a.dLat === b.dLat && a.dLon === b.dLon;
}

export function indexColumns(messages: readonly Grib2Message[]): { grid: Grib2Grid; columns: (ColumnIndex | null)[] } {
  const fields = new Map<string, Float32Array>();
  let grid: Grib2Grid | null = null;
  for (const m of messages) {
    if (m.discipline !== 0) continue;
    if (!grid) grid = m.grid;
    else if (!sameGrid(grid, m.grid)) throw new GfsProfileError('GFS messages do not share one grid');
    fields.set(keyOf(`${m.category}/${m.parameter}`, m.surfaceType, m.surfaceValue), m.values);
  }
  if (!grid) throw new GfsProfileError('GFS response held no fields');

  const need = (param: string, surfaceType: number, value: number): Float32Array => {
    const v = fields.get(keyOf(param, surfaceType, value));
    if (!v) throw new GfsProfileError(`GFS response is missing ${param} at surface ${surfaceType}:${value}`);
    return v;
  };
  const ground = need(HGT, GROUND, 0);
  const surfacePressure = need(PRES, GROUND, 0);
  const t2m = need(TMP, ABOVE_GROUND, 2);
  const rh2m = need(RH, ABOVE_GROUND, 2);
  const isobaric = GFS_PRESSURE_LEVELS_HPA.flatMap((hPa) => {
    const pa = hPa * 100;
    const h = fields.get(keyOf(HGT, ISOBARIC, pa));
    const t = fields.get(keyOf(TMP, ISOBARIC, pa));
    const rh = fields.get(keyOf(RH, ISOBARIC, pa));
    return h && t && rh ? [{ hPa, h, t, rh }] : [];
  });

  const columns: (ColumnIndex | null)[] = [];
  for (let i = 0; i < grid.ni * grid.nj; i++) {
    const groundM = ground[i];
    const sfcHPa = surfacePressure[i] / 100;
    const levels: ProfileLevel[] = [
      { heightM: groundM + 2, pressureHPa: sfcHPa, temperatureK: t2m[i], relativeHumidityPct: rh2m[i] },
    ];
    for (const l of isobaric) {
      // A pressure level above the surface pressure is underground here.
      if (l.hPa >= sfcHPa) continue;
      levels.push({ heightM: l.h[i], pressureHPa: l.hPa, temperatureK: l.t[i], relativeHumidityPct: l.rh[i] });
    }
    columns.push(Number.isFinite(groundM) && Number.isFinite(sfcHPa) ? indexColumn(levels, groundM) : null);
  }
  return { grid, columns };
}
