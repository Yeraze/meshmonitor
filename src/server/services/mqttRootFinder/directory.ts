/**
 * Meshtastic MQTT root directory (#6287, design#167 R9).
 *
 * `src/server/data/mqttRoots.json` is a verbatim copy of `data/mqttRoots.json` from
 * https://github.com/meshtastic/api, so the finder works offline. An admin can
 * turn on a live refresh from api.meshtastic.org (#6337, `directoryProvider.ts`);
 * every live document passes {@link validateDirectory} first.
 *
 * Release step: re-copy the upstream file and update the three constants below.
 */

import rawDirectory from '../../data/mqttRoots.json' with { type: 'json' };
import { validateMqttRoot } from '../../../utils/mqttRootTopic.js';

/** meshtastic/api commit that last touched data/mqttRoots.json. */
export const MQTT_ROOTS_UPSTREAM_COMMIT = '7406a79f7ecd819d7df6c1761f4e0ac6fde657d3';
/** Git blob SHA of the bundled file at that commit. */
export const MQTT_ROOTS_UPSTREAM_BLOB = '75379aac77e93cb05d319a662a1f5600d8057e91';
/** Committer date of the upstream commit. */
export const MQTT_ROOTS_UPSTREAM_DATE = '2026-10-18T11:44:05Z';

/**
 * One community root. design#167 allows two ways to say where it serves: a
 * circle (`center` + `radiusKm`) or a list of ISO 3166-2 `subdivisions`. An
 * entry may carry both, and always carries at least one.
 */
export interface DirectoryEntry {
  root: string;
  name: string;
  /** [lat, lon] in degrees. Present together with `radiusKm`. */
  center?: [number, number];
  radiusKm?: number;
  /** ISO 3166-2 codes, e.g. `US-TX`. */
  subdivisions?: string[];
}

export interface MqttRootDirectory {
  entries: DirectoryEntry[];
  /** `US-TX` -> list of bordering `US-XX` codes. */
  neighbors: Record<string, string[]>;
  /** Country code -> lowercase subdivision name -> root segment. */
  subdivisionSegments: Record<string, Record<string, string>>;
}

/** The bundled directory. */
export function getDirectory(): MqttRootDirectory {
  const d = rawDirectory as unknown as Partial<MqttRootDirectory>;
  return {
    entries: d.entries ?? [],
    neighbors: d.neighbors ?? {},
    subdivisionSegments: d.subdivisionSegments ?? {},
  };
}

// --- Validation of a live document (#6337) ---------------------------------

export const DIRECTORY_LIMITS = {
  maxEntries: 2000,
  maxNameChars: 64,
  /** design#167's cutoff for a community circle. */
  maxRadiusKm: 250,
  maxSubdivisionsPerEntry: 100,
  maxNeighborKeys: 1000,
  maxNeighborsPerKey: 32,
  maxSegmentCountries: 250,
  maxSegmentsPerCountry: 300,
  maxSegmentNameChars: 128,
  maxSegmentChars: 64,
} as const;

