/** Shapes of the `/api/unified/messages` feed, shared by the page and the composer. */

import type { MessageDeliveryState } from '../types/message';

export interface Reception {
  sourceId: string;
  sourceName: string;
  /** Source protocol/type, e.g. 'meshtastic_tcp' | 'mqtt_bridge' | 'meshcore'. */
  sourceType?: string;
  hopStart: number | null;
  hopLimit: number | null;
  /** Decoded hop count (MeshCore only; Meshtastic derives from hopStart/hopLimit). */
  hopCount?: number | null;
  rxSnr: number | null;
  rxRssi: number | null;
  rxTime: number | null;
  timestamp: number;
  /** Broadcast carried a verified XEdDSA signature on this reception (firmware 2.8+). */
  xeddsaSigned?: boolean | null;
}

export interface UnifiedMessage {
  dedupKey: string;
  packetId: number | null;
  requestId: number | null;
  fromNodeNum: number;
  fromNodeId: string;
  fromNodeLongName?: string;
  fromNodeShortName?: string;
  toNodeNum: number;
  toNodeId: string;
  channel: number;
  channelName: string;
  text: string;
  emoji: number | null;
  replyId: number | null;
  timestamp: number; // canonical device time (earliest heard) — for display
  createdAt: number; // earliest server DB arrival time — for ordering / pagination cursor (#3122)
  receptions: Reception[];
  /** Non-reaction MeshCore entries: ids other entries' reaction refs point at. */
  meshcoreRowRefs?: string[];
  /** MeshCore reaction entries: `text` is the emoji. */
  reactionEmoji?: string;
  /** Refs of the targeted rows; empty means unmatched. */
  reactionTargetRefs?: string[];
  /** MeshCore DM / channel entry: wire sender second, for the clock offset (#5973).
   *  Its `timestamp` is then the earliest receipt time. */
  senderTimestamp?: number | null;
  /** Meshtastic Data.bitfield bit 2 (#6449): sender flagged it as sent by an automation. */
  isAutomation?: boolean;
  /** Our own sent row (Meshtastic and MQTT-native only): delivery status. */
  deliveryState?: MessageDeliveryState;
  ackFailed?: boolean;
  routingErrorReceived?: boolean;
}
