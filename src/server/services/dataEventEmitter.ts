/**
 * Data Event Emitter Service
 *
 * Central event emitter for real-time mesh data updates.
 * Used by meshtasticManager to emit events that are forwarded
 * via WebSocket to connected clients.
 */

import { EventEmitter } from 'events';
import type { DbNode, DbMessage, DbTelemetry, DbChannel, DbTraceroute } from '../../services/database.js';
import type { MeshCoreMessage, MeshCoreContact, MeshCoreNode } from '../meshcoreManager.js';
import type { DbMeshCorePacket } from '../../db/repositories/meshcore.js';
import type {
  ReticulumMessageRow,
  ReticulumMessageState,
  ReticulumMessageMethod,
} from '../../db/repositories/reticulum.js';
import { logger } from '../../utils/logger.js';

export type DataEventType =
  | 'node:updated'
  | 'node:discovered'
  | 'meshcore:node:changed'
  | 'node:mobility'
  | 'node:rebooted'
  | 'node:powerChanged'
  | 'node:aircraft'
  | 'message:new'
  | 'channel:updated'
  | 'telemetry:batch'
  | 'connection:status'
  | 'client-notification'
  | 'traceroute:complete'
  | 'routing:update'
  | 'auto-ping:update'
  | 'waypoint:upserted'
  | 'waypoint:deleted'
  | 'waypoint:expired'
  | 'meshcore:message'
  | 'meshcore:messages:deleted'
  | 'meshcore:message:updated'
  | 'meshcore:contact:updated'
  | 'meshcore:status:updated'
  | 'meshcore:local-node:updated'
  | 'meshcore:send-confirmed'
  | 'meshcore:channel-heard'
  | 'meshcore:channels:reordered'
  | 'meshcore:filters:changed'
  | 'meshcore:ota-packet'
  | 'meshbeacon:received'
  | 'reticulum:message'
  | 'reticulum:delivery-state:updated';

export interface DataEvent {
  type: DataEventType;
  data: unknown;
  timestamp: number;
  sourceId?: string;
}

export interface NodeUpdateData {
  nodeNum: number;
  node: Partial<DbNode>;
  /**
   * The received Meshtastic MeshPacket id (unsigned 32-bit) that produced this
   * update (#5534). Absent when the update has no single originating packet
   * (device NodeDB sync, manual edits, key-repair bookkeeping).
   */
  packetId?: number;
  /**
   * MeshCore packet hash (16 UPPERCASE hex) of the frame that produced this
   * update (#5534). Same format as `trigger.message`'s packetHash (#5357).
   */
  packetHash?: string;
  /**
   * True when the same packet also produced a `node:discovered` event (#5534).
   * The automation engine fires trigger.nodeDiscovered for it and skips
   * trigger.nodeUpdated, so one packet never fires both.
   */
  discovered?: boolean;
}

/** Optional originating-packet identity threaded through a node update (#5534). */
export interface NodeUpdateOrigin {
  packetId?: number;
  packetHash?: string;
  /** See {@link NodeUpdateData.discovered}. */
  discovered?: boolean;
}

/**
 * MeshCore contact facts carried on node:discovered and meshcore:node:changed
 * (#5595), so automation templates can render them. MeshCore has no node number,
 * so `{{ node.* }}` hydration cannot supply these.
 */
export interface MeshCoreNodeEventFacts {
  /** Advert type: 1 Companion, 2 Repeater, 3 Room Server, 4 Sensor; 0 unknown. */
  advType?: number;
  /**
   * Relays the advert FRAME that caused this event crossed (0 = heard direct).
   * Undefined when no raw advert frame caused it. Never the cached route length.
   */
  hops?: number;
  /** Hop count of the cached forwarding route to the node; undefined = flood. */
  routeHops?: number;
  /** When this source last heard the node, epoch MILLISECONDS. */
  lastHeard?: number;
}

