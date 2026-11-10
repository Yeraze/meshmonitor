/**
 * Builds the offline geocoder's embedded data (#6336). Run by hand when the
 * pinned inputs change:
 *
 *   npx tsx scripts/geo/build-offline-geocoder.ts
 *
 * Inputs (pinned below by version and sha256, downloaded once into
 * ~/.cache/meshmonitor-geo, or $GEO_CACHE_DIR):
 *   - Natural Earth 10m admin-1 states/provinces, GeoJSON, public domain
 *   - GeoNames cities15000.zip, CC BY 4.0
 *
 * GeoNames publishes cities15000.zip without versions: the file at the URL
 * changes daily. To refresh, download it, update GEONAMES.date and
 * GEONAMES.sha256, and rerun. Keep the cached copy; it cannot be fetched again.
 *
 * Steps:
 *   1. Tag each Natural Earth feature with its top-level ISO 3166-2 code
 *      (rules and override tables below).
 *   2. mapshaper (pinned, via npx, not a dependency): dissolve by code, then
 *      topology-preserving Visvalingam simplification.
 *   3. Quantise to 1e-5 degrees, encode, gzip, base64 into
 *      src/server/data/geo/admin1.data.ts.
 *   4. Assign each city to a feature with the server's own lookup code, then
 *      write src/server/data/geo/cities.data.ts.
 *   5. Write src/server/data/geo/geoDataVersion.ts and print sizes.
 *
 * Upstream naming is kept as is (#6336 decision): no local fixes for names.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import {
  COORD_SCALE,
  decodeAdmin1,
  encodeAdmin1,
  encodeCities,
  type Admin1EncodeInput,
  type CityRecord,
} from '../../src/server/services/offlineGeocoder/codec.js';
import { locateFeature, SUBDIVISION_FALLBACK_KM } from '../../src/server/services/offlineGeocoder/pip.js';

/** Bump when the output for the same inputs changes. */
const GENERATOR_VERSION = 1;
const MAPSHAPER_VERSION = '0.7.97';
/**
 * Share of removable vertices kept by mapshaper's Visvalingam simplification.
 * At 15%, 0.5% of GeoNames populated places fall in a different subdivision
 * than at full resolution (25%: 0.25% for +0.45 MB gz; 10%: 0.8%).
 */
const SIMPLIFY_PERCENT = process.env.GEO_SIMPLIFY ?? '15%';

const NATURAL_EARTH = {
  tag: 'v5.1.2',
  file: 'ne_10m_admin_1_states_provinces.geojson',
  url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson',
  sha256: '22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5',
};
const GEONAMES = {
  file: 'cities15000.zip',
  url: 'https://download.geonames.org/export/dump/cities15000.zip',
  date: '2026-11-10',
  sha256: '0df068fe1eb445f18655559b9d80fdd45ac88535d8c27b7b4f5ce5e66b1107b3',
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO, 'src/server/data/geo');
const CACHE = process.env.GEO_CACHE_DIR ?? path.join(homedir(), '.cache/meshmonitor-geo');

const DATA_VERSION = `ne-${NATURAL_EARTH.tag}+gn-${GEONAMES.date}+s${SIMPLIFY_PERCENT}+g${GENERATOR_VERSION}`;

// ---------------------------------------------------------------- overrides

/**
 * Countries where Natural Earth's admin-1 sits below the top ISO 3166-2 level.
 * Each rule maps a feature to its top-level code and name.
 */
type NeProps = Record<string, unknown> & {
  iso_a2: string;
  iso_3166_2: string | null;
  name: string | null;
  region: string | null;
  region_cod: string | null;
  geonunit: string | null;
  adm0_a3: string;
  ne_id: number;
};
type Tag = { cc: string; code?: string; name?: string };

const GB_NATIONS: Record<string, Tag> = {
  England: { cc: 'GB', code: 'GB-ENG', name: 'England' },
  Scotland: { cc: 'GB', code: 'GB-SCT', name: 'Scotland' },
  Wales: { cc: 'GB', code: 'GB-WLS', name: 'Wales' },
  'Northern Ireland': { cc: 'GB', code: 'GB-NIR', name: 'Northern Ireland' },
};

