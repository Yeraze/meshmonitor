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
import { waypointService } from '../waypointService.js';
import { isForwardingEnabled, setForwardingEnabled } from '../forwardingStateService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { SendOrigin } from '../../utils/automationPacketTracker.js';
import { type MeshCoreAdvertMode, LEGACY_MESHCORE_ADVERT_MODE } from '../../../types/meshcoreAdvert.js';
import { tracePathScheduleService } from '../tracePathScheduleService.js';
import { TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR } from '../../../types/tracePathSchedule.js';

/**
 * A Meshtastic manager's per-source outgoing queue (meshtasticManager.ts:1107,
 * `public readonly`). The ONLY thing in the app that retries a DM until it is
 * ACKed — the same path Auto-Acknowledge's reply takes (meshtasticManager.ts:
 * 10248). Duck-typed like every other capability check in this file; never
 * `instanceof` (CLAUDE.md).
 */
interface QueuedSendManager {
  messageQueue?: {
    enqueue(
      text: string, destination: number, replyId?: number,
      onSuccess?: () => void, onFailure?: (reason: string) => void,
      channel?: number, maxAttemptsOverride?: number, emoji?: number,
      hopLimitOverride?: number, origin?: SendOrigin,
    ): string;
  };
}

/** Options bag MeshtasticManager.sendTextMessage takes as its 8th argument. */
type SendTextOptions = { hopLimitOverride?: number; origin?: SendOrigin };

/**
 * Every Meshtastic send made here is an Automation Engine action, so it is
 * tagged as automation-originated (#5414) — an MQTT bridge with
 * `dropAutomationUplinks` keeps it off the upstream broker.
 */
const AUTOMATION: { origin: SendOrigin } = { origin: 'automation' };

interface MeshSendManager {
  sendTextMessage(
    text: string, channel?: number, destination?: number, replyId?: number, emoji?: number,
    userId?: number, attribution?: undefined, options?: SendTextOptions,
  ): Promise<number>;
  sendFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendRemoveFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendRemoveIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  // Request/operation senders (#3835).
  sendTelemetryRequest(destination: number, channel?: number, telemetryType?: 'device' | 'environment' | 'airQuality' | 'power', options?: { origin?: SendOrigin }): Promise<unknown>;
  sendPositionRequest(destination: number, channel?: number, options?: { origin?: SendOrigin }): Promise<unknown>;
  sendTraceroute(destination: number, channel?: number, options?: { origin?: SendOrigin }): Promise<unknown>;
  sendNodeInfoRequest(destination: number, channel?: number, options?: { origin?: SendOrigin }): Promise<unknown>;
  sendNeighborInfoRequest(destination: number, channel?: number, options?: { origin?: SendOrigin }): Promise<unknown>;
  broadcastNodeInfoToChannel(channel: number, options?: { origin?: SendOrigin }): Promise<unknown>;
}

/** MeshCore companion managers send via a different method signature. */
interface MeshCoreSendManager {
  sendMessage(text: string, toPublicKey?: string, channelIdx?: number, scopeOverride?: string | null, autoRetryOnMiss?: boolean): Promise<boolean>;
  // Request/operation senders (#3835).
  requestRemoteTelemetry(publicKey: string, timeoutSecs?: number): Promise<unknown>;
  traceContactPath(publicKey: string): Promise<unknown>;
  traceContactPathDetailed(publicKey: string, opts?: { autoReturn?: boolean; hashBytes?: 1 | 2 }): Promise<{ ok: boolean; reason?: string; hops?: unknown[]; lastSnr?: number }>;
  requestNeighbors(publicKey?: string): Promise<unknown>;
  /** Floor-checked advert for automated senders (see MeshCoreManager.sendAutomatedAdvert). */
  sendAutomatedAdvert(mode: MeshCoreAdvertMode, origin: string): Promise<{ sent: boolean; reason?: string }>;
}

/**
 * Resolve the live manager for a source (#3915, unified in WP3b).
 * Both Meshtastic and MeshCore managers are registered in `sourceManagerRegistry`
 * after the one-registry migration; no secondary lookup is needed.
 */
