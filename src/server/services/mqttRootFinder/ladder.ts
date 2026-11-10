/**
 * Root ladder and ranking (#6287, design#167 R4-R7). Pure functions, no I/O.
 */

import {
  rootDepth,
  sanitizeSegment,
  trimToBytes,
  validateMqttRoot,
} from '../../../utils/mqttRootTopic.js';
import type { DirectoryEntry, MqttRootDirectory } from './directory.js';

/** After this many packets a root counts as flooded (R2/R4). */
export const FLOOD_CAP = 300;

export interface LatLon {
  lat: number;
  lon: number;
}

/** What the sampler heard under one root. */
export interface HeardRoot {
  root: string;
  /** Distinct nodes seen (gateways and map reporters). */
  nodes: number;
  messages: number;
  /** True when every message under this root was a retained one. */
  retainedOnly: boolean;
  /** True when the stream hit the packet cap, so the counts are a floor. */
  floor?: boolean;
  /** Map-report positions. Stay on the server; only distances leave. */
  positions?: LatLon[];
}

/** A resolved place for the user, from the offline geocoder (#6336). Absent without a position. */
export interface Place {
  /** ISO 3166-1 alpha-2, e.g. `US`. */
  cc: string;
  /** Subdivision name as the geocoder gave it, e.g. `Washington`. */
  subdivisionName?: string;
  /** ISO 3166-2 code, e.g. `US-WA`. Used for neighbor lookup. */
  subdivisionIso?: string;
  city?: string;
}

export type LadderKind = 'region' | 'country' | 'subdivision' | 'city';

export interface LadderRow {
  root: string;
  kind: LadderKind;
  /** Heard counts for this root, when it was heard. */
  nodes?: number;
  messages?: number;
  /** True when the counts are a floor (packet cap hit). */
  floor?: boolean;
  heard: boolean;
}

export interface CommunityRow {
  root: string;
  name: string;
  heard: boolean;
  nodes?: number;
  messages?: number;
  floor?: boolean;
}

export type Tier = 1 | 2 | 3;

export interface RankedHeard {
  root: string;
  nodes: number;
  messages: number;
  depth: number;
  /** Rounded to 1 km. Never a coordinate. */
  nearestKm?: number;
  tier: Tier;
  retainedOnly: boolean;
  floor: boolean;
}

const EARTH_KM = 6371;

export function haversineKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const underOrEqual = (root: string, prefix: string) =>
  root === prefix || root.startsWith(prefix + '/');

const isFlooded = (h: HeardRoot | undefined) =>
  !!h && (h.floor === true || h.messages >= FLOOD_CAP);

function findHeard(heard: HeardRoot[], root: string): HeardRoot | undefined {
  return heard.find((h) => h.root === root);
}

/** Aggregate counts for a root: itself plus everything below it. */
function countsUnder(heard: HeardRoot[], root: string) {
  let nodes = 0;
  let messages = 0;
  let any = false;
  let floor = false;
  for (const h of heard) {
    if (!underOrEqual(h.root, root)) continue;
    any = true;
    nodes += h.nodes;
    messages += h.messages;
    if (h.floor) floor = true;
  }
  return { any, nodes, messages, floor };
}

/** Segment for a subdivision (R5). Falls back to the ISO 3166-2 suffix, then the cleaned name. */
export function subdivisionSegment(
  place: Place,
  directory: MqttRootDirectory,
): string | null {
  const name = place.subdivisionName?.trim().toLowerCase();
  const mapped = name ? directory.subdivisionSegments[place.cc.toUpperCase()]?.[name] : undefined;
  if (mapped) return mapped;
  if (place.subdivisionIso && place.subdivisionIso.includes('-')) {
    const suffix = sanitizeSegment(place.subdivisionIso.split('-').slice(1).join(''));
    if (suffix) return suffix;
  }
  if (place.subdivisionName) {
    const clean = sanitizeSegment(place.subdivisionName);
    if (clean) return clean;
  }
  return null;
}

