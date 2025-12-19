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
  replyId?: number;
  emoji?: number;
  viaMqtt?: boolean; // Whether message was received via MQTT bridge
  // Enhanced delivery tracking
  deliveryState?: MessageDeliveryState;
  wantAck?: boolean; // Whether message requested acknowledgment
  routingErrorReceived?: boolean; // Whether routing error was received
  requestId?: number; // Packet request ID for tracking
}
