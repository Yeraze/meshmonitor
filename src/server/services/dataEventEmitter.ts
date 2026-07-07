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
import { logger } from '../../utils/logger.js';

export type DataEventType =
  | 'node:updated'
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
  | 'meshcore:ota-packet';

export interface DataEvent {
  type: DataEventType;
  data: unknown;
  timestamp: number;
  sourceId?: string;
}

export interface NodeUpdateData {
  nodeNum: number;
  node: Partial<DbNode>;
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
  emitNodeUpdate(nodeNum: number, node: Partial<DbNode>, sourceId?: string): void {
    const event: DataEvent = {
      type: 'node:updated',
      data: { nodeNum, node } as NodeUpdateData,
      timestamp: Date.now(),
      sourceId,
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node updated: ${nodeNum}`);
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