const ISO_SUBDIVISION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const ISO_COUNTRY = /^[A-Z]{2}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validateEntry(raw: unknown): DirectoryEntry | null {
  if (!isObject(raw)) return null;
  const { root, name, center, radiusKm, subdivisions } = raw;
  if (typeof root !== 'string' || !root.startsWith('msh/') || !validateMqttRoot(root).ok) return null;
  if (typeof name !== 'string') return null;
  const cleanName = name.replace(CONTROL_CHARS, '').trim();
  if (cleanName.length < 1 || cleanName.length > DIRECTORY_LIMITS.maxNameChars) return null;

  const entry: DirectoryEntry = { root, name: cleanName };
  if (center !== undefined || radiusKm !== undefined) {
    if (!Array.isArray(center) || center.length !== 2) return null;
    const [lat, lon] = center;
    if (!finite(lat) || !finite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (!finite(radiusKm) || radiusKm <= 0 || radiusKm > DIRECTORY_LIMITS.maxRadiusKm) return null;
    entry.center = [lat, lon];
    entry.radiusKm = radiusKm;
  }
  if (subdivisions !== undefined) {
    if (
      !Array.isArray(subdivisions) ||
      subdivisions.length === 0 ||
      subdivisions.length > DIRECTORY_LIMITS.maxSubdivisionsPerEntry ||
      !subdivisions.every((c) => typeof c === 'string' && ISO_SUBDIVISION.test(c))
    ) {
      return null;
    }
    entry.subdivisions = [...new Set(subdivisions as string[])];
  }
  if (!entry.center && !entry.subdivisions) return null;
  return entry;
}

/** `neighbors`: ISO 3166-2 code -> list of codes. Bad pairs are dropped. */
function validateNeighbors(raw: unknown): Record<string, string[]> | null {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > DIRECTORY_LIMITS.maxNeighborKeys) return null;
  const out: Record<string, string[]> = {};
  for (const k of keys) {
    const v = raw[k];
    if (!ISO_SUBDIVISION.test(k) || !Array.isArray(v) || v.length > DIRECTORY_LIMITS.maxNeighborsPerKey) continue;
    const codes = v.filter((c): c is string => typeof c === 'string' && ISO_SUBDIVISION.test(c));
    if (codes.length) out[k] = codes;
  }
  return out;
}

/** `subdivisionSegments`: country -> lowercase name -> one root segment. */
function validateSegments(raw: unknown): Record<string, Record<string, string>> | null {
  if (!isObject(raw)) return null;
  const countries = Object.keys(raw);
  if (countries.length > DIRECTORY_LIMITS.maxSegmentCountries) return null;
  const out: Record<string, Record<string, string>> = {};
  for (const cc of countries) {
    const names = raw[cc];
    if (!ISO_COUNTRY.test(cc) || !isObject(names)) continue;
    const nameKeys = Object.keys(names);
    if (nameKeys.length > DIRECTORY_LIMITS.maxSegmentsPerCountry) continue;
    const map: Record<string, string> = {};
    for (const n of nameKeys) {
      const seg = names[n];
      if (n.length < 1 || n.length > DIRECTORY_LIMITS.maxSegmentNameChars || n !== n.toLowerCase()) continue;
      if (/\p{Cc}/u.test(n)) continue;
      if (typeof seg !== 'string' || seg.length < 1 || seg.length > DIRECTORY_LIMITS.maxSegmentChars) continue;
      if (seg.includes('/') || !validateMqttRoot(seg).ok) continue;
      map[n] = seg;
    }
    if (Object.keys(map).length) out[cc] = map;
  }
  return out;
}

/**
 * Check a directory document. Bad entries are dropped one by one and
 * duplicate roots keep the first. Returns `null` (keep the current data) when
 * the document is not an object, has no valid entry, more than half its
 * entries are bad, or it is over a size cap. A missing or bad `neighbors` /
 * `subdivisionSegments` section comes back empty; the caller falls back to
 * the bundled section.
 */
export function validateDirectory(raw: unknown): MqttRootDirectory | null {
  if (!isObject(raw) || !Array.isArray(raw.entries)) return null;
  const rawEntries = raw.entries as unknown[];
  if (rawEntries.length === 0 || rawEntries.length > DIRECTORY_LIMITS.maxEntries) return null;

  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  let bad = 0;
  for (const r of rawEntries) {
    const e = validateEntry(r);
    if (!e) {
      bad++;
      continue;
    }
    if (seen.has(e.root)) continue;
    seen.add(e.root);
    entries.push(e);
  }
  if (entries.length === 0 || bad * 2 > rawEntries.length) return null;

  return {
    entries,
    neighbors: (raw.neighbors === undefined ? {} : validateNeighbors(raw.neighbors)) ?? {},
    subdivisionSegments:
      (raw.subdivisionSegments === undefined ? {} : validateSegments(raw.subdivisionSegments)) ?? {},
  };
}