/** NE `region_cod` -> ISO 3166-2 where they differ (FR overseas, Corsica). */
const FR_REGION_FIX: Record<string, string> = {
  'FR-COR': 'FR-20R',
  'FR-GUA': 'FR-971',
  'FR-MTQ': 'FR-972',
  'FR-GUF': 'FR-973',
  'FR-LRE': 'FR-974',
  'FR-MAY': 'FR-976',
};

/** NE `region_cod` (HASC-style) -> ISO 3166-2 autonomous community. */
const ES_REGION: Record<string, string> = {
  'ES.AN': 'ES-AN', 'ES.AR': 'ES-AR', 'ES.AS': 'ES-AS', 'ES.CN': 'ES-CN', 'ES.CB': 'ES-CB',
  'ES.CL': 'ES-CL', 'ES.CM': 'ES-CM', 'ES.CT': 'ES-CT', 'ES.EX': 'ES-EX', 'ES.NA': 'ES-NC',
  'ES.GA': 'ES-GA', 'ES.PM': 'ES-IB', 'ES.LO': 'ES-RI', 'ES.MD': 'ES-MD', 'ES.MU': 'ES-MC',
  'ES.PV': 'ES-PV', 'ES.VC': 'ES-VC',
};

const BE_REGION: Record<string, Tag> = {
  'Capital Region': { cc: 'BE', code: 'BE-BRU', name: 'Brussels' },
  Flemish: { cc: 'BE', code: 'BE-VLG', name: 'Flanders' },
  Walloon: { cc: 'BE', code: 'BE-WAL', name: 'Wallonia' },
};

/** Irish county code -> province (ISO 3166-2:IE top level). */
const IE_PROVINCE: Record<string, Tag> = {};
for (const [prov, name, counties] of [
  ['IE-C', 'Connacht', 'G LM MO RN SO'],
  ['IE-L', 'Leinster', 'CW D KE KK LS LD LH MH OY WH WX WW'],
  ['IE-M', 'Munster', 'CE CO KY LK TA WD'],
  ['IE-U', 'Ulster', 'CN DL MN'],
] as const) {
  for (const c of counties.split(' ')) IE_PROVINCE[`IE-${c}`] = { cc: 'IE', code: prov, name };
}

/**
 * Natural Earth features with no ISO country (`iso_a2` = -1), by `adm0_a3`.
 * They get a country only. Absent here means dropped (contested and empty).
 */
const NO_COUNTRY: Record<string, string> = {
  CYN: 'CY', // Northern Cyprus
  ESB: 'CY', // Dhekelia
  WSB: 'CY', // Akrotiri
  SOL: 'SO', // Somaliland
  USG: 'CU', // Guantanamo Bay
  KAB: 'KZ', // Baykonur
  CLP: 'FR', // Clipperton
  CSI: 'AU', // Coral Sea Islands
};
const NO_COUNTRY_BY_NAME: Record<string, string> = {
  'Christmas Island': 'CX',
  'Cocos (Keeling) Islands': 'CC',
};

const ISO_CODE = /^([A-Z]{2})-([A-Z0-9]{1,3})$/;