/**
 * A node heard live for the first time on a source (#5534) — no row existed
 * for it there. Meshtastic sets `nodeNum`; MeshCore sets `publicKey` (and
 * `nodeNum: null`). Device NodeDB / contact-list syncs never raise this.
 */
export interface NodeDiscoveredData extends MeshCoreNodeEventFacts {
  nodeNum: number | null;
  publicKey?: string;
  /** MeshCore display name, when known. */
  name?: string;
  packetId?: number;
  packetHash?: string;
}

/**
 * A known MeshCore node changed a field that matters to automations (#5534):
 * name, position, node type, or path. Re-adverts that change nothing never
 * raise this.
 */
export interface MeshCoreNodeChangedData extends MeshCoreNodeEventFacts {
  publicKey: string;
  name?: string;
  changed: string[];
  packetHash?: string;
}

/**
 * A decoded MESH_BEACON_APP packet (firmware 2.8+, #3854). The offered channel
 * / region / preset are what the beacon advertises; firmware never applies them
 * automatically, so they are informational for automations.
 */
export interface MeshBeaconReceivedData {
  nodeNum: number;
  message: string;
  offerChannelName?: string;
  /**
   * Base64 PSK for the offered channel — SECRET, and deliberately not exposed
   * to automation templates (see `buildMeshBeaconContext`). Present so the
   * offer can actually be accepted server-side; a channel name without its key
   * decrypts nothing.
   */
  offerChannelPsk?: string;
  /** Normalized: `RegionCode.UNSET` (0) arrives as undefined, not 0. */
  offerRegion?: number;
  /** Preset 0 (LONG_FAST) is a real value — `offer_preset` has explicit presence. */
  offerPreset?: number;
}

/**
 * A detected node reboot (Device Health #4558 Phase B) — the node's uptime
 * counter reset. Carries the prior and new uptime so `trigger.nodeRebooted`
 * automations can report the drop. Not stored anywhere; this event is the only
 * way a rule sees the reboot.
 *
 * Meshtastic reboots carry a real `nodeNum` (`publicKey` null/undefined).
 * MeshCore reboots (#4558 follow-up) have NO real Meshtastic node number — only
 * a synthetic one derived from the pubkey — so they set `nodeNum: null` and
 * carry the MeshCore `publicKey` as the subject identity instead.
 */
export interface NodeRebootedData {
  nodeNum: number | null;
  publicKey?: string | null;
  previousUptimeSeconds: number;
  uptimeSeconds: number;
}

/**
 * A detected node power-source transition (Device Health #4558 Phase C) — the
 * node crossed between external/USB power and battery power, derived from its
 * `batteryLevel` telemetry (firmware convention: > 100 = powered). Carries the
 * prior and new powered-states plus the new battery reading so
 * `trigger.nodePowerChanged` automations can report which way it flipped. Not
 * stored anywhere; this event is the only way a rule sees the transition.
 */
export interface NodePowerChangedData {
  /** Meshtastic node number, or `null` for a MeshCore node (identified by
   *  `publicKey` instead — #4558 MeshCore parity). */
  nodeNum: number | null;
  /** MeshCore public key when `nodeNum` is null; absent/null for Meshtastic. */
  publicKey?: string | null;
  previousPowered: boolean;
  powered: boolean;
  /** The new battery reading: percent for Meshtastic, millivolts for MeshCore
   *  (the MeshCore path is a voltage heuristic — see poweredState.ts). */
  batteryLevel: number;
}

/**
 * A node's transition INTO the likely-aircraft flagged state (#5364/#5365,
 * decision D9) — backs `trigger.becameLikelyAircraft`. Only raised for
 * `reason: 'position'` classification jobs when `previous !== true && current
 * === true`; backfill and settings recomputes are silent (D6/D9/D11), so this
 * is the only path that fires the automation event.
 */
export interface NodeAircraftData {
  nodeNum: number;
  /** The persisted flag before this update (read from the DB row, not memory). */
  previous: boolean | null;
  current: true;
  basis: 'agl' | 'msl';
  /** Meters MSL used for the classification. */
  altitude: number;
  groundElevation: number | null;
  heightAboveGround: number | null;
  /** The threshold that was crossed (AGL or MSL, matching `basis`). */
  thresholdM: number;
  latitude: number | null;
  longitude: number | null;
}

export interface ConnectionStatusData {
  connected: boolean;
  nodeNum?: number;
  nodeId?: string;
  reason?: string;
}

export interface RoutingUpdateData {
  requestId: number;
  status: 'ack' | 'nak' | 'error';
  errorReason?: string;
  fromNodeNum?: number;
}

export interface AutoPingUpdateData {
  requestedBy: number;
  requestedByName?: string;
  totalPings: number;
  completedPings: number;
  successfulPings: number;
  failedPings: number;
  startTime: number;
  status: 'started' | 'ping_result' | 'completed' | 'cancelled';
  results: Array<{ pingNum: number; status: 'ack' | 'nak' | 'timeout'; durationMs?: number; sentAt: number }>;
}

export interface TelemetryBatchData {
  [nodeNum: number]: DbTelemetry[];
}

export interface ClientNotificationData {
  /** LogRecord.Level numeric value (WARNING=30, ERROR=40, …). */
  level: number;
  message: string;
  replyId?: number;
  time?: number;
}

class DataEventEmitter extends EventEmitter {
  // Keyed by sourceId (or '__default__') → nodeNum → telemetry list
  private telemetryBuffer: Map<string, Map<number, DbTelemetry[]>> = new Map();
  private batchTimeout: NodeJS.Timeout | null = null;
  private batchIntervalMs: number = 1000; // 1 second batching window

  // Keyed by sourceId → publicKey → contact (latest wins within window)
  private contactBuffer: Map<string, Map<string, MeshCoreContact>> = new Map();
  private contactBatchTimeout: NodeJS.Timeout | null = null;

  constructor() {
    super();
    // Increase max listeners to avoid warnings with many WebSocket clients
    this.setMaxListeners(100);
  }

  /**
   * Emit a node update event
   */
  emitNodeUpdate(nodeNum: number, node: Partial<DbNode>, sourceId?: string, origin?: NodeUpdateOrigin): void {
    const data: NodeUpdateData = { nodeNum, node };
    // #5534: only attach origin keys that are present, so an update with no
    // originating packet keeps the exact `{ nodeNum, node }` payload shape.
    // A Meshtastic packet id of 0 means "no id", so it is treated as absent.
    const packetId = Number(origin?.packetId);
    if (Number.isFinite(packetId) && packetId !== 0) data.packetId = packetId >>> 0;
    if (origin?.packetHash) data.packetHash = origin.packetHash;
    if (origin?.discovered) data.discovered = true;
    const event: DataEvent = {
      type: 'node:updated',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node updated: ${nodeNum}`);
  }

  /**
   * Emit a first-heard node (#5534). Feeds trigger.nodeDiscovered.
   */
  emitNodeDiscovered(data: NodeDiscoveredData, sourceId?: string): void {
    const payload: NodeDiscoveredData = { nodeNum: data.nodeNum };
    if (data.publicKey) payload.publicKey = data.publicKey;
    if (data.name) payload.name = data.name;
    const packetId = Number(data.packetId);
    if (Number.isFinite(packetId) && packetId !== 0) payload.packetId = packetId >>> 0;
    if (data.packetHash) payload.packetHash = data.packetHash;
    // #5595 MeshCore contact facts. 0 is a real value for hops / routeHops.
    if (data.advType != null) payload.advType = data.advType;
    if (data.hops != null) payload.hops = data.hops;
    if (data.routeHops != null) payload.routeHops = data.routeHops;
    if (data.lastHeard != null) payload.lastHeard = data.lastHeard;
    this.emit('data', { type: 'node:discovered', data: payload, timestamp: Date.now(), sourceId } as DataEvent);
    logger.debug(`[DataEventEmitter] Node discovered: ${data.nodeNum ?? data.publicKey}`);
  }

  /**
   * Emit a meaningful MeshCore node change (#5534). Feeds trigger.nodeUpdated.
   */
  emitMeshCoreNodeChanged(data: MeshCoreNodeChangedData, sourceId?: string): void {
    this.emit('data', { type: 'meshcore:node:changed', data, timestamp: Date.now(), sourceId } as DataEvent);
  }

  /**
   * Emit a mobility flag transition (used by trigger.becameMobile).
   */
  emitNodeMobility(
    nodeNum: number,
    previous: number,
    current: number,
    sourceId?: string,
  ): void {
    const event: DataEvent = {
      type: 'node:mobility',
      data: { nodeNum, previous, current },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node mobility: ${nodeNum} ${previous}→${current}`);
  }

