/**
 * Typed per-source accessors for the ten Node Display settings (#4412 Phase 2
 * WP1). Every caller across the backend resolves these values through this
 * module instead of hand-rolling `parseInt(raw) || 24`-style parsing at each
 * call site — that duplication (a dozen call sites, ten literals) is the
 * problem WP1 exists to fix.
 *
 * Must not import `src/services/database.ts` — `database.ts` needs to import
 * *this* module (WP3, `database.maxNodeAge.perSource.test.ts`), so the
 * dependency can only point one way. Uses the `ManagerSettingsDb` structural-
 * subset pattern from `applyManagerSettings.ts` for the same reason.
 */
import {
  NODE_DISPLAY_NUMERIC_DEFAULTS,
  parseNodeDisplayNumber,
  parseNodeDisplayBoolean,
  parseTxTargetMaxAgeHoursWhenUnlimited,
  resolveTxTargetMaxAgeHours,
  type NodeDisplayNumericKey,
  type NodeDisplayBooleanKey,
} from '../../constants/nodeDisplayDefaults.js';

/**
 * Structural subset of the settings repository. Mirrors ManagerSettingsDb
 * (applyManagerSettings.ts) — deliberately does NOT import databaseService,
 * so src/services/database.ts can import this module without a cycle.
 * Satisfied by `databaseService.settings` and by `this.settings` inside
 * DatabaseService.
 */
export interface NodeDisplaySettingsReader {
  getSettingForSource(sourceId: string | null | undefined, key: string): Promise<string | null>;
}

/** Adds the batched read used by the unified-dashboard fan-out only. */
export interface NodeDisplayBatchReader extends NodeDisplaySettingsReader {
  getSettingForSources(sourceIds: string[], key: string): Promise<Map<string, string>>;
}

export async function getNodeDisplayNumber(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
  key: NodeDisplayNumericKey,
): Promise<number> {
  const raw = await reader.getSettingForSource(sourceId, key);
  return parseNodeDisplayNumber(key, raw);
}

export async function getNodeDisplayBoolean(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
  key: NodeDisplayBooleanKey,
): Promise<boolean> {
  const raw = await reader.getSettingForSource(sourceId, key);
  return parseNodeDisplayBoolean(key, raw);
}

/** Convenience: getNodeDisplayNumber(reader, sourceId, 'maxNodeAgeHours'). */
export async function getMaxNodeAgeHours(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<number> {
  return getNodeDisplayNumber(reader, sourceId, 'maxNodeAgeHours');
}

/**
 * Batched: ONE query for many sources. Every requested id is present in the
 * returned Map (missing rows are filled with the hardcoded default), so callers
 * never need a per-source follow-up read. Empty input → empty Map, no query.
 */
export async function getMaxNodeAgeHoursForSources(
  reader: NodeDisplayBatchReader,
  sourceIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (sourceIds.length === 0) return result;

  const raw = await reader.getSettingForSources(sourceIds, 'maxNodeAgeHours');
  for (const id of sourceIds) {
    result.set(id, parseNodeDisplayNumber('maxNodeAgeHours', raw.get(id) ?? null));
  }
  return result;
}

/**
 * Age window (hours, always > 0) for jobs that choose nodes to TRANSMIT to
 * (auto-traceroute, remote-admin scanner, remote LocalStats). Equals
 * `maxNodeAgeHours`, except when that is 0 ("unlimited", #5376): then the
 * per-source `txTargetMaxAgeHoursWhenUnlimited` bound applies, so an unlimited
 * display window never widens the TX target set to every node ever heard.
 */
export async function getTxTargetMaxAgeHours(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<number> {
  const maxNodeAgeHours = await getMaxNodeAgeHours(reader, sourceId);
  if (maxNodeAgeHours > 0) return maxNodeAgeHours;
  const raw = await reader.getSettingForSource(sourceId, 'txTargetMaxAgeHoursWhenUnlimited');
  return resolveTxTargetMaxAgeHours(maxNodeAgeHours, parseTxTargetMaxAgeHoursWhenUnlimited(raw));
}

export interface InactiveNodeConfig {
  thresholdHours: number;
  checkIntervalMinutes: number;
  cooldownHours: number;
}

/** All three inactive-node keys for one source, in one Promise.all. */
export async function getInactiveNodeConfig(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<InactiveNodeConfig> {
  const [thresholdHours, checkIntervalMinutes, cooldownHours] = await Promise.all([
    getNodeDisplayNumber(reader, sourceId, 'inactiveNodeThresholdHours'),
    getNodeDisplayNumber(reader, sourceId, 'inactiveNodeCheckIntervalMinutes'),
    getNodeDisplayNumber(reader, sourceId, 'inactiveNodeCooldownHours'),
  ]);
  return { thresholdHours, checkIntervalMinutes, cooldownHours };
}

export async function getLocalStatsIntervalMinutes(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<number> {
  return getNodeDisplayNumber(reader, sourceId, 'localStatsIntervalMinutes');
}

// Re-exported so call sites that only need the numeric default (e.g. a
// migration-parity test) don't have to import the constants module directly.
export { NODE_DISPLAY_NUMERIC_DEFAULTS };