function tagFeature(p: NeProps): Tag | null {
  const a2 = p.iso_a2;
  const raw = (p.iso_3166_2 ?? '').trim();
  const region = p.region?.trim() ?? '';
  const regionCod = (p.region_cod ?? '').trim();

  switch (a2) {
    case 'GB':
      return GB_NATIONS[p.geonunit ?? ''] ?? fail(p, 'GB nation');
    case 'FR': {
      const code = FR_REGION_FIX[regionCod] ?? regionCod;
      return ISO_CODE.test(code) ? { cc: 'FR', code, name: region } : fail(p, 'FR region');
    }
    case 'IT':
      return ISO_CODE.test(regionCod) ? { cc: 'IT', code: regionCod, name: region } : fail(p, 'IT region');
    case 'ES': {
      // Ceuta and Melilla share NE's region_cod; both are top level themselves.
      if (raw === 'ES-CE' || raw === 'ES-ML') return { cc: 'ES', code: raw, name: p.name ?? undefined };
      const code = ES_REGION[regionCod];
      return code ? { cc: 'ES', code, name: region } : fail(p, 'ES region');
    }
    case 'BE':
      return BE_REGION[region] ?? fail(p, 'BE region');
    case 'IE':
      return IE_PROVINCE[raw] ?? fail(p, 'IE province');
    case 'PH':
      return ISO_CODE.test(regionCod) ? { cc: 'PH', code: regionCod, name: region } : fail(p, 'PH region');
  }

  // NE placeholders (`XK-X01~`, `AI-X00`) are not ISO codes.
  const m = /-X\d/.test(raw) ? null : ISO_CODE.exec(raw);
  // The code's own prefix wins over iso_a2 (Puerto Rico is US-PR, Sint Maarten NL-SX).
  if (m) return { cc: m[1], code: raw, name: p.name ?? undefined };
  if (/^[A-Z]{2}$/.test(a2)) return { cc: a2 }; // NE placeholder code (`XK-X01~`): country only
  const cc = NO_COUNTRY[p.adm0_a3] ?? NO_COUNTRY_BY_NAME[p.name ?? ''];
  return cc ? { cc } : null;
}

function fail(p: NeProps, what: string): never {
  throw new Error(`no ${what} for ${p.iso_3166_2} ${p.name} (ne_id ${p.ne_id})`);
}

// ---------------------------------------------------------------- helpers

function sha256(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function fetchPinned(spec: { file: string; url: string; sha256: string }): string {
  const dir = path.join(CACHE, 'dl');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, spec.file);
  if (!existsSync(file)) {
    console.log(`downloading ${spec.url}`);
    execFileSync('curl', ['-sSfL', '-o', file, spec.url], { stdio: 'inherit' });
  }
  const got = sha256(readFileSync(file));
  if (got !== spec.sha256) {
    throw new Error(`${spec.file}: sha256 ${got}, pinned ${spec.sha256}. Update the pin on purpose, or restore the cached copy.`);
  }
  return file;
}

/** Shoelace area in square degrees: used only to pick a name among duplicates. */
function geomArea(g: { type: string; coordinates: unknown }): number {
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as number[][][][];
  let a = 0;
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      let s = 0;
      for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
        s += (ring[j][0] + ring[k][0]) * (ring[j][1] - ring[k][1]);
      }
      a += (i === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  }
  return a;
}

type GeoJsonFeature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null };

// ---------------------------------------------------------------- admin-1

