/**
 * API contract for the Coverage Report epic (#5277). Shared by the server
 * routes (WP3, `src/server/routes/coverageRoutes.ts`) and the frontend (WP4,
 * `src/services/analysisApi.ts` / `src/hooks/useCoverageData.ts`) so both
 * sides can be built against the same shape in parallel.
 *
 * These are the wire DTOs returned from `/api/analysis/coverage/*` — richer
 * than the raw `DbCoverageReception` repository row (adds resolved names,
 * `sourceName`, and privacy-gate nulling of receiver/sender coordinates).
 */

/** `exact` matches `hopsAway === N`; `max` matches `hopsAway <= N`. */
export type CoverageHopsMode = 'exact' | 'max';

/** `'meshtastic'` today (P1/P2); `'meshcore'` from P3. */
export type CoverageProtocol = 'meshtastic' | 'meshcore';

/** `'local'` (this source's own radio, P1/P3); `'mqtt_gateway'` from P2. */
export type CoverageReceiverKind = 'local' | 'mqtt_gateway';

/** One RF reception: a single (packet, path, receiver) row. */
export interface CoverageReceptionDto {
  id: number;
  sourceId: string;
  protocol: CoverageProtocol;
  receiverKind: CoverageReceiverKind;
  receiverId: string;
  receiverNodeNum: number | null;
  /** Receiver position snapshot at receive time. Nulled when the receiver fails the visibility gate. */
  receiverLatitude: number | null;
  receiverLongitude: number | null;
  senderId: string;
  senderNodeNum: number | null;
  packetKey: string;
  packetId: number | null;
  pathKey: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  precisionBits: number | null;
  snr: number | null;
  rssi: number | null;
  hopStart: number | null;
  hopLimit: number | null;
  hopsAway: number | null;
  relayNode: number | null;
  transportMechanism: number | null;
  channel: number | null;
  /** Device receive clock, unix seconds. */
  rxTime: number | null;
  /** Server receive time, unix ms. */
  receivedAt: number;
}

/** A distinct receiver seen in the retention window, enriched with a name and current position. */
export interface CoverageReceiverDto {
  sourceId: string;
  sourceName: string;
  protocol: CoverageProtocol;
  receiverKind: CoverageReceiverKind;
  receiverId: string;
  receiverNodeNum: number | null;
  longName: string | null;
  shortName: string | null;
  /** Current node position when known (override-aware), else the latest reception snapshot. Nulled by the visibility gate. */
  latitude: number | null;
  longitude: number | null;
  lastReceivedAt: number;
  /** Reception rows for this receiver in the retention window (#5277 P2 §2.3/§2.4). */
  receptionCount: number;
}

/**
 * Live per-source MQTT gateway-recording status (#5277 P2, user decision
 * Q4), returned alongside `/receivers`. Limited to the MQTT sources the
 * caller can read; found via the typed `isMqttConnectionStatusManager`
 * predicate over the source manager registry, never a `source.type` string
 * gate, and read with `getSettingForSources` (per-source, never the bare
 * `coverage_mqtt_enabled` key — #5080).
 */
export interface CoverageMqttSourceStatusDto {
  sourceId: string;
  sourceName: string;
  recordingEnabled: boolean;
}

/** A distinct sender seen in the window, enriched with a name. */
export interface CoverageSenderDto {
  senderId: string;
  senderNodeNum: number | null;
  longName: string | null;
  shortName: string | null;
  /** Distinct fix count. An upper bound when merged across multiple sources. */
  fixCount: number;
  lastReceivedAt: number;
}

/** Cursor-paginated response shape shared by every paginated coverage endpoint. */
export interface CoveragePage<T> {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}
