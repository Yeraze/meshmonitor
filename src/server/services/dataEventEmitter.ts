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
  | 'auto-ping:update';

export interface DataEvent {
  type: DataEventType;
  data: unknown;
  timestamp: number;
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
  private telemetryBuffer: Map<number, DbTelemetry[]> = new Map();
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
  emitNodeUpdate(nodeNum: number, node: Partial<DbNode>): void {
    const event: DataEvent = {
      type: 'node:updated',
      data: { nodeNum, node } as NodeUpdateData,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Node updated: ${nodeNum}`);
  }

  /**
   * Emit a new message event
   */
  emitNewMessage(message: DbMessage): void {
    const event: DataEvent = {
      type: 'message:new',
      data: message,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] New message from ${message.fromNodeNum}`);
  }

  /**
   * Buffer telemetry for batched emission (reduces WebSocket traffic)
   */
  emitTelemetry(nodeNum: number, telemetry: DbTelemetry): void {
    if (!this.telemetryBuffer.has(nodeNum)) {
      this.telemetryBuffer.set(nodeNum, []);
    }
    this.telemetryBuffer.get(nodeNum)!.push(telemetry);

    // Start batch timer if not already running
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => this.flushTelemetry(), this.batchIntervalMs);
    }
  }

  /**
   * Flush batched telemetry as a single event
   */
  private flushTelemetry(): void {
    if (this.telemetryBuffer.size === 0) {
      this.batchTimeout = null;
      return;
    }

    const batch: TelemetryBatchData = {};
    for (const [nodeNum, telemetryList] of this.telemetryBuffer) {
      batch[nodeNum] = telemetryList;
    }

    this.telemetryBuffer.clear();
    this.batchTimeout = null;

    const event: DataEvent = {
      type: 'telemetry:batch',
      data: batch,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Telemetry batch: ${Object.keys(batch).length} nodes`);
  }

  /**
   * Emit a channel update event
   */
  emitChannelUpdate(channel: DbChannel): void {
    const event: DataEvent = {
      type: 'channel:updated',
      data: channel,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Channel updated: ${channel.id}`);
  }

  /**
   * Emit a connection status change event
   */
  emitConnectionStatus(status: ConnectionStatusData): void {
    const event: DataEvent = {
      type: 'connection:status',
      data: status,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.info(`[DataEventEmitter] Connection status: ${status.connected ? 'connected' : 'disconnected'}`);
  }

  /**
   * Emit a traceroute completion event
   */
  emitTracerouteComplete(traceroute: DbTraceroute): void {
    const event: DataEvent = {
      type: 'traceroute:complete',
      data: traceroute,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Traceroute complete: ${traceroute.fromNodeNum} -> ${traceroute.toNodeNum}`);
  }

  /**
   * Emit a routing update event (ACK/NAK for sent messages)
   */
  emitRoutingUpdate(update: RoutingUpdateData): void {
    const event: DataEvent = {
      type: 'routing:update',
      data: update,
      timestamp: Date.now()
    };
    this.emit('data', event);
    logger.debug(`[DataEventEmitter] Routing update: ${update.requestId} - ${update.status}`);
  }

  /**
   * Emit an auto-ping session update event
   */
  emitAutoPingUpdate(update: AutoPingUpdateData): void {
    const event: DataEvent = {
      type: 'auto-ping:update',
      data: update,
      timestamp: Date.now()
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
