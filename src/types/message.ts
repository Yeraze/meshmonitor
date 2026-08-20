export enum MessageDeliveryState {
  DELIVERED = 'delivered', // Transmitted to mesh by local radio
  CONFIRMED = 'confirmed', // Received by target node (DMs only)
  FAILED = 'failed', // Failed due to routing error
  // undefined = pending (message not yet acknowledged)
}

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
  /**
   * Server-side ingest time (`messages.createdAt`). Always reflects when
   * MeshMonitor actually received the message, independent of the sender
   * node's clock. Prefer this over `timestamp` for sorting / "last
   * message" comparisons — `timestamp` may be wildly wrong when the
   * sending node has bad/uninitialized RTC (issue #3187).
   *
   * Optional only to preserve compat with pre-migration rows that may not
   * have a stored `createdAt`; treat missing values as falling back to
   * `timestamp`.
   */
  receivedAt?: Date;
  acknowledged?: boolean;
  ackFailed?: boolean;
  isLocalMessage?: boolean;
  hopStart?: number;
  hopLimit?: number;
  relayNode?: number; // Last byte of the node that relayed the message
  replyId?: number;
  emoji?: number;
  viaMqtt?: boolean; // Whether message was received via MQTT bridge
  viaStoreForward?: boolean; // Whether message was received via Store & Forward replay
  xeddsaSigned?: boolean; // Broadcast carried a cryptographically verified XEdDSA signature (firmware 2.8+)
  rxSnr?: number; // SNR of received packet (for direct messages)
  rxRssi?: number; // RSSI of received packet (for direct messages)
  // Enhanced delivery tracking
  deliveryState?: MessageDeliveryState;
  wantAck?: boolean; // Whether message requested acknowledgment
  routingErrorReceived?: boolean; // Whether routing error was received
  requestId?: number; // Packet request ID for tracking
  ackFromNode?: number; // Node that sent the routing ACK for this message (#4816)
  routingErrorCode?: number; // Exact numeric Meshtastic RoutingError reason on a failed send (#4816 Phase 2)
  // Decryption source - 'server' means read-only (cannot reply)
  decryptedBy?: 'node' | 'server' | null;
  // Per-message ingress attribution. NULL for pre-migration rows.
  /** Client IP for HTTP-injected sends (honors X-Forwarded-For when trust proxy is configured). */
  sourceIp?: string | null;
  /** Categorical message ingress path. */
  sourcePath?: 'http_api' | 'tcp_radio' | 'mqtt_bridge' | 'system' | null;
  /**
   * Impersonation flag (#2584): the message claims to originate from our own
   * locally-connected node but arrived over RF and wasn't recently sent by us —
   * a likely spoof. Such messages must NOT be rendered as our own outgoing.
   */
  spoofSuspected?: boolean;
}

/**
 * A single row from a message's delivery event timeline (Delivery Diagnostics
 * epic #4816, Phase 3). Mirrors the `message_events` DB row shape
 * (`src/db/repositories/messageEvents.ts`) — one record per real delivery
 * transition, keyed by `(sourceId, messageId)`. Consumed by the Delivery
 * Details modal timeline (WP4) via `ApiService.getMessageEvents`.
 */
export type MessageEventType =
  | 'submitted'
  | 'sent_to_radio'
  | 'delivered'
  | 'confirmed'
  | 'routing_error'
  | 'timeout'
  | 'retry';

export type MessageEventProvenance = 'reported' | 'observed' | 'inferred';

export interface MessageEvent {
  id: number;
  sourceId: string;
  messageId: string;
  eventType: MessageEventType;
  provenance: MessageEventProvenance;
  /** Short JSON string with the relevant keys (routingErrorCode, attempt, …); null when absent. */
  detail?: string | null;
  /** Unix ms the event occurred. */
  timestamp: number;
  /** Row write time (Unix ms). */
  createdAt: number;
}

/**
 * Meshtastic Heard-By entry (Delivery Diagnostics epic #4816, Phase 4 WP3).
 *
 * One row per relay byte that re-flooded our own outgoing channel message and
 * was overheard back by us. `relayByte` is only the last byte of the
 * relaying node's nodeNum (Meshtastic protobuf `relay_node`), so identity is
 * inherently ambiguous — `candidates` lists every node on this source whose
 * `nodeNum & 0xFF` matches, never a single asserted node.
 */
export interface MeshtasticHeardByEntry {
  /** Last byte of the relayer's nodeNum (1-255; 0/unknown rows are never persisted). */
  relayByte: number;
  /** `relayByte` formatted as `0xNN` for display. */
  relayByteHex: string;
  /** SNR observed by us for this re-flood; null when unavailable. */
  snr: number | null;
  /** Unix ms the re-flood was heard. */
  heardAt: number;
  /** Nodes on this source whose `nodeNum & 0xFF` matches `relayByte`. */
  candidates: MeshtasticHeardByCandidate[];
}

export interface MeshtasticHeardByCandidate {
  nodeNum: number;
  longName?: string;
  shortName?: string;
}
