/**
 * Anonymous-viewer filter for nodes that declined `ok_to_mqtt` (#5156 part 1).
 *
 * A per-source, opt-in setting (`anonHideMqttNoConsent`, default off). When it
 * is on for a source, an ANONYMOUS viewer (no session, or the seeded
 * `anonymous` account that optionalAuth / requirePermission attach) does not
 * see a node of that source, or any of its data, when:
 *
 *   (a) the latest `ok_to_mqtt` bit we read from one of its MQTT-delivered
 *       packets is FALSE (`nodes.mqttOkToMqtt = false`), and
 *   (b) this source has never heard it over direct RF
 *       (`nodes.rfDirectLastHeard IS NULL`).
 *
 * Unknown consent (no bit ever read) shows. Signed-in users are untouched:
 * they see what their grants allow. Embed viewers are always anonymous.
 *
 * Every anonymous-reachable read that returns Meshtastic node data goes
 * through ONE `MqttConsentHiddenSet` built here, so the routes cannot drift:
 * `loadNodeViewAccess` (nodeEnhancer.ts) carries one, `buildPositionFilter`
 * applies one, and the remaining routes call `loadMqttConsentHiddenSet`.
 * Capture lives in mqttConsentCapture.ts; columns in migration 234.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ANON_HIDE_MQTT_NO_CONSENT_SETTING, isAnonHideFlagOn, isMqttConsentFilterSourceType } from '../../utils/mqttConsentFilter.js';

export { ANON_HIDE_MQTT_NO_CONSENT_SETTING, isAnonHideFlagOn };

/** The same anonymous test the rest of the server uses (geojson, coverage surveys, redaction). */
export function isAnonymousViewer(user: { username?: string | null } | null | undefined): boolean {
  return !user || user.username === 'anonymous';
}

/** The hide rule on one node row, before the per-source flag and the viewer are considered. */
export function isMqttConsentWithheld(node: {
  mqttOkToMqtt?: boolean | number | null;
  rfDirectLastHeard?: number | null;
}): boolean {
  const consent = node.mqttOkToMqtt;
  const declined = consent === false || consent === 0;
  return declined && node.rfDirectLastHeard == null;
}

/** The nodes one viewer may not see, keyed by source. */
export interface MqttConsentHiddenSet {
  /** False when nothing is hidden: callers may skip their filter pass. */
  readonly active: boolean;
  /**
   * Is `nodeNum` hidden on `sourceId`? With no source (a row that does not
   * carry one) the node is hidden if any source hides it.
   */
  hides(sourceId: string | null | undefined, nodeNum: number | bigint | string | null | undefined): boolean;
  /**
   * True when every node of `sourceId` is hidden: the set could not be built
   * for that source, so it fails closed. With no source: true when any source
   * is blocked. Callers that aggregate in SQL return nothing for such a source.
   */
  blocksAll(sourceId?: string | null): boolean;
  /**
   * The hidden node numbers on `sourceId` (or on every source when omitted),
   * for repository queries that must exclude them. Meaningless when
   * `blocksAll` is true for that source; check that first.
   */
  nodeNumsFor(sourceId?: string | null): number[];
}

export const NO_HIDDEN_NODES: MqttConsentHiddenSet = {
  active: false,
  hides: () => false,
  blocksAll: () => false,
  nodeNumsFor: () => [],
};

function toNodeNum(value: number | bigint | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const hex = value.startsWith('!') ? value.slice(1) : null;
    const n = hex !== null ? parseInt(hex, 16) : Number(value);
    return Number.isFinite(n) ? n >>> 0 : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n >>> 0 : null;
}

/**
 * Build a set from explicit data. Exported for tests and for callers that
 * already hold the rows. `blocked` lists sources whose every node is hidden
 * (fail closed); `'all'` blocks every source.
 */
export function makeMqttConsentHiddenSet(
  bySource: Map<string, Set<number>>,
  blocked: ReadonlySet<string> | 'all' = new Set(),
): MqttConsentHiddenSet {
  const blockAll = blocked === 'all';
  const blockedSet: ReadonlySet<string> = blocked === 'all' ? new Set() : blocked;
  let any = blockAll || blockedSet.size > 0;
  for (const set of bySource.values()) if (set.size > 0) any = true;
  if (!any) return NO_HIDDEN_NODES;
  const isBlocked = (sourceId: string | null | undefined): boolean =>
    blockAll || (sourceId ? blockedSet.has(sourceId) : blockedSet.size > 0);
  return {
    active: true,
    hides(sourceId, nodeNum) {
      const n = toNodeNum(nodeNum);
      if (n === null) return false;
      if (isBlocked(sourceId)) return true;
      if (sourceId) return bySource.get(sourceId)?.has(n) ?? false;
      for (const set of bySource.values()) if (set.has(n)) return true;
      return false;
    },
    blocksAll: isBlocked,
    nodeNumsFor(sourceId) {
      if (sourceId) return [...(bySource.get(sourceId) ?? [])];
      const all = new Set<number>();
      for (const set of bySource.values()) for (const n of set) all.add(n);
      return [...all];
    },
  };
}

/** Every node of every source hidden: the fail-closed answer when the flags cannot be read. */
export const HIDE_ALL_NODES: MqttConsentHiddenSet = makeMqttConsentHiddenSet(new Map(), 'all');

/**
 * The hidden set for `user`. Not anonymous → nothing hidden, no query. For an
 * anonymous viewer: one sources read, one batched settings read, and one
 * node query per source that has the flag on. `sourceIds` limits the work to
 * the sources the request can return; omit it for every source.
 *
 * FAILS CLOSED (#5156 review): a failed sources or settings read means we
 * cannot tell which sources have the flag on, so every source is treated as
 * flagged and every node is hidden for this request. A failed node read on a
 * flagged source hides every node of that source. Each logs a warning. An
 * empty anonymous view is the price of an error; a leak is not acceptable.
 */
export async function loadMqttConsentHiddenSet(
  user: { username?: string | null } | null | undefined,
  sourceIds?: readonly string[],
): Promise<MqttConsentHiddenSet> {
  if (!isAnonymousViewer(user)) return NO_HIDDEN_NODES;
  let enabled: string[];
  try {
    // Only Meshtastic-family sources carry ok_to_mqtt; the flag on any other
    // source type (set directly through the API) is ignored server-side too.
    const all: Array<{ id: string; type?: string | null }> = await databaseService.sources.getAllSources();
    const wanted = sourceIds ? new Set(sourceIds) : null;
    const ids = all
      .filter((s) => (!wanted || wanted.has(s.id)) && isMqttConsentFilterSourceType(s.type))
      .map((s) => s.id);
    if (ids.length === 0) return NO_HIDDEN_NODES;
    const flags = await databaseService.settings.getSettingForSources(ids, ANON_HIDE_MQTT_NO_CONSENT_SETTING);
    enabled = ids.filter((id) => isAnonHideFlagOn(flags.get(id)));
  } catch (err) {
    logger.warn('MQTT-consent anonymous filter: could not read which sources are flagged; hiding every node from this anonymous request:', err);
    return HIDE_ALL_NODES;
  }
  if (enabled.length === 0) return NO_HIDDEN_NODES;
  const bySource = new Map<string, Set<number>>();
  const blocked = new Set<string>();
  await Promise.all(enabled.map(async (id) => {
    try {
      bySource.set(id, new Set(await databaseService.nodes.getMqttConsentWithheldNodeNums(id)));
    } catch (err) {
      logger.warn(`MQTT-consent anonymous filter: could not read hidden nodes of source ${id}; hiding all of its nodes from this anonymous request:`, err);
      blocked.add(id);
    }
  }));
  return makeMqttConsentHiddenSet(bySource, blocked);
}

/** Parse a traceroute `route` / `routeBack` column (JSON array of node numbers). */
function routeHops(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

/**
 * Does a traceroute row name a hidden node, as either end or any hop? A
 * traceroute through a hidden relay is dropped whole: its hop list and
 * positions would otherwise place the node.
 */
export function tracerouteNamesHiddenNode(
  hidden: MqttConsentHiddenSet,
  sourceId: string | null | undefined,
  row: { fromNodeNum?: unknown; toNodeNum?: unknown; route?: unknown; routeBack?: unknown },
): boolean {
  if (!hidden.active) return false;
  const nums = [row.fromNodeNum, row.toNodeNum, ...routeHops(row.route), ...routeHops(row.routeBack)];
  return nums.some((n) => hidden.hides(sourceId, n as number));
}

/**
 * Drop rows that name a hidden node. `nodesOf` returns every node number (or
 * `!hex` id) the row names; `sourceOf` the row's source (or a fixed one).
 */
export function dropRowsNamingHiddenNodes<T>(
  rows: T[],
  hidden: MqttConsentHiddenSet,
  sourceOf: (row: T) => string | null | undefined,
  nodesOf: (row: T) => Array<number | bigint | string | null | undefined>,
): T[] {
  if (!hidden.active) return rows;
  return rows.filter((row) => {
    const src = sourceOf(row);
    return !nodesOf(row).some((n) => hidden.hides(src, n));
  });
}

/**
 * Drop messages sent by, or addressed to, a hidden node. Works on stored rows
 * (`fromNodeNum` / `toNodeNum`) and client messages (`fromNodeId` /
 * `toNodeId`, `!hex`). A row's own `sourceId` wins over the fallback.
 */
export function dropMessagesNamingHiddenNodes<T>(
  rows: T[],
  hidden: MqttConsentHiddenSet,
  sourceId?: string | null,
): T[] {
  return dropRowsNamingHiddenNodes(
    rows,
    hidden,
    (row) => (row as { sourceId?: string | null }).sourceId ?? sourceId,
    (row) => {
      const r = row as {
        fromNodeNum?: number | null;
        toNodeNum?: number | null;
        fromNodeId?: string | null;
        toNodeId?: string | null;
      };
      return [r.fromNodeNum ?? r.fromNodeId, r.toNodeNum ?? r.toNodeId];
    },
  );
}

/**
 * Drop neighbor-info edges with a hidden node at either end. Rows carry
 * `nodeNum` / `neighborNodeNum` and usually their own `sourceId`.
 */
export function dropNeighborEdgesNamingHiddenNodes<T>(
  rows: T[],
  hidden: MqttConsentHiddenSet,
  sourceId?: string | null,
): T[] {
  return dropRowsNamingHiddenNodes(
    rows,
    hidden,
    (row) => (row as { sourceId?: string | null }).sourceId ?? sourceId,
    (row) => {
      const r = row as { nodeNum?: number | null; neighborNodeNum?: number | null };
      return [r.nodeNum, r.neighborNodeNum];
    },
  );
}

/**
 * Drop Packet Monitor rows sent by, or addressed to, a hidden node. Rows
 * carry `from_node` / `to_node`; `sourceId` per row when present.
 */
export function dropPacketsNamingHiddenNodes<T>(
  rows: T[],
  hidden: MqttConsentHiddenSet,
  sourceId?: string | null,
): T[] {
  return dropRowsNamingHiddenNodes(
    rows,
    hidden,
    (row) => (row as { sourceId?: string | null }).sourceId ?? sourceId,
    (row) => {
      const r = row as { from_node?: number | null; to_node?: number | null };
      return [r.from_node, r.to_node];
    },
  );
}