  /**
   * Emit a node reboot event (used by trigger.nodeRebooted, #4558 Phase B).
   * Raised by the telemetry-save seam when a node's uptime counter resets.
   */
  emitNodeRebooted(data: NodeRebootedData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'node:rebooted',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node rebooted: ${data.nodeNum ?? data.publicKey ?? '?'} (uptime ${data.previousUptimeSeconds}s → ${data.uptimeSeconds}s)`);
  }

  /**
   * Emit a node power-source transition event (used by trigger.nodePowerChanged,
   * #4558 Phase C). Raised by the telemetry-save seam when a node's batteryLevel
   * reading crosses the firmware's powered threshold (> 100) in either direction.
   */
  emitNodePowerChanged(data: NodePowerChangedData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'node:powerChanged',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node power changed: ${data.nodeNum ?? data.publicKey ?? '?'} (powered ${data.previousPowered} → ${data.powered}, battery ${data.batteryLevel})`);
  }

  /**
   * Emit a likely-aircraft transition event (used by
   * trigger.becameLikelyAircraft, #5364/#5365). Raised by the aircraft
   * classification service only for `reason: 'position'` jobs on a
   * `previous !== true -> current === true` transition — never for a silent
   * backfill or settings recompute. Deliberately does NOT also emit
   * `node:updated` (D10): that feeds `trigger.nodeUpdated` and the
   * node-back-online recovery check, and a classifier write is not that kind
   * of activity.
   */
  emitNodeAircraft(data: NodeAircraftData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'node:aircraft',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node likely aircraft: ${data.nodeNum} (${data.basis}, ${data.heightAboveGround ?? data.altitude}m, threshold ${data.thresholdM}m)`);
  }

  /**
   * Emit a new message event
   */
  emitNewMessage(message: DbMessage, sourceId?: string): void {
    const event: DataEvent = {
      type: 'message:new',
      data: message,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] New message from ${message.fromNodeNum}`);
  }

  /**
   * Buffer telemetry for batched emission (reduces WebSocket traffic)
   */
  emitTelemetry(nodeNum: number, telemetry: DbTelemetry, sourceId?: string): void {
    const key = sourceId ?? '__default__';
    if (!this.telemetryBuffer.has(key)) {
      this.telemetryBuffer.set(key, new Map());
    }
    const sourceBuffer = this.telemetryBuffer.get(key)!;
    if (!sourceBuffer.has(nodeNum)) {
      sourceBuffer.set(nodeNum, []);
    }
    sourceBuffer.get(nodeNum)!.push(telemetry);

    // Start batch timer if not already running
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => this.flushTelemetry(), this.batchIntervalMs);
    }
  }

  /**
   * Flush batched telemetry as a single event per source
   */
  private flushTelemetry(): void {
    if (this.telemetryBuffer.size === 0) {
      this.batchTimeout = null;
      return;
    }

    for (const [key, sourceBuffer] of this.telemetryBuffer) {
      const batch: TelemetryBatchData = {};
      for (const [nodeNum, telemetryList] of sourceBuffer) {
        batch[nodeNum] = telemetryList;
      }
      const event: DataEvent = {
        type: 'telemetry:batch',
        data: batch,
        timestamp: Date.now(),
        sourceId: key === '__default__' ? undefined : key,
      };
      this.emit('data', event);
      logger.debug(`[DataEventEmitter] Telemetry batch: ${Object.keys(batch).length} nodes (source: ${key})`);
    }

    this.telemetryBuffer.clear();
    this.batchTimeout = null;
  }

  /**
   * Emit a channel update event
   */
  emitChannelUpdate(channel: DbChannel, sourceId?: string): void {
    const event: DataEvent = {
      type: 'channel:updated',
      data: channel,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Channel updated: ${channel.id}`);
  }

  /**
   * Emit a connection status change event
   */
  emitConnectionStatus(status: ConnectionStatusData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'connection:status',
      data: status,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.info(`[DataEventEmitter] Connection status: ${status.connected ? 'connected' : 'disconnected'}`);
  }

  /**
   * Emit a client notification event (a warning/info message from the connected
   * node about its own operation). Forwarded to the UI as a toast. Per-source
   * scoped so multi-source clients only see their joined node's notifications.
   */
  emitClientNotification(data: ClientNotificationData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'client-notification',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.info(`[DataEventEmitter] Client notification (level ${data.level}): ${data.message}`);
  }

  /**
   * Emit a received MeshBeacon (firmware 2.8+, #3854). Consumed by the
   * Automation Engine to fire `trigger.meshBeacon`. Beacons are not stored as
   * messages, so this event is the only way a rule can see one.
   */
  emitMeshBeaconReceived(data: MeshBeaconReceivedData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'meshbeacon:received',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshBeacon from ${data.nodeNum}`);
  }

  /**
   * Emit a traceroute completion event
   */
  emitTracerouteComplete(traceroute: DbTraceroute, sourceId?: string): void {
    const event: DataEvent = {
      type: 'traceroute:complete',
      data: traceroute,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Traceroute complete: ${traceroute.fromNodeNum} -> ${traceroute.toNodeNum}`);
  }

  /**
   * Emit a routing update event (ACK/NAK for sent messages)
   */
  emitRoutingUpdate(update: RoutingUpdateData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'routing:update',
      data: update,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Routing update: ${update.requestId} - ${update.status}`);
  }

  /**
   * Emit a waypoint upserted (created or updated) event
   */
  emitWaypointUpserted(waypoint: unknown, sourceId?: string): void {
    const event: DataEvent = {
      type: 'waypoint:upserted',
      data: waypoint,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Waypoint upserted (source: ${sourceId ?? 'unknown'})`);
  }

  /**
   * Emit a waypoint deleted event. `data` carries `{ sourceId, waypointId }`.
   */
  emitWaypointDeleted(payload: { sourceId: string; waypointId: number }, sourceId?: string): void {
    const event: DataEvent = {
      type: 'waypoint:deleted',
      data: payload,
      timestamp: Date.now(),
      sourceId: sourceId ?? payload.sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Waypoint deleted: ${payload.waypointId} (source: ${event.sourceId})`);
  }

  /**
   * Emit a waypoint expired event (sweep removed a stale row).
   */
  emitWaypointExpired(payload: { sourceId: string; waypointId: number }, sourceId?: string): void {
    const event: DataEvent = {
      type: 'waypoint:expired',
      data: payload,
      timestamp: Date.now(),
      sourceId: sourceId ?? payload.sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Waypoint expired: ${payload.waypointId} (source: ${event.sourceId})`);
  }

  /**
   * Emit an auto-ping session update event
   */
  emitAutoPingUpdate(update: AutoPingUpdateData, sourceId?: string): void {
    const event: DataEvent = {
      type: 'auto-ping:update',
      data: update,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Auto-ping update: ${update.requestedBy} - ${update.status} (${update.completedPings}/${update.totalPings})`);
  }

  /**
   * Emit a MeshCore message event
   */
  emitMeshCoreMessage(message: MeshCoreMessage, sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:message',
      data: message,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore message from ${message.fromPublicKey}`);
  }

  /**
   * Emit a MeshCore message-deletion event (#3981) so connected clients prune
   * the deleted messages from their view. The payload describes the deletion
   * scope; the client applies the same match locally (single ids, a whole DM
   * conversation, a channel index, or every message for the source). The event
   * is source-room-filtered by the socket layer, so the payload carries no
   * sourceId (mirroring emitMeshCoreMessage).
   */
  emitMeshCoreMessagesDeleted(
    data: { ids?: string[]; conversationPublicKey?: string; channelIdx?: number; all?: boolean },
    sourceId: string,
  ): void {
    const event: DataEvent = {
      type: 'meshcore:messages:deleted',
      data,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore messages deleted (source ${sourceId})`);
  }

  /**
   * Emit a MeshCore DM delivery-tracking update for an existing message (#3977).
   * Fired as the ack-timeout retry state machine re-sends a DM: it re-points the
   * message's tracked `expectedAckCrc`/`estTimeout` to the latest attempt (so the
   * single bubble keeps resolving on the current CRC) or marks it `failed` once
   * all retries are exhausted. `previousAckCrc` lets the client cancel the fail
   * timer it armed for the prior attempt's CRC.
   */
  emitMeshCoreMessageUpdated(
    data: {
      id: string;
      previousAckCrc?: number;
      expectedAckCrc?: number;
      estTimeout?: number;
      deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed';
      /** User resends so far (#5512). */
      resendCount?: number;
      /** When (ms) the latest resend went out (#5512). */
      lastResendAt?: number;
      /** Whether the #3979 auto-retry is still armed (#5512). */
      autoRetryPending?: boolean;
    },
    sourceId: string,
  ): void {
    const event: DataEvent = {
      type: 'meshcore:message:updated',
      data: { sourceId, ...data },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore message updated: ${data.id} (status=${data.deliveryStatus ?? 'sent'})`);
  }

  /**
   * Buffer a MeshCore contact update for batched emission (1s window)
   */
  emitMeshCoreContactUpdated(contact: MeshCoreContact, sourceId: string): void {
    if (!this.contactBuffer.has(sourceId)) {
      this.contactBuffer.set(sourceId, new Map());
    }
    this.contactBuffer.get(sourceId)!.set(contact.publicKey, contact);

    if (!this.contactBatchTimeout) {
      this.contactBatchTimeout = setTimeout(() => this.flushContacts(), this.batchIntervalMs);
    }
  }

  /**
   * Flush buffered contact updates
   */
  private flushContacts(): void {
    for (const [sourceId, contacts] of this.contactBuffer) {
      for (const contact of contacts.values()) {
        const event: DataEvent = {
          type: 'meshcore:contact:updated',
          data: { sourceId, contact },
          timestamp: Date.now(),
          sourceId,
        };
        this.emit('data', event);
      }
      logger.debug(`[DataEventEmitter] MeshCore contacts flushed: ${contacts.size} (source: ${sourceId})`);
    }
    this.contactBuffer.clear();
    this.contactBatchTimeout = null;
  }

  /**
   * Emit a MeshCore status update event (connected/disconnected)
   */
  emitMeshCoreStatusUpdated(data: { connected: boolean; node?: MeshCoreNode | null }, sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:status:updated',
      data: { sourceId, ...data },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore status: ${data.connected ? 'connected' : 'disconnected'} (source: ${sourceId})`);
  }

  /**
   * Emit a MeshCore send-confirmed event (message ACK with round-trip time)
   */
  emitMeshCoreSendConfirmed(data: { ackCode: number; roundTripMs: number }, sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:send-confirmed',
      data: { sourceId, ...data },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore send confirmed: RTT=${data.roundTripMs}ms (source: ${sourceId})`);
  }

  /**
   * Emit a MeshCore channel "heard repeaters" update (#3700). Fired
   * incrementally as repeaters re-flood an outgoing channel message and we
   * correlate the self-echo; carries the current full heard-by set for the
   * message so the client can replace its state idempotently.
   */
  emitMeshCoreChannelHeard(
    data: { id: string; heardBy: Array<{ hash: string; name?: string | null; snr?: number | null }> },
    sourceId: string,
  ): void {
    const event: DataEvent = {
      type: 'meshcore:channel-heard',
      data: { sourceId, ...data },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore channel heard: msg=${data.id} count=${data.heardBy.length} (source: ${sourceId})`);
  }

  /**
   * Emit a MeshCore on-device channel reorder (#5379). `moves` is the full
   * slot permutation the server applied to stored rows; clients remap any
   * `channel-<idx>`-keyed state they hold (messages, unread markers) and
   * reload the channel list.
   */
  emitMeshCoreChannelsReordered(data: { moves: Array<{ from: number; to: number }> }, sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:channels:reordered',
      data: { sourceId, ...data },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore channels reordered: ${data.moves.length} move(s) (source: ${sourceId})`);
  }

  /**
   * Emit a MeshCore Ignore / Block list change (#5408). Ignored state is
   * computed at read time, so open views reload their messages and hide or
   * re-show nodes when this fires.
   */
  emitMeshCoreFiltersChanged(sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:filters:changed',
      data: { sourceId },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
  }

  /**
   * Emit a MeshCore OTA packet event for the Packet Monitor. Fires once per
   * received OTA packet when capture is enabled; room-scoped by sourceId.
   */
  emitMeshCoreOtaPacket(packet: DbMeshCorePacket, sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:ota-packet',
      data: packet,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
  }

  /**
   * Emit a MeshCore local-node update event
   */
  emitMeshCoreLocalNodeUpdated(node: MeshCoreNode, sourceId: string): void {
    const event: DataEvent = {
      type: 'meshcore:local-node:updated',
      data: { sourceId, node },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] MeshCore local node updated (source: ${sourceId})`);
  }

  /**
   * Emit a Reticulum LXMF message event (#3960 Phase 2 WP3). Fired by
   * `ReticulumManager.handleLxmfMessage` for INBOUND (non-self) messages only
   * — the manager's cross-source self-origin guard (mirrors `utils/ownNodes.ts`
   * #3914) skips this call entirely for a row whose `fromHash` is one of
   * MeshMonitor's own LXMF destinations, so this event doubles as both the UI
   * update AND the automation `trigger.message` source for genuinely received
   * messages. Our own outbound sends get their UI update via
   * `emitReticulumDeliveryStateUpdated` instead (driven by `sendMessage`/
   * `delivery_state`), never via this event.
   */
  emitReticulumMessage(row: ReticulumMessageRow, sourceId: string): void {
    const event: DataEvent = {
      type: 'reticulum:message',
      data: row,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Reticulum message from ${row.fromHash} (source: ${sourceId})`);
  }

  /**
   * Emit a Reticulum LXMF delivery-state transition (#3960 Phase 2 WP3) — a
   * UI-only update (delivery chips: sending/sent/delivered/failed) for a
   * message we sent. Not consumed as an automation trigger: a state change on
   * our own outbound message is inherently self-originated, so it never fires
   * `trigger.message` (the self-origin guard for inbound receipt lives on
   * {@link emitReticulumMessage} instead).
   */
  emitReticulumDeliveryStateUpdated(
    data: {
      id: string;
      hash: string;
      state: ReticulumMessageState;
      method?: ReticulumMessageMethod | null;
      attempts?: number | null;
    },
    sourceId: string,
  ): void {
    const event: DataEvent = {
      type: 'reticulum:delivery-state:updated',
      data: { sourceId, ...data },
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Reticulum delivery state: ${data.hash} -> ${data.state} (source: ${sourceId})`);
  }

  /**
   * Force flush any pending telemetry (useful for shutdown)
   */
  flushPending(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.flushTelemetry();
    }
    if (this.contactBatchTimeout) {
      clearTimeout(this.contactBatchTimeout);
      this.flushContacts();
    }
  }
}

// Export singleton instance
export const dataEventEmitter = new DataEventEmitter();