function buildAdmin1(neFile: string): Admin1EncodeInput {
  const ne = JSON.parse(readFileSync(neFile, 'utf8')) as { features: GeoJsonFeature[] };
  type Tagged = Tag & { key: string; area: number; neId: number; f: GeoJsonFeature };
  const tagged: Tagged[] = [];
  let dropped = 0;
  for (const f of ne.features) {
    if (!f.geometry) continue;
    const t = tagFeature(f.properties as NeProps);
    if (!t) {
      dropped++;
      continue;
    }
    tagged.push({ ...t, key: t.code ?? `~${t.cc}`, area: geomArea(f.geometry), neId: Number(f.properties.ne_id), f });
  }
  // One name per code: the largest member's (ties: lowest ne_id).
  const nameFor = new Map<string, string | undefined>();
  const best = new Map<string, Tagged>();
  for (const t of tagged) {
    const b = best.get(t.key);
    if (!b || t.area > b.area || (t.area === b.area && t.neId < b.neId)) best.set(t.key, t);
  }
  for (const [k, t] of best) nameFor.set(k, t.name);

  const keyed = {
    type: 'FeatureCollection',
    features: tagged.map((t) => ({
      type: 'Feature',
      properties: { key: t.key, cc: t.cc, code: t.code ?? '', name: nameFor.get(t.key) ?? '' },
      geometry: t.f.geometry,
    })),
  };
  const work = path.join(CACHE, 'work');
  mkdirSync(work, { recursive: true });
  const keyedFile = path.join(work, 'admin1_keyed.geojson');
  const outFile = path.join(work, 'admin1_top.geojson');
  writeFileSync(keyedFile, JSON.stringify(keyed));
  console.log(`tagged ${tagged.length} NE features into ${best.size} codes (${dropped} dropped)`);

  execFileSync(
    'npx',
    [
      '-y',
      `mapshaper@${MAPSHAPER_VERSION}`,
      keyedFile,
      '-dissolve',
      'key',
      'copy-fields=cc,code,name',
      '-simplify',
      'visvalingam',
      SIMPLIFY_PERCENT,
      'keep-shapes',
      '-o',
      'format=geojson',
      'precision=0.00001',
      'force',
      outFile,
    ],
    { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } },
  );

  const out = JSON.parse(readFileSync(outFile, 'utf8')) as { features: GeoJsonFeature[] };
  const features: Admin1EncodeInput['features'] = [];
  for (const f of out.features) {
    const p = f.properties as { key: string; cc: string; code: string; name: string };
    if (!f.geometry) continue;
    const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
    const rings: Array<Array<[number, number]>> = [];
    for (const poly of polys) {
      for (const ring of poly) {
        const q: Array<[number, number]> = [];
        for (const [lon, lat] of ring) {
          const pt: [number, number] = [Math.round(lon * COORD_SCALE), Math.round(lat * COORD_SCALE)];
          const last = q[q.length - 1];
          if (!last || last[0] !== pt[0] || last[1] !== pt[1]) q.push(pt);
        }
        // Open the ring.
        if (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1]) q.pop();
        if (q.length >= 3) rings.push(q);
      }
    }
    if (!rings.length) continue;
    features.push({ cc: p.cc, ...(p.code ? { code: p.code } : {}), ...(p.name ? { name: p.name } : {}), rings });
  }
  // Stable order: by code (country-only areas use `~CC`, which sorts last).
  features.sort((a, b) => {
    const ka = a.code ?? `~${a.cc}`;
    const kb = b.code ?? `~${b.cc}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { version: DATA_VERSION, features };
}

// ---------------------------------------------------------------- cities

/** GeoNames feature codes that are not towns in their own right. */
const SKIP_CITY_CODES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

function buildCities(zipFile: string, admin1Bytes: Uint8Array): { cities: CityRecord[]; skipped: Record<string, number> } {
  const admin1 = decodeAdmin1(admin1Bytes);
  const txt = execFileSync('unzip', ['-p', zipFile, 'cities15000.txt'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const cities: CityRecord[] = [];
  const skipped = { featureCode: 0, noFeature: 0, otherCountry: 0 };
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    const id = Number(c[0]);
    const name = c[1].normalize('NFC');
    const lat = Math.round(Number(c[4]) * COORD_SCALE);
    const lon = Math.round(Number(c[5]) * COORD_SCALE);
    const code = c[7];
    const country = c[8];
    const population = Number(c[14]) || 0;
    if (SKIP_CITY_CODES.has(code)) {
      skipped.featureCode++;
      continue;
    }
    const feature = locateFeature(admin1, lon, lat, SUBDIVISION_FALLBACK_KM);
    if (feature === -1) {
      skipped.noFeature++;
      continue;
    }
    // A city whose GeoNames country disagrees with the polygon is kept: the
    // polygon decides, so a lookup never names a city across a border it
    // cannot see. Counted for the report only.
    if (admin1.features[feature].cc !== country) skipped.otherCountry++;
    cities.push({ id, name, lat, lon, population, feature });
  }
  cities.sort((a, b) => a.feature - b.feature || a.id - b.id);
  return { cities, skipped };
}

// ---------------------------------------------------------------- output

function writeModule(file: string, exportName: string, header: string[], gz: Uint8Array): { b64: number; file: number } {
  const b64 = Buffer.from(gz).toString('base64');
  const body = [
    '// GENERATED by scripts/geo/build-offline-geocoder.ts. Do not edit by hand.',
    ...header.map((l) => `// ${l}`),
    `// Data version: ${DATA_VERSION}`,
    '// gzip, then base64. Typed `string` so tsc does not infer a literal type.',
    `export const ${exportName}: string =`,
    `  '${b64}';`,
    '',
  ].join('\n');
  writeFileSync(file, body);
  return { b64: b64.length, file: Buffer.byteLength(body) };
}

