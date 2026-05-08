/**
 * Data Event Emitter Service
 *
 * Central event emitter for real-time mesh data updates.
 * Used by meshtasticManager to emit events that are forwarded
 * via WebSocket to connected clients.
 */

import { EventEmitter } from 'events';
import type { DbNode, DbMessage, DbTelemetry, DbChannel, DbTraceroute } from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export type DataEventType =
  | 'node:updated'
  | 'message:new'
  | 'channel:updated'
  | 'telemetry:batch'
  | 'connection:status'
  | 'traceroute:complete'
  | 'routing:update'
  | 'auto-ping:update'
  | 'waypoint:upserted'
  | 'waypoint:deleted'
  | 'waypoint:expired';

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

class DataEventEmitter extends EventEmitter {
  // Keyed by sourceId (or '__default__') → nodeNum → telemetry list
  private telemetryBuffer: Map<string, Map<number, DbTelemetry[]>> = new Map();
  private batchTimeout: NodeJS.Timeout | null = null;
  private batchIntervalMs: number = 1000; // 1 second batching window

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
   * Force flush any pending telemetry (useful for shutdown)
   */
  flushPending(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.flushTelemetry();
    }
  }
}

// Export singleton instance
export const dataEventEmitter = new DataEventEmitter();
