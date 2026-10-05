/**
 * Database side of traceroute row orientation: looks up each source's own
 * radio and hands the rows to the pure rule in
 * `src/utils/tracerouteOrientation.ts`.
 *
 * Standalone functions rather than `BaseRepository` methods because
 * `AnalysisRepository` does not extend it. `BaseRepository.orientTracerouteRows`
 * is a thin wrapper over this.
 */
import { inArray } from 'drizzle-orm';
import { localNodeNumSettingKey, legacyLocalNodeNumSettingKey } from '../localNodeNumKey.js';
import { orientTracerouteRow, type OrientableTraceroute } from '../../utils/tracerouteOrientation.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union: the db and table types differ per backend */
type AnyDb = any;
type AnySettingsTable = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Each source's own radio, as persisted by its manager on connect. Sources
 * with no radio (MQTT, MeshCore, never connected) are left out. One indexed
 * `key IN (...)` read however many sources are asked for.
 *
 * Same lookup as `SettingsRepository.getLocalNodeNumForSource`, including the
 * migration-050 fallback key, and like it never falls back from a source to
 * the global key.
 */
export async function localNodeNumsForSources(
  db: AnyDb,
  settings: AnySettingsTable,
  sourceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sourceIds.length === 0) return out;
  const current = new Map<string, string>();
  const legacy = new Map<string, string>();
  for (const id of sourceIds) {
    current.set(localNodeNumSettingKey(id), id);
    legacy.set(legacyLocalNodeNumSettingKey(id), id);
  }
  const rows: Array<{ key: string; value: string | null }> = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...current.keys(), ...legacy.keys()]));
  const read = (keys: Map<string, string>, overwrite: boolean) => {
    for (const row of rows) {
      const id = keys.get(row.key);
      if (id === undefined || (!overwrite && out.has(id))) continue;
      const n = row.value ? Number(row.value) : NaN;
      if (Number.isFinite(n) && n > 0) out.set(id, n);
    }
  };
  read(current, true);
  read(legacy, false);
  return out;
}

/** Raw `traceroutes` rows -> requester-first. Call once per row set. */
export async function orientTracerouteRows<T extends OrientableTraceroute & { sourceId?: string | null }>(
  db: AnyDb,
  settings: AnySettingsTable,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  // A row with no sourceId predates multi-source; its radio is under the bare
  // global key, which is what the empty id resolves to.
  const sourceIds = new Set<string>();
  for (const row of rows) sourceIds.add(row.sourceId ?? '');
  const locals = await localNodeNumsForSources(db, settings, [...sourceIds]);
  return rows.map((row) => orientTracerouteRow(row, locals.get(row.sourceId ?? '')));
}