function resolveManager(sourceId: string): unknown | undefined {
  return sourceManagerRegistry.getManager(sourceId);
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
  destination?: number | string,
  replyId?: number,
  emoji = 0,
  scopeOverride?: string | null,
  maxAttempts?: number,
  hopLimitOverride?: number,
): Promise<unknown> {
  if (!sourceId) throw new Error('automation action requires a target source');
  const raw = resolveManager(sourceId) as
    (Partial<MeshSendManager> & Partial<MeshCoreSendManager>) | undefined;
  if (raw && typeof raw.sendTextMessage === 'function') {
    // Meshtastic has no scope/region concept — scopeOverride is dropped.
    const dest = typeof destination === 'number' ? destination : undefined;
    // #4340 Phase 3. Opt-in ONLY: absent maxAttempts, a channel send, or a
    // MeshCore source all take the unchanged direct path below.
    //   * Channel sends are excluded because the queue hardcodes maxAttempts=1
    //     for them (messageQueueService.ts:112) — the parameter would buy
    //     nothing while silently imposing the queue's 30s inter-send throttle
    //     on every channel automation that set it.
    //   * The queue is fire-and-forget: it returns a queue id synchronously, so
    //     this returns a descriptive object instead of a packet id, and a
    //     TX-disabled throw surfaces later in the queue's onFailure rather than
    //     through actionExecutor's pushOrSkipTxDisabled. Both are exactly how
    //     Auto-Acknowledge itself behaves — that IS the parity.
    const q = (raw as QueuedSendManager).messageQueue;
    const sendOptions: SendTextOptions = hopLimitOverride !== undefined
      ? { hopLimitOverride, ...AUTOMATION }
      : { ...AUTOMATION };
    // #5121: a zero-hop send carries no ACK request, so there is nothing for the
    // queue's retry to wait on. It always takes the direct single-send path —
    // maxAttempts is deliberately ignored rather than turned into blind resends.
    if (maxAttempts != null && dest != null && hopLimitOverride !== 0 && typeof q?.enqueue === 'function') {
      const id = q.enqueue(
        text, dest, replyId,
        () => logger.debug(`[Automation] queued DM to !${dest.toString(16).padStart(8, '0')} delivered`),
        (reason: string) => logger.warn(`[Automation] queued DM to !${dest.toString(16).padStart(8, '0')} failed: ${reason}`),
        undefined,             // channel: undefined ⇒ this is a DM
        maxAttempts,
        emoji || undefined,
        hopLimitOverride,
        'automation',
      );
      return { queued: true, messageId: id, maxAttempts };
    }
    return raw.sendTextMessage(text, channel, dest, replyId, emoji, undefined, undefined, sendOptions);
  }
  if (raw && typeof raw.sendMessage === 'function') {
    // MeshCore: `destination`, when a string, is the contact's public key (#4018)
    // — routes as a DM instead of always falling back to a channel broadcast.
    // `scopeOverride` (#3833) controls which region a channel/broadcast send
    // floods to; the caller already omits it for a DM.
    // `sendMessage` resolves `false` (not throw) when the node is disconnected
    // or the send fails — surface that as a thrown error so the run-log records
    // a failed step instead of a silent success.
    // Automation Engine action.sendMessage is an AUTOMATED sender → opt into the
    // channel-send auto-retry (#3979). Inert unless the global opt-in setting is
    // on; user-initiated sends go through the route, not here.
    const toPublicKey = typeof destination === 'string' ? destination : undefined;
    const ok = await raw.sendMessage(text, toPublicKey, channel, scopeOverride, true);
    if (ok === false) {
      throw new Error(`source "${sourceId}" failed to send the MeshCore message (node not connected or send rejected)`);
    }
    return ok;
  }
  throw new Error(`source "${sourceId}" cannot send messages`);
}

