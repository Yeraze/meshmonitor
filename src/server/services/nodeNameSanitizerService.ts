/**
 * Node-name anti-spam sanitizer (#6382) — server wiring.
 *
 *  - `reloadNodeNameSanitizer()` reads the four settings once and installs the
 *    compiled rules in the runtime cache. Called at startup and after every
 *    settings save or reset, so ingest never reads settings per packet.
 *  - `installNodeNameLocalResolver()` tells the runtime how to recognise a
 *    source's own node, which is never rewritten.
 *  - `rescanNodeNames()` runs the rules once over every stored `nodes` and
 *    `meshcore_nodes` row (all sources, MQTT ones included), in pages.
 *
 * Sends nothing on air.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import { parseNodeNameSanitizerConfig } from '../../utils/nodeNameSanitizer.js';
import { NODE_NAME_SANITIZE_KEYS } from '../../utils/nodeNameSanitizerConstants.js';
import {
  configureNodeNameSanitizer,
  getActiveNodeNameRules,
  recordNodeNameRewrite,
  sanitizeMeshCoreNodeName,
  sanitizeMeshtasticNames,
  setNodeNameLocalResolver,
} from '../../utils/nodeNameSanitizerRuntime.js';

/** Re-read the settings and rebuild the cached rules. */
export async function reloadNodeNameSanitizer(): Promise<void> {
  const raw: Record<string, string | null> = {};
  for (const key of NODE_NAME_SANITIZE_KEYS) {
    raw[key] = await databaseService.settings.getSetting(key);
  }
  const config = parseNodeNameSanitizerConfig(raw);
  configureNodeNameSanitizer(config);
  logger.debug(`[NodeNameSanitizer] ${config.enabled ? 'enabled' : 'disabled'} (built-ins ${config.builtins ? 'on' : 'off'}, ${config.customPatterns.length} custom pattern(s))`);
}

/** Recognise each source's own node through its live manager. */
export function installNodeNameLocalResolver(registry: SourceManagerRegistry): void {
  setNodeNameLocalResolver((q) => {
    const manager = registry.getManager(q.sourceId);
    if (!manager) return false;
    if (q.protocol === 'meshtastic') {
      const local = manager.getLocalNodeInfo();
      return local !== null && local !== undefined && Number(local.nodeNum) === q.nodeNum;
    }
    if (isMeshCoreManager(manager)) {
      const local = manager.getLocalNode();
      return !!local?.publicKey && local.publicKey.toLowerCase() === q.publicKey.toLowerCase();
    }
    return false;
  });
}

/**
 * The local Meshtastic node number a source last saved (the manager writes
 * it on connect). Covers a source whose manager is offline during a re-scan.
 */
async function savedLocalNodeNum(sourceId: string): Promise<number | null> {
  const key = sourceId && sourceId !== 'default' ? `localNodeNum_${sourceId}` : 'localNodeNum';
  const raw = await databaseService.settings.getSetting(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export interface NodeNameRescanResult {
  scanned: number;
  nodesChanged: number;
  meshcoreNodesChanged: number;
}

const PAGE_SIZE = 500;

/**
 * Run the active rules once over every stored node name. Throws when the
 * feature is off. Our own nodes are skipped.
 */
export async function rescanNodeNames(registry: SourceManagerRegistry): Promise<NodeNameRescanResult> {
  const rules = getActiveNodeNameRules();
  if (!rules) throw new Error('Node-name sanitizer is disabled');

  const result: NodeNameRescanResult = { scanned: 0, nodesChanged: 0, meshcoreNodesChanged: 0 };
  const savedLocal = new Map<string, number | null>();

  // Meshtastic (TCP, Virtual Node and MQTT sources share the `nodes` table).
  let after: { sourceId: string; nodeNum: number } | null = null;
  for (;;) {
    const page = await databaseService.nodes.listNodeNamesPage(after, PAGE_SIZE);
    if (page.length === 0) break;
    for (const row of page) {
      result.scanned++;
      if (!row.longName && !row.shortName) continue;
      const liveLocal = registry.getManager(row.sourceId)?.getLocalNodeInfo();
      if (liveLocal && Number(liveLocal.nodeNum) === row.nodeNum) continue;
      if (!savedLocal.has(row.sourceId)) savedLocal.set(row.sourceId, await savedLocalNodeNum(row.sourceId));
      if (savedLocal.get(row.sourceId) === row.nodeNum) continue;

      const r = sanitizeMeshtasticNames(rules, row.longName, row.shortName);
      if (r.longName === undefined && r.shortName === undefined) continue;
      await databaseService.nodes.setNodeNames(row.nodeNum, row.sourceId, { longName: r.longName, shortName: r.shortName });
      recordNodeNameRewrite('meshtastic', row.sourceId, row.nodeId, r.rule);
      result.nodesChanged++;
    }
    const last = page[page.length - 1];
    after = { sourceId: last.sourceId, nodeNum: last.nodeNum };
    if (page.length < PAGE_SIZE) break;
  }

  // MeshCore (companion, repeater and MeshCore MQTT sources).
  let afterMc: { sourceId: string; publicKey: string } | null = null;
  for (;;) {
    const page = await databaseService.meshcore.listNodeNamesPage(afterMc, PAGE_SIZE);
    if (page.length === 0) break;
    for (const row of page) {
      result.scanned++;
      if (!row.name || row.isLocalNode) continue;
      const manager = registry.getManager(row.sourceId);
      if (manager && isMeshCoreManager(manager)
        && manager.getLocalNode()?.publicKey?.toLowerCase() === row.publicKey.toLowerCase()) continue;

      const r = sanitizeMeshCoreNodeName(rules, row.name);
      if (r.name === undefined) continue;
      await databaseService.meshcore.setNodeName(row.publicKey, row.sourceId, r.name);
      recordNodeNameRewrite('meshcore', row.sourceId, row.publicKey.slice(0, 12), r.rule);
      result.meshcoreNodesChanged++;
    }
    const last = page[page.length - 1];
    afterMc = { sourceId: last.sourceId, publicKey: last.publicKey };
    if (page.length < PAGE_SIZE) break;
  }

  logger.info(`[NodeNameSanitizer] re-scan: ${result.scanned} row(s) scanned, ${result.nodesChanged} Meshtastic and ${result.meshcoreNodesChanged} MeshCore name(s) rewritten`);
  return result;
}