/** `<region>/<CC>` root for the place. */
function countryRootFor(regionRoot: string, place: Place): string {
  // When the region already is the country (`msh/US`), subdivisions sit
  // directly under it. `msh/US/US` is a republisher's doubled root.
  if (lastSegment(regionRoot).toLowerCase() === place.cc.toLowerCase()) return regionRoot;
  return `${regionRoot}/${place.cc.toUpperCase()}`;
}

/** Root of the user's subdivision, even when the country row itself is not offered. */
export function subdivisionRootFor(
  regionRoot: string,
  place: Place | undefined,
  directory: MqttRootDirectory,
): string | null {
  if (!place?.cc) return null;
  const seg = subdivisionSegment(place, directory);
  if (!seg) return null;
  return trimToBytes(`${countryRootFor(regionRoot, place)}/${seg}`);
}

/** Root of the user's city. */
export function cityRootFor(
  regionRoot: string,
  place: Place | undefined,
  directory: MqttRootDirectory,
): string | null {
  const sub = subdivisionRootFor(regionRoot, place, directory);
  if (!sub || !place?.city) return null;
  const city = sanitizeSegment(place.city).toLowerCase();
  if (!city) return null;
  return trimToBytes(`${sub}/${city}`);
}

function lastSegment(root: string) {
  const parts = root.split('/');
  return parts[parts.length - 1];
}

/**
 * Build the suggested ladder: region, country, subdivision, city (R4).
 * Rows that fail validation after trimming are dropped.
 */
export function buildLadder(opts: {
  regionRoot: string;
  place?: Place;
  heard: HeardRoot[];
  directory: MqttRootDirectory;
}): LadderRow[] {
  const { regionRoot, place, heard, directory } = opts;
  const rows: LadderRow[] = [];

  const push = (root: string, kind: LadderKind) => {
    if (!validateMqttRoot(root).ok) return;
    const c = countsUnder(heard, root);
    const own = findHeard(heard, root);
    rows.push({
      root,
      kind,
      heard: c.any,
      ...(c.any
        ? {
            nodes: own?.nodes ?? c.nodes,
            messages: own?.messages ?? c.messages,
            floor: own?.floor === true || c.floor || undefined,
          }
        : {}),
    });
  };

  // The region row is always offered. Its own `2/e` stream is the one the
  // sampler cuts at the cap, so its count is a floor when it hits it.
  const regionHeard = findHeard(heard, regionRoot);
  rows.push({
    root: regionRoot,
    kind: 'region',
    heard: !!regionHeard,
    ...(regionHeard
      ? { nodes: regionHeard.nodes, messages: regionHeard.messages, floor: isFlooded(regionHeard) || undefined }
      : {}),
  });

  if (!place?.cc) return rows;

  const cc = place.cc.toUpperCase();
  const countryRoot = countryRootFor(regionRoot, place);
  const regionName = lastSegment(regionRoot);

  // A republisher's doubled root (msh/US/US) is never offered, and the
  // country is only a rung when it is not the region itself.
  const doubled = cc.toLowerCase() === regionName.toLowerCase();

  // Offer the country only when roots under the region use the code as their
  // next segment AND the country root is not flooded.
  const countryHeard = findHeard(heard, countryRoot);
  const usesCode = heard.some((h) => underOrEqual(h.root, countryRoot));
  if (!doubled && usesCode && !isFlooded(countryHeard)) push(countryRoot, 'country');

  // A flooded country is still the prefix for the subdivision row.
  const subRoot = subdivisionRootFor(regionRoot, place, directory);
  if (subRoot) {
    push(subRoot, 'subdivision');
    const cityRoot = cityRootFor(regionRoot, place, directory);
    if (cityRoot) push(cityRoot, 'city');
  }
  return rows;
}

function entryServesUser(
  entry: DirectoryEntry,
  subRoot: string | null,
  userPos?: LatLon,
): boolean {
  if (subRoot && underOrEqual(entry.root, subRoot)) return true;
  if (userPos) {
    const d = haversineKm(userPos, { lat: entry.center[0], lon: entry.center[1] });
    if (d <= entry.radiusKm) return true;
  }
  return false;
}

/**
 * Directory entries under the search region that serve the user's subdivision
 * or whose circle holds the user (R6). They appear even if never heard.
 */
