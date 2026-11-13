/**
 * Node-name anti-spam sanitizer (#6382) — runtime state.
 *
 * The rules are cached here, in one module-level slot, like the
 * `discardInvalidPositions` gate (`positionIngestConfig.ts`): the repositories
 * that write node names have no settings access, and reading settings per
 * packet would cost a query per NodeInfo. The server seeds the cache at
 * startup and reloads it after every settings save.
 *
 * Both repository write seams call into this module:
 *   - `NodesRepository.upsertNode` (Meshtastic: TCP, Virtual Node, MQTT broker
 *     and bridge sources all write through it)
 *   - `MeshCoreRepository.upsertNode` (MeshCore companion, repeater and MQTT)
 *
 * A source's own node is never rewritten. The server registers a resolver
 * that asks the source manager for its local node.
 */
import { logger } from './logger.js';
import {
  type NameSanitizerRules,
  type NodeNameSanitizerConfig,
  buildNameSanitizerRules,
  meshtasticLongNameLimit,
  sanitizeNodeName,
} from './nodeNameSanitizer.js';
import { MESHCORE_NAME_LIMIT, MESHTASTIC_SHORT_NAME_LIMIT, utf8ByteLength } from './nodeNameSanitizerConstants.js';

export type LocalNodeQuery =
  | { protocol: 'meshtastic'; sourceId: string; nodeNum: number }
  | { protocol: 'meshcore'; sourceId: string; publicKey: string };

export type LocalNodeResolver = (q: LocalNodeQuery) => boolean;

interface RuntimeState {
  enabled: boolean;
  rules: NameSanitizerRules | null;
}

let state: RuntimeState = { enabled: false, rules: null };
let localResolver: LocalNodeResolver | null = null;

const stats = {
  total: 0,
  meshtastic: 0,
  meshcore: 0,
  lastHitAt: null as number | null,
};

/** Install a config (startup and after each save). Returns indexes of skipped bad patterns. */
export function configureNodeNameSanitizer(config: NodeNameSanitizerConfig): number[] {
  if (!config.enabled) {
    state = { enabled: false, rules: null };
    return [];
  }
  const { rules, skipped } = buildNameSanitizerRules(config);
  state = { enabled: rules.rules.length > 0, rules };
  if (skipped.length > 0) {
    logger.warn(`[NodeNameSanitizer] skipped ${skipped.length} invalid custom pattern(s): #${skipped.map((i) => i + 1).join(', #')}`);
  }
  return skipped;
}

export function isNodeNameSanitizerActive(): boolean {
  return state.enabled && state.rules !== null;
}

/** The cached rules, or null when the feature is off. */
export function getActiveNodeNameRules(): NameSanitizerRules | null {
  return isNodeNameSanitizerActive() ? state.rules : null;
}

export function setNodeNameLocalResolver(resolver: LocalNodeResolver | null): void {
  localResolver = resolver;
}

function isLocal(q: LocalNodeQuery): boolean {
  if (!localResolver) return false;
  try {
    return localResolver(q);
  } catch {
    // When unsure, do not rewrite: our own node must never be touched.
    return true;
  }
}

/** Count a rewrite and log it with the node id and rule only, never the name. */
export function recordNodeNameRewrite(protocol: 'meshtastic' | 'meshcore', sourceId: string, nodeKey: string, rule: string | null): void {
  stats.total++;
  stats[protocol]++;
  stats.lastHitAt = Date.now();
  logger.debug(`[NodeNameSanitizer] rewrote ${protocol} node ${nodeKey} on ${sourceId} (rule ${rule ?? 'unknown'})`);
}

export function getNodeNameSanitizerStats(): { total: number; meshtastic: number; meshcore: number; lastHitAt: number | null } {
  return { ...stats };
}

