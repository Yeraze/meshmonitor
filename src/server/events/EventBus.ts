/**
 * EventBus
 *
 * Thin typed multi-plexer layer over `dataEventEmitter` (Layer 1
 * in-process event bus, see `~/projects/nestjs-event-mvp` as reference).
 *
 * Design:
 * - Publishers keep calling `dataEventEmitter.emit*()` — unchanged.
 * - New subscribers register typed handlers via `bus.on(type, handler)`
 *   instead of `dataEventEmitter.on('data', handler)` + manual dispatch.
 * - Existing subscribers (WebSocket, Automation Engine) are NOT migrated
 *   (YAGNI).
 * - Handler errors are caught and logged — a bad subscriber must not
 *   crash the bus or affect other subscribers.
 * - `sourceId` is passed through to handlers (per-source scoping).
 */

import type { EventEmitter } from 'events';
import type {
  DataEvent,
  NodeUpdateData,
  MeshBeaconReceivedData,
  ConnectionStatusData,
  RoutingUpdateData,
  AutoPingUpdateData,
  TelemetryBatchData,
  ClientNotificationData,
} from '../services/dataEventEmitter.js';
import type { DbMessage, DbChannel, DbTraceroute } from '../../services/database.js';
import type { MeshCoreMessage, MeshCoreContact, MeshCoreNode } from '../meshcoreManager.js';
import type { DbMeshCorePacket } from '../../db/repositories/meshcore.js';
import type {
  ReticulumMessageRow,
  ReticulumMessageState,
  ReticulumMessageMethod,
} from '../../db/repositories/reticulum.js';
import { logger } from '../../utils/logger.js';

/**
 * Maps each `DataEventType` to its `DataEvent.data` payload type.
 *
 * Types without a dedicated payload interface (e.g. `waypoint:upserted`)
 * use `unknown` — subscribers cast locally.
 */
export interface DataEventPayloadMap {
  'node:updated': NodeUpdateData;
  'node:mobility': { nodeNum: number; previous: number; current: number };
  'message:new': DbMessage;
  'channel:updated': DbChannel;
  'telemetry:batch': TelemetryBatchData;
  'connection:status': ConnectionStatusData;
  'client-notification': ClientNotificationData;
  'traceroute:complete': DbTraceroute;
  'routing:update': RoutingUpdateData;
  'auto-ping:update': AutoPingUpdateData;
  'waypoint:upserted': unknown;
  'waypoint:deleted': { sourceId: string; waypointId: number };
  'waypoint:expired': { sourceId: string; waypointId: number };
  'meshcore:message': MeshCoreMessage;
  'meshcore:messages:deleted': {
    ids?: string[];
    conversationPublicKey?: string;
    channelIdx?: number;
    all?: boolean;
  };
  'meshcore:message:updated': {
    sourceId: string;
    id: string;
    previousAckCrc?: number;
    expectedAckCrc?: number;
    estTimeout?: number;
    deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed';
  };
  'meshcore:contact:updated': { sourceId: string; contact: MeshCoreContact };
  'meshcore:status:updated': {
    sourceId: string;
    connected: boolean;
    node?: MeshCoreNode | null;
  };
  'meshcore:local-node:updated': { sourceId: string; node: MeshCoreNode };
  'meshcore:send-confirmed': { sourceId: string; ackCode: number; roundTripMs: number };
  'meshcore:channel-heard': {
    sourceId: string;
    id: string;
    heardBy: Array<{ hash: string; name?: string | null; snr?: number | null }>;
  };
  'meshcore:ota-packet': DbMeshCorePacket;
  'meshbeacon:received': MeshBeaconReceivedData;
  'reticulum:message': ReticulumMessageRow;
  'reticulum:delivery-state:updated': {
    sourceId: string;
    id: string;
    hash: string;
    state: ReticulumMessageState;
    method?: ReticulumMessageMethod | null;
    attempts?: number | null;
  };
}

/**
 * Typed multi-plexer over `dataEventEmitter`.
 *
 * The constructor takes the underlying `EventEmitter` (dependency
 * injection) so the bus is testable with a plain `EventEmitter`.
 * Production wiring passes the `dataEventEmitter` singleton
 * (`DataEventEmitter extends EventEmitter` — structurally compatible).
 */
export class EventBus {
  constructor(private readonly emitter: EventEmitter) {}

  /**
   * Register a typed handler for a specific event type.
   *
   * @param type    the `DataEventType` to subscribe to
   * @param handler  receives the typed `data` payload and optional `sourceId`
   * @returns an `off` function to unsubscribe
   */
  on<K extends keyof DataEventPayloadMap>(
    type: K,
    handler: (data: DataEventPayloadMap[K], sourceId?: string) => void,
  ): () => void {
    const listener = (raw: DataEvent): void => {
      if (raw.type !== type) return;
      try {
        handler(raw.data as DataEventPayloadMap[K], raw.sourceId);
      } catch (error) {
        logger.error(`[EventBus] handler for "${String(type)}" threw:`, error);
      }
    };
    this.emitter.on('data', listener);
    return (): void => {
      this.emitter.off('data', listener);
    };
  }
}