export function createMeshActionDeps(): ActionDeps {
  return {
    async sendMessage({ sourceId, text, channel, destination, replyId, scopeOverride, maxAttempts, hopLimitOverride }) {
      return sendTextVia(sourceId, text, channel ?? 0, destination, replyId, 0, scopeOverride, maxAttempts, hopLimitOverride);
    },

    // #5482: the service owns the persisted 30-minute floor, onlyWhenChanged,
    // and the TX-disabled check (it throws TxDisabledError, which the executor
    // records as a skip).
    async broadcastWaypoint(a) {
      return waypointService.upsertAndBroadcastForAutomation(a);
    },

    async sendTapback({ sourceId, emoji, channel, destination, replyId, hopLimitOverride }) {
      // emoji flag = 1 marks a tapback/reaction; route the way the trigger arrived.
      const options: SendTextOptions = hopLimitOverride !== undefined
        ? { hopLimitOverride, ...AUTOMATION }
        : { ...AUTOMATION };
      return mgr(sourceId).sendTextMessage(emoji, channel ?? 0, destination, replyId, 1, undefined, undefined, options);
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
          // Automated cleanups never delete a tracked asset (#5354); only a
          // manual Delete Node can remove it and its retained history.
          if (await databaseService.getAssetNodeAsync(nodeNum)) {
            logger.info(`[Automation] delete skipped for node ${nodeNum}@${sourceId}: node is a tracked asset`);
            return { skipped: true, reason: 'node is a tracked asset' };
          }
          await databaseService.deleteNodeAsync(nodeNum, sourceId);
          return;
        }
        default:
          throw new Error(`unsupported node op "${op}"`);
      }
    },

    async runScheduledTrace({ sourceId, pathKey, path, autoReturn }) {
      const who = path.label ? `${path.label} (${path.publicKey.slice(0, 8)}…)` : `${path.publicKey.slice(0, 16)}…`;
      const raw = resolveManager(sourceId) as Partial<MeshCoreSendManager> | undefined;
      if (!raw || typeof raw.traceContactPathDetailed !== 'function') {
        return { publicKey: path.publicKey, skipped: true, reason: 'source is not a connected MeshCore companion' };
      }
      // Due-time and hourly-cap check, recorded before the send (#5723).
      const claim = await tracePathScheduleService.claim({ sourceId, pathKey, intervalMinutes: path.intervalMinutes });
      if (!claim.due) {
        return claim.reason === 'not_due'
          ? { publicKey: path.publicKey, skipped: true, notDue: true, reason: `${who}: not due until ${new Date(claim.nextDueAt).toISOString()}` }
          // `notDue` marks the step idle for the run log; a capped skip is
          // reported there once an hour (claim.quiet), not on every tick.
          : { publicKey: path.publicKey, skipped: true, ...(claim.quiet ? { notDue: true } : {}), reason: `${who}: this source already sent ${TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR} scheduled traces in the last hour` };
      }
      const outcome = await raw.traceContactPathDetailed(path.publicKey, {
        autoReturn,
        ...(path.hashBytes === 'auto' ? {} : { hashBytes: path.hashBytes }),
      });
      logger.info(`[Automation] scheduled trace to ${who} on ${sourceId}: ${outcome.ok ? `${outcome.hops?.length ?? 0} hop(s)` : (outcome.reason ?? 'failed')}`);
      return outcome.ok
        ? { publicKey: path.publicKey, traced: true, hops: outcome.hops?.length ?? 0, lastSnr: outcome.lastSnr }
        : { publicKey: path.publicKey, traced: false, reason: `${who}: trace ${outcome.reason === 'timeout' ? 'got no reply' : 'could not be sent (no known path, or the hop width could not be applied)'}` };
    },

    async requestData({ sourceId, op, target, channel, telemetryType, advertMode }) {
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
          case 'telemetry': return raw.sendTelemetryRequest!(dest, channel, telemetryType, AUTOMATION);
          case 'position': return raw.sendPositionRequest!(dest, channel, AUTOMATION);
          case 'traceroute': return raw.sendTraceroute!(dest, channel, AUTOMATION);
          case 'nodeinfo': return raw.sendNodeInfoRequest!(dest, channel, AUTOMATION);
          case 'neighbors': return raw.sendNeighborInfoRequest!(dest, channel, AUTOMATION);
          case 'advert': return raw.broadcastNodeInfoToChannel!(channel, AUTOMATION);
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
          case 'advert': {
            // Absent mode = action saved before the field existed → flood (legacy).
            const result = await raw.sendAutomatedAdvert!(advertMode ?? LEGACY_MESHCORE_ADVERT_MODE, 'Automation advert action');
            // Skipped by the flood floor (or failed): fail the step with the reason.
            if (!result.sent) throw new Error(result.reason ?? 'advert failed');
            return result;
          }
          default: throw new Error(`request op "${op}" not supported on MeshCore`);
        }
      }
      throw new Error(`source "${sourceId}" cannot perform node requests`);
    },

    async rebootDevice({ sourceId, seconds, targetNodeNum }) {
      // Reboot the physical device (#3995). Both protocol managers expose a
      // `rebootDevice` method: Meshtastic `rebootDevice(seconds)` (void), MeshCore
      // `rebootDevice()` (Companion-only; resolves `false` on failure / repeater
      // firmware, ignores the seconds arg). Calling with `seconds` is safe for
      // both — MeshCore drops the extra argument.
      if (!sourceId) throw new Error('automation reboot action requires a target source');
      const raw = resolveManager(sourceId) as {
        rebootDevice?: (seconds?: number) => Promise<unknown>;
        sendRebootCommand?: (destinationNodeNum: number, seconds?: number) => Promise<unknown>;
        getLocalNodeInfo?: () => { nodeNum: number } | null;
      } | undefined;

      // #4847: a `targetNodeNum` that names the source's OWN connected node is not
      // a remote-admin request — it's a local reboot the UI happened to fill in.
      // The remote-admin path (`sendRebootCommand`) does a session-passkey handshake
      // that stalls on a directly-connected (e.g. BLE-bridged) node, so the Run Now
      // request hangs and the browser reports "Load failed". Collapse self-targets
      // to the local path, which matches the per-source admin reboot button.
      let effectiveTarget = targetNodeNum;
      if (effectiveTarget != null && typeof raw?.getLocalNodeInfo === 'function') {
        const ownNodeNum = raw.getLocalNodeInfo()?.nodeNum;
        if (ownNodeNum != null && Number(ownNodeNum) === Number(effectiveTarget)) {
          effectiveTarget = undefined;
        }
      }

      // #4126: remote-admin reboot. When a target node is specified, reboot that
      // node over the mesh via the Meshtastic session-passkey admin mechanism
      // (`sendRebootCommand`). This is Meshtastic-only — MeshCore managers have no
      // such method, so a target on a MeshCore source is a clear error.
      if (effectiveTarget != null) {
        if (!raw || typeof raw.sendRebootCommand !== 'function') {
          throw new Error(`source "${sourceId}" cannot send a remote-admin reboot (Meshtastic sources only)`);
        }
        // sendRebootCommand defaults `seconds` to 10 when undefined.
        await (seconds != null ? raw.sendRebootCommand(effectiveTarget, seconds) : raw.sendRebootCommand(effectiveTarget));
        return { rebooted: true, targetNodeNum: effectiveTarget };
      }

      if (!raw || typeof raw.rebootDevice !== 'function') {
        throw new Error(`source "${sourceId}" cannot reboot (no connected device)`);
      }
      const result = await raw.rebootDevice(seconds);
      // Surface an explicit MeshCore `false` as a thrown error so the run-log
      // records a failed step instead of a silent success. Meshtastic returns
      // void (undefined), which is not false → treated as success.
      if (result === false) {
        throw new Error(`source "${sourceId}" failed to reboot (node not connected or unsupported firmware)`);
      }
      return result ?? { rebooted: true };
    },

    async notify({ sourceId, title, body, type, urls }) {
      const r = await appriseNotificationService.notifyDirect({ sourceId, title, body, type }, urls);
      if (!r.ok) throw new Error(`notify failed: ${r.message}`);
      return r;
    },

    // #5537: a per-source settings write. Sends nothing, and never touches the
    // forwarding rate limiter. Skips the write when the state would not change.
    async setSourceForwardingEnabled({ sourceId, mode, enabled }) {
      const source = await databaseService.sources.getSource(sourceId);
      if (!source) return null;
      const previous = await isForwardingEnabled(sourceId);
      const next = mode === 'toggle' ? !previous : Boolean(enabled);
      if (next !== previous) {
        await setForwardingEnabled(sourceId, next);
        logger.info(`[AutomationEngine] forwarding on source "${source.name}" turned ${next ? 'on' : 'off'} by an automation action`);
      }
      return { sourceId, sourceName: source.name, previous, enabled: next };
    },

    async runScript({ scriptPath, scriptArgs, env, timeoutMs }) {
      // runUserScript resolves the path under $DATA_DIR/scripts (traversal-safe),
      // picks the interpreter, and never throws — returns { success, ... }.
      return runUserScript({ scriptPath, scriptArgs, env, timeoutMs });
    },
  };
}