function main(): void {
  const neFile = fetchPinned(NATURAL_EARTH);
  const gnFile = fetchPinned(GEONAMES);
  mkdirSync(OUT_DIR, { recursive: true });

  const admin1Input = buildAdmin1(neFile);
  const admin1Raw = encodeAdmin1(admin1Input);
  const admin1Gz = gzipSync(admin1Raw, { level: 9 });
  const vertices = admin1Input.features.reduce((n, f) => n + f.rings.reduce((m, r) => m + r.length, 0), 0);
  const admin1Out = writeModule(
    path.join(OUT_DIR, 'admin1.data.ts'),
    'ADMIN1_DATA_GZ_B64',
    [
      `Natural Earth 10m admin-1 states and provinces, ${NATURAL_EARTH.tag}. Public domain.`,
      'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
      'Dissolved to top-level ISO 3166-2 and simplified. See THIRD_PARTY_DATA.md.',
    ],
    admin1Gz,
  );

  const { cities, skipped } = buildCities(gnFile, admin1Raw);
  const citiesRaw = encodeCities(DATA_VERSION, admin1Input.features.length, cities);
  const citiesGz = gzipSync(citiesRaw, { level: 9 });
  const citiesOut = writeModule(
    path.join(OUT_DIR, 'cities.data.ts'),
    'CITIES_DATA_GZ_B64',
    [
      `GeoNames cities15000, downloaded ${GEONAMES.date}. CC BY 4.0, https://www.geonames.org/.`,
      'Changed: reduced to name, position, population and id; joined to subdivisions.',
      'See THIRD_PARTY_DATA.md. Delete this module to ship without the city rung.',
    ],
    citiesGz,
  );

  const version = [
    '// GENERATED by scripts/geo/build-offline-geocoder.ts. Do not edit by hand.',
    '// Pins for the offline geocoder data (#6336). See THIRD_PARTY_DATA.md.',
    '',
    `export const GEO_DATA_VERSION = '${DATA_VERSION}';`,
    `export const GEO_GENERATOR_VERSION = ${GENERATOR_VERSION};`,
    `export const GEO_MAPSHAPER_VERSION = '${MAPSHAPER_VERSION}';`,
    `export const GEO_SIMPLIFY = '${SIMPLIFY_PERCENT}';`,
    '',
    '/** Natural Earth 10m admin-1, public domain. */',
    'export const NATURAL_EARTH_ADMIN1 = {',
    `  tag: '${NATURAL_EARTH.tag}',`,
    `  url: '${NATURAL_EARTH.url}',`,
    `  sha256: '${NATURAL_EARTH.sha256}',`,
    '};',
    '',
    '/** GeoNames cities15000, CC BY 4.0. */',
    'export const GEONAMES_CITIES = {',
    `  url: '${GEONAMES.url}',`,
    `  downloaded: '${GEONAMES.date}',`,
    `  sha256: '${GEONAMES.sha256}',`,
    '};',
    '',
    '/** sha256 of the gzip payloads in admin1.data.ts and cities.data.ts. */',
    `export const ADMIN1_DATA_SHA256 = '${sha256(admin1Gz)}';`,
    `export const CITIES_DATA_SHA256 = '${sha256(citiesGz)}';`,
    '',
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, 'geoDataVersion.ts'), version);

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`data version ${DATA_VERSION}`);
  console.log(
    `admin1: ${admin1Input.features.length} features, ${vertices} vertices; raw ${kb(admin1Raw.length)}, gz ${kb(admin1Gz.length)}, base64 ${kb(admin1Out.b64)}, module ${kb(admin1Out.file)}`,
  );
  console.log(
    `cities: ${cities.length} kept (${JSON.stringify(skipped)}); raw ${kb(citiesRaw.length)}, gz ${kb(citiesGz.length)}, base64 ${kb(citiesOut.b64)}, module ${kb(citiesOut.file)}`,
  );
  console.log(`total gz ${kb(admin1Gz.length + citiesGz.length)}, modules ${kb(admin1Out.file + citiesOut.file)}`);
}

main();
