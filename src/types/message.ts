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
  rxSnr?: number; // SNR of received packet (for direct messages)
  rxRssi?: number; // RSSI of received packet (for direct messages)
  // Enhanced delivery tracking
  deliveryState?: MessageDeliveryState;
  wantAck?: boolean; // Whether message requested acknowledgment
  routingErrorReceived?: boolean; // Whether routing error was received
  requestId?: number; // Packet request ID for tracking
  // Decryption source - 'server' means read-only (cannot reply)
  decryptedBy?: 'node' | 'server' | null;
  // Per-message ingress attribution. NULL for pre-migration rows.
  /** Client IP for HTTP-injected sends (honors X-Forwarded-For when trust proxy is configured). */
  sourceIp?: string | null;
  /** Categorical message ingress path. */
  sourcePath?: 'http_api' | 'tcp_radio' | 'mqtt_bridge' | 'system' | null;
}