export function buildCommunity(opts: {
  regionRoot: string;
  place?: Place;
  userPos?: LatLon;
  heard: HeardRoot[];
  directory: MqttRootDirectory;
}): CommunityRow[] {
  const { regionRoot, place, userPos, heard, directory } = opts;
  const subRoot = subdivisionRootFor(regionRoot, place, directory);
  const rows: CommunityRow[] = [];
  for (const e of directory.entries) {
    if (!underOrEqual(e.root, regionRoot) || e.root === regionRoot) continue;
    if (!entryServesUser(e, subRoot, userPos)) continue;
    const own = findHeard(heard, e.root);
    rows.push({
      root: e.root,
      name: e.name,
      heard: !!own,
      ...(own ? { nodes: own.nodes, messages: own.messages, floor: own.floor || undefined } : {}),
    });
  }
  return rows;
}

/** Subdivision roots next to the user's, from the directory's neighbor map. */
function neighborRoots(
  regionRoot: string,
  place: Place | undefined,
  directory: MqttRootDirectory,
): string[] {
  if (!place?.cc || !place.subdivisionIso) return [];
  const list = directory.neighbors[place.subdivisionIso.toUpperCase()] ?? [];
  const countryRoot = countryRootFor(regionRoot, place);
  const out: string[] = [];
  for (const iso of list) {
    const seg = sanitizeSegment(iso.split('-').slice(1).join(''));
    if (seg) out.push(`${countryRoot}/${seg}`);
  }
  return out;
}

/**
 * Rank heard roots in three tiers (R7). Within a tier: shallower depth first,
 * then nearest map-reported node, then node count, then message count, then name.
 */
export function rankHeard(opts: {
  regionRoot: string;
  heard: HeardRoot[];
  userPos?: LatLon;
  place?: Place;
  directory: MqttRootDirectory;
}): RankedHeard[] {
  const { regionRoot, heard, userPos, place, directory } = opts;
  const subRoot = subdivisionRootFor(regionRoot, place, directory);
  const cityRoot = cityRootFor(regionRoot, place, directory);
  const neighbors = neighborRoots(regionRoot, place, directory);
  const communityRoots = buildCommunity({ regionRoot, place, userPos, heard: [], directory }).map(
    (c) => c.root,
  );

  const tierOf = (root: string): Tier => {
    if ((subRoot && underOrEqual(root, subRoot)) || (cityRoot && underOrEqual(root, cityRoot))) {
      return 1;
    }
    if (
      communityRoots.some((c) => underOrEqual(root, c)) ||
      neighbors.some((n) => underOrEqual(root, n))
    ) {
      return 2;
    }
    return 3;
  };

  const rows = heard.map((h) => {
    let rawKm: number | undefined;
    if (userPos && h.positions?.length) {
      for (const p of h.positions) {
        const d = haversineKm(userPos, p);
        if (rawKm === undefined || d < rawKm) rawKm = d;
      }
    }
    const ranked: RankedHeard = {
      root: h.root,
      nodes: h.nodes,
      messages: h.messages,
      depth: rootDepth(h.root),
      ...(rawKm !== undefined ? { nearestKm: Math.round(rawKm) } : {}),
      tier: tierOf(h.root),
      retainedOnly: h.retainedOnly,
      floor: isFlooded(h),
    };
    return { ranked, rawKm };
  });

  rows.sort((a, b) => {
    if (a.ranked.tier !== b.ranked.tier) return a.ranked.tier - b.ranked.tier;
    if (a.ranked.depth !== b.ranked.depth) return a.ranked.depth - b.ranked.depth;
    if (a.rawKm !== b.rawKm) {
      if (a.rawKm === undefined) return 1;
      if (b.rawKm === undefined) return -1;
      return a.rawKm - b.rawKm;
    }
    if (a.ranked.nodes !== b.ranked.nodes) return b.ranked.nodes - a.ranked.nodes;
    if (a.ranked.messages !== b.ranked.messages) return b.ranked.messages - a.ranked.messages;
    return a.ranked.root < b.ranked.root ? -1 : a.ranked.root > b.ranked.root ? 1 : 0;
  });
  return rows.map((r) => r.ranked);
}