/** Sanitize one Meshtastic long/short name pair. Pure apart from no state; used by ingest and re-scan. */
export function sanitizeMeshtasticNames(
  rules: NameSanitizerRules,
  longName: string | null | undefined,
  shortName: string | null | undefined,
): { longName?: string; shortName?: string; rule: string | null } {
  const out: { longName?: string; shortName?: string; rule: string | null } = { rule: null };
  if (typeof longName === 'string' && longName !== '') {
    const r = sanitizeNodeName(longName, rules, { maxBytes: meshtasticLongNameLimit(longName) });
    if (r.changed) { out.longName = r.value; out.rule = r.matchedRule; }
  }
  if (typeof shortName === 'string' && shortName !== '') {
    const r = sanitizeNodeName(shortName, rules, {
      maxBytes: Math.max(MESHTASTIC_SHORT_NAME_LIMIT, utf8ByteLength(shortName)),
    });
    if (r.changed) { out.shortName = r.value; out.rule ??= r.matchedRule; }
  }
  return out;
}

/** Sanitize one MeshCore advert name. */
export function sanitizeMeshCoreNodeName(rules: NameSanitizerRules, name: string | null | undefined): { name?: string; rule: string | null } {
  if (typeof name !== 'string' || name === '') return { rule: null };
  const r = sanitizeNodeName(name, rules, { maxBytes: Math.max(MESHCORE_NAME_LIMIT, utf8ByteLength(name)) });
  return r.changed ? { name: r.value, rule: r.matchedRule } : { rule: null };
}

/**
 * Meshtastic write seam (`NodesRepository.upsertNode`). Returns `nodeData`
 * untouched when the feature is off, the node is ours, or nothing matched.
 */
export function applyMeshtasticNodeNameSanitizer<
  T extends { nodeNum?: number | null; nodeId?: string | null; longName?: string | null; shortName?: string | null },
>(nodeData: T, sourceId: string): T {
  const rules = getActiveNodeNameRules();
  if (!rules) return nodeData;
  if (!nodeData.longName && !nodeData.shortName) return nodeData;
  if (nodeData.nodeNum === undefined || nodeData.nodeNum === null) return nodeData;
  if (isLocal({ protocol: 'meshtastic', sourceId, nodeNum: Number(nodeData.nodeNum) })) return nodeData;

  const r = sanitizeMeshtasticNames(rules, nodeData.longName, nodeData.shortName);
  if (r.longName === undefined && r.shortName === undefined) return nodeData;
  recordNodeNameRewrite('meshtastic', sourceId, nodeData.nodeId ?? String(nodeData.nodeNum), r.rule);
  return {
    ...nodeData,
    ...(r.longName !== undefined ? { longName: r.longName } : {}),
    ...(r.shortName !== undefined ? { shortName: r.shortName } : {}),
  };
}

/**
 * MeshCore write seam (`MeshCoreRepository.upsertNode`). `storedIsLocal` is
 * the existing row's `isLocalNode` flag.
 */
export function applyMeshCoreNodeNameSanitizer<
  T extends { publicKey: string; name?: string | null; isLocalNode?: boolean | null },
>(node: T, sourceId: string, storedIsLocal: boolean): T {
  const rules = getActiveNodeNameRules();
  if (!rules) return node;
  if (!node.name) return node;
  if (storedIsLocal || node.isLocalNode === true) return node;
  if (isLocal({ protocol: 'meshcore', sourceId, publicKey: node.publicKey })) return node;

  const r = sanitizeMeshCoreNodeName(rules, node.name);
  if (r.name === undefined) return node;
  recordNodeNameRewrite('meshcore', sourceId, node.publicKey.slice(0, 12), r.rule);
  return { ...node, name: r.name };
}

/** Test isolation: restore factory state. */
export function __resetNodeNameSanitizerForTest(): void {
  state = { enabled: false, rules: null };
  localResolver = null;
  stats.total = 0;
  stats.meshtastic = 0;
  stats.meshcore = 0;
  stats.lastHitAt = null;
}
