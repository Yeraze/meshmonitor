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
import { meshcoreManagerRegistry } from '../../meshcoreRegistry.js';
import { appriseNotificationService } from '../appriseNotificationService.js';
import { runScript as runUserScript } from '../../utils/scriptRunner.js';
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
  sendMessage(text: string, toPublicKey?: string, channelIdx?: number, scopeOverride?: string | null, autoRetryOnMiss?: boolean): Promise<boolean>;
  // Request/operation senders (#3835).
  requestRemoteTelemetry(publicKey: string, timeoutSecs?: number): Promise<unknown>;
  traceContactPath(publicKey: string): Promise<unknown>;
  requestNeighbors(publicKey?: string): Promise<unknown>;
  sendAdvert(): Promise<unknown>;
}

/**
 * Resolve the live manager for a source across BOTH registries (#3915).
 * Meshtastic managers live in `sourceManagerRegistry`; MeshCore managers live
 * in the separate `meshcoreManagerRegistry`. Automation actions must consult
 * both — otherwise every action targeting a MeshCore source fails with
 * "cannot send messages", because a MeshCore manager is never present in
 * `sourceManagerRegistry` no matter how healthy/connected the source is.
 */
function resolveManager(sourceId: string): unknown | undefined {
  return sourceManagerRegistry.getManager(sourceId) ?? meshcoreManagerRegistry.get(sourceId);
}

function mgr(sourceId: string | null): MeshSendManager {
  if (!sourceId) throw new Error('automation action requires a target source');
  const m = resolveManager(sourceId) as MeshSendManager | undefined;
  if (!m || typeof m.sendTextMessage !== 'function') {
    throw new Error(`source "${sourceId}" cannot send messages (not a Meshtastic manager)`);
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
  const raw = resolveManager(sourceId) as
    (Partial<MeshSendManager> & Partial<MeshCoreSendManager>) | undefined;
  if (raw && typeof raw.sendTextMessage === 'function') {
    // Meshtastic has no scope/region concept — scopeOverride is dropped.
    return raw.sendTextMessage(text, channel, destination, replyId, emoji);
  }
  if (raw && typeof raw.sendMessage === 'function') {
    // MeshCore: channel send only (DM-by-nodeNum / tapbacks not supported here).
    // `scopeOverride` (#3833) controls which region the message floods to.
    // `sendMessage` resolves `false` (not throw) when the node is disconnected
    // or the send fails — surface that as a thrown error so the run-log records
    // a failed step instead of a silent success.
    // Automation Engine action.sendMessage is an AUTOMATED sender → opt into the
    // channel-send auto-retry (#3979). Inert unless the global opt-in setting is
    // on; user-initiated sends go through the route, not here.
    const ok = await raw.sendMessage(text, undefined, channel, scopeOverride, true);
    if (ok === false) {
      throw new Error(`source "${sourceId}" failed to send the MeshCore message (node not connected or send rejected)`);
    }
    return ok;
  }
  throw new Error(`source "${sourceId}" cannot send messages`);
}

export function createMeshActionDeps(): ActionDeps {
  return {
    async sendMessage({ sourceId, text, channel, destination, replyId, scopeOverride }) {
      return sendTextVia(sourceId, text, channel ?? 0, destination, replyId, 0, scopeOverride);
    },

    async sendTapback({ sourceId, emoji, channel, destination, replyId }) {
      // emoji flag = 1 marks a tapback/reaction; route the way the trigger arrived.
      return mgr(sourceId).sendTextMessage(emoji, channel ?? 0, destination, replyId, 1);
    },

    async manageNode({ sourceId, nodeNum, op }) {
      const m = mgr(sourceId);
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
      const raw = resolveManager(sourceId) as
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
      throw new Error(`source "${sourceId}" cannot perform node requests`);
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
