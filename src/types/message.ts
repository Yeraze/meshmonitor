export enum MessageDeliveryState {
  PENDING = 'pending',                    // Message being sent
  TRANSMITTED = 'transmitted',            // Transmitted by local node
  RECEIVED_BY_NODE = 'received_by_node',  // Received by another node (channel messages)
  RECEIVED_BY_TARGET = 'received_by_target', // Received by target node (direct messages)
  FAILED_MAX_RETRIES = 'failed_max_retries', // Failed after maximum retransmissions
  FAILED_ROUTING = 'failed_routing'       // Failed due to routing error
}

export interface MeshMessage {
  id: string
  from: string
  to: string
  fromNodeId: string
  toNodeId: string
  text: string
  channel: number
  portnum?: number
  timestamp: Date
  acknowledged?: boolean
  ackFailed?: boolean
  isLocalMessage?: boolean
  hopStart?: number
  hopLimit?: number
  replyId?: number
  emoji?: number
  // Enhanced delivery tracking
  deliveryState?: MessageDeliveryState
  wantAck?: boolean  // Whether message requested acknowledgment
  routingErrorReceived?: boolean  // Whether routing error was received
  requestId?: number  // Packet request ID for tracking
}