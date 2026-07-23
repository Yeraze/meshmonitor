/**
 * Frontend view-model types for the MQTT Packet Monitor.
 *
 * Mirrored (not imported) from the server-side repository types in
 * `src/db/repositories/mqttPacketLog.ts`. That module imports `drizzle-orm`
 * and `BaseRepository` at runtime and cannot be bundled for the browser, so
 * this file re-declares the view-model subset the frontend actually renders.
 * Keep these structurally identical to the repo interfaces — a Phase 1
 * `*.test.ts` pins the server shapes; if they drift, the mismatch surfaces
 * at runtime (see MQTT_PACKET_MONITOR_PHASE2_SPEC.md §9.2).
 */

export type MqttIngestOutcome =
  | 'ingested'
  | 'encrypted'
  | 'ignored'
  | 'geo-ignored'
  | 'distance'
  | 'unsupported-portnum'
  | 'decode-error';

export interface MqttGroupedPacket {
  packetId: number | null;
  fromNode: number | null;
  fromNodeId: string | null;
  toNode: number | null;
  toNodeId: string | null;
  channel: number | null;
  channelId: string | null;
  portnum: number | null;
  portnumName: string | null;
  encrypted: number;
  ingestOutcome: string;
  payloadSize: number | null;
  payloadPreview: string | null;
  gatewayCount: number;
  receptionCount: number;
  firstHeard: number;
  lastHeard: number;
}

export interface MqttGateway {
  gatewayId: string;
  gatewayNodeNum: number | null;
  receptionCount: number;
  lastHeard: number;
}

/** Subset of DbMqttPacket the receptions table renders. */
export interface MqttReception {
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  timestamp: number;
  rxTime: number | null;
  rxSnr: number | null;
  rxRssi: number | null;
  hopLimit: number | null;
  hopStart: number | null;
}
