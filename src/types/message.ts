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
  isLocalMessage?: boolean
  hopStart?: number
  hopLimit?: number
  replyId?: number
  emoji?: number
}