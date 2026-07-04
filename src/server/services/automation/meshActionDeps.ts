/**
 * Real ActionDeps wiring (#3653, §4) — connects the engine's actions to the live
 * Meshtastic managers and the database.
 *
 * The concrete MeshtasticManager (obtained by casting the ISourceManager from the
 * registry) exposes sendTextMessage + the node-admin senders. Tapbacks reuse
 * sendTextMessage with the emoji flag = 1 and replyId = the triggering packet.
 *
 * `notify` dispatches through appriseNotificationService.notifyDirect (the
 * automation-specific, non-user-filtered path). A failed dispatch throws so the
 * graph evaluator records a failed step in the run-log.
 */
import databaseService from '../../../services/database.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { appriseNotificationService } from '../appriseNotificationService.js';
import { runScript as runUserScript } from '../../utils/scriptRunner.js';
import { logger } from '../../../utils/logger.js';
import type { ActionDeps } from './actionExecutor.js';

interface MeshSendManager {
  sendTextMessage(text: string, channel?: number, destination?: number, replyId?: number, emoji?: number): Promise<number>;
  sendFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendRemoveFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendRemoveIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  // Request/operation senders (#3835).
  sendTelemetryRequest(destination: number, channel?: number, telemetryType?: 'device' | 'environment' | 'airQuality' | 'power'): Promise<unknown>;
  sendPositionRequest(destination: number, channel?: number): Promise<unknown>;
  sendTraceroute(destination: number, channel?: number): Promise<unknown>;
  sendNodeInfoRequest(destination: number, channel?: number): Promise<unknown>;
  sendNeighborInfoRequest(destination: number, channel?: number): Promise<unknown>;
  broadcastNodeInfoToChannel(channel: number): Promise<unknown>;
}

/** MeshCore companion managers send via a different method signature. */
interface MeshCoreSendManager {
  sendMessage(text: string, toPublicKey?: string, channelIdx?: number, scopeOverride?: string | null): Promise<boolean>;
  // Request/operation senders (#3835).
  requestRemoteTelemetry(publicKey: string, timeoutSecs?: number): Promise<unknown>;
  traceContactPath(publicKey: string): Promise<unknown>;
  requestNeighbors(publicKey?: string): Promise<unknown>;
  sendAdvert(): Promise<unknown>;
}

/**
 * Build an actionable error for a sourceId with no live, capable manager
 * registered — distinguishing "never existed / deleted" from "disabled" from
 * "exists but not currently connected" from "wrong protocol for this action".
 * A bare "cannot send messages" gave users nothing to act on when their
 * source list had drifted from a saved automation, e.g. after deleting and
 * recreating a source under a new id (#3915).
 */
async function describeUnusableSource(sourceId: string, raw: unknown, capability: string): Promise<string> {
  if (raw) {
    return `source "${sourceId}" cannot ${capability} (not a Meshtastic or MeshCore manager)`;
  }
  try {
    const source = await databaseService.sources.getSource(sourceId);
    if (!source) {
      return `source "${sourceId}" no longer exists — it may have been deleted or recreated; re-select the source in this automation`;
    }
    if (!source.enabled) {
      return `source "${source.name}" (${sourceId}) is disabled — enable it in Settings > Sources, then this automation can ${capability}`;
    }
    return `source "${source.name}" (${sourceId}) is not currently connected — check its status in Settings > Sources`;
  } catch (err) {
    logger.debug(`[Automation] describeUnusableSource: lookup failed for source "${sourceId}":`, err);
    return `source "${sourceId}" cannot ${capability}`;
  }
}

async function mgr(sourceId: string | null): Promise<MeshSendManager> {
  if (!sourceId) throw new Error('automation action requires a target source');
  const m = sourceManagerRegistry.getManager(sourceId) as unknown as MeshSendManager | undefined;
  if (!m || typeof m.sendTextMessage !== 'function') {
    throw new Error(await describeUnusableSource(sourceId, m, 'send messages'));
  }
  return m;
}

/**
 * Send a channel/DM text message through whichever protocol the source speaks:
 * Meshtastic (`sendTextMessage`) or MeshCore (`sendMessage`). MeshCore has no
 * reply/emoji concept, so those are dropped for that protocol.
 */
async function sendTextVia(
  sourceId: string | null,
  text: string,
  channel: number,
  destination?: number,
  replyId?: number,
  emoji = 0,
  scopeOverride?: string | null,
): Promise<unknown> {
  if (!sourceId) throw new Error('automation action requires a target source');
  const raw = sourceManagerRegistry.getManager(sourceId) as unknown as
    (Partial<MeshSendManager> & Partial<MeshCoreSendManager>) | undefined;
  if (raw && typeof raw.sendTextMessage === 'function') {
    // Meshtastic has no scope/region concept — scopeOverride is dropped.
    return raw.sendTextMessage(text, channel, destination, replyId, emoji);
  }
  if (raw && typeof raw.sendMessage === 'function') {
    // MeshCore: channel send only (DM-by-nodeNum / tapbacks not supported here).
    // `scopeOverride` (#3833) controls which region the message floods to.
    return raw.sendMessage(text, undefined, channel, scopeOverride);
  }
  throw new Error(await describeUnusableSource(sourceId, raw, 'send messages'));
}

export function createMeshActionDeps(): ActionDeps {
  return {
    async sendMessage({ sourceId, text, channel, destination, replyId, scopeOverride }) {
      return sendTextVia(sourceId, text, channel ?? 0, destination, replyId, 0, scopeOverride);
    },

    async sendTapback({ sourceId, emoji, channel, destination, replyId }) {
      // emoji flag = 1 marks a tapback/reaction; route the way the trigger arrived.
      return (await mgr(sourceId)).sendTextMessage(emoji, channel ?? 0, destination, replyId, 1);
    },

    async manageNode({ sourceId, nodeNum, op }) {
      const m = await mgr(sourceId);
      switch (op) {
        case 'favorite': return m.sendFavoriteNode(nodeNum);
        case 'unfavorite': return m.sendRemoveFavoriteNode(nodeNum);
        case 'ignore': return m.sendIgnoredNode(nodeNum);
        case 'unignore': return m.sendRemoveIgnoredNode(nodeNum);
        case 'delete': {
          if (!sourceId) throw new Error('automation delete action requires a target source');
          await databaseService.deleteNodeAsync(nodeNum, sourceId);
          return;
        }
        default:
          throw new Error(`unsupported node op "${op}"`);
      }
    },

    async requestData({ sourceId, op, target, channel, telemetryType }) {
      if (!sourceId) throw new Error('automation action requires a target source');
      const raw = sourceManagerRegistry.getManager(sourceId) as unknown as
        (Partial<MeshSendManager> & Partial<MeshCoreSendManager>) | undefined;
      // Meshtastic: target is a node number.
      if (raw && typeof raw.sendTelemetryRequest === 'function') {
        const dest = Number(target);
        if (op !== 'advert' && !Number.isFinite(dest)) {
          throw new Error(`action.requestData: invalid Meshtastic target "${target}" — expected a node number`);
        }
        switch (op) {
          case 'telemetry': return raw.sendTelemetryRequest!(dest, channel, telemetryType);
          case 'position': return raw.sendPositionRequest!(dest, channel);
          case 'traceroute': return raw.sendTraceroute!(dest, channel);
          case 'nodeinfo': return raw.sendNodeInfoRequest!(dest, channel);
          case 'neighbors': return raw.sendNeighborInfoRequest!(dest, channel);
          case 'advert': return raw.broadcastNodeInfoToChannel!(channel);
          default: throw new Error(`unsupported request op "${op}"`);
        }
      }
      // MeshCore: target is a contact public key.
      if (raw && typeof raw.requestRemoteTelemetry === 'function') {
        const key = String(target);
        switch (op) {
          // MeshCore telemetry has no per-type selection (the contact returns its
          // available LPP records), so `telemetryType` only applies to Meshtastic.
          case 'telemetry': return raw.requestRemoteTelemetry!(key);
          case 'traceroute': return raw.traceContactPath!(key);
          case 'neighbors': return raw.requestNeighbors!(key || undefined);
          case 'advert': return raw.sendAdvert!();
          default: throw new Error(`request op "${op}" not supported on MeshCore`);
        }
      }
      throw new Error(await describeUnusableSource(sourceId, raw, 'perform node requests'));
    },

    async notify({ sourceId, title, body, type, urls }) {
      const r = await appriseNotificationService.notifyDirect({ sourceId, title, body, type }, urls);
      if (!r.ok) throw new Error(`notify failed: ${r.message}`);
      return r;
    },

    async runScript({ scriptPath, env, timeoutMs }) {
      // runUserScript resolves the path under $DATA_DIR/scripts (traversal-safe),
      // picks the interpreter, and never throws — returns { success, ... }.
      return runUserScript({ scriptPath, env, timeoutMs });
    },
  };
}
