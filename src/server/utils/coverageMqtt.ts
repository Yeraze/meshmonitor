/**
 * Coverage Report: MQTT gateway-reception evaluator + recording hook
 * (#5277 P2, §2.6).
 *
 * `evaluateMqttCoverageReception` is a pure function — every skip rule
 * tested without touching a database, so `coverageMqtt.test.ts` exercises
 * each rule directly. `maybeRecordMqttCoverageReception` is the impure
 * wrapper called from `mqttIngestion.ts`'s POSITION case: it adds the
 * per-source opt-in check, the shared receiver-position cache lookup, and
 * the actual `recordReception` write, all wrapped so a failure anywhere in
 * this path NEVER breaks MQTT ingest and NEVER emits on `dataEventEmitter`
 * (mesh-impact checklist §0).
 *
 * See docs/internal/dev-notes/COVERAGE_P2_SPEC.md §2.6 for the full skip
 * rule list and rationale, and §5 Decisions D1-D4.
 */

import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  isStaleCoverageRxTime,
  computeMeshtasticHopsAway,
  meshtasticPathKey,
  nodeNumToId,
} from '../../utils/coverage.js';
import type { RecordCoverageReceptionParams } from '../../db/repositories/coverageReceptions.js';
import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import { isRfTransport } from '../services/packetLogDedup.js';
import { readBitfieldOkToMqtt, parseGatewayNodeNum } from './okToMqtt.js';
import { isOwnNodeNum } from './ownNodes.js';
import { isCoverageMqttEnabled } from '../services/coverageMqttSettings.js';
import { CoverageReceiverPositionCache } from './coverageReceiverPositionCache.js';

export type MqttCoverageSkip =
  | 'no-gateway'
  | 'own-packet'
  | 'local-gateway'
  | 'own-node-gateway'
  | 'non-rf'
  | 'via-mqtt'
  | 'no-signal'
  | 'no-packet-id'
  | 'stale'
  | 'ok-to-mqtt-no'
  | 'ignored-gateway';

/**
 * Fields `evaluateMqttCoverageReception` cannot derive on its own — the
 * fix's actual coordinates/altitude/precision (already resolved upstream by
 * `mqttIngestion.ts`'s POSITION_APP case), the resolved channel, and the
 * insert timestamp.
 */
export type MqttCoverageRow = Omit<
  RecordCoverageReceptionParams,
  | 'receiverLatitude'
  | 'receiverLongitude'
  | 'latitude'
  | 'longitude'
  | 'altitude'
  | 'precisionBits'
  | 'channel'
  | 'receivedAt'
>;

export type MqttCoverageEvalResult =
  | { skip: MqttCoverageSkip }
  | { skip: null; gatewayNum: number; row: MqttCoverageRow };

export interface EvaluateMqttCoverageReceptionInput {
  sourceId: string;
  envelope: ServiceEnvelopeShape;
  fromNum: number;
  /** This source's own gateway node number, or null/undefined when not yet known. */
  localGatewayNodeNum: number | null | undefined;
  nowMs: number;
  /** True when `n` is one of MeshMonitor's own registered radio sources' nodes (D3). */
  isOwnNodeNum: (n: number) => boolean;
  /** True when `n` is on this source's ignore list. */
  isIgnored: (n: number) => boolean;
}

/** Firmware's "no SNR" sentinel (-128) normalizes to null; everything else passes through. */
function normalizeSnr(raw: number | null | undefined): number | null {
  return raw != null && raw !== -128 ? raw : null;
}

/**
 * Pure evaluation of one MQTT ServiceEnvelope reception against the P2 skip
 * rules (§2.6, in order). Returns either the reason it was skipped, or the
 * row to record (missing only the fields the caller already has to hand:
 * coordinates, altitude, precision, channel, receivedAt).
 */
export function evaluateMqttCoverageReception(
  input: EvaluateMqttCoverageReceptionInput,
): MqttCoverageEvalResult {
  const { sourceId, envelope, fromNum, localGatewayNodeNum, nowMs, isOwnNodeNum: ownNodeCheck, isIgnored } = input;
  const packet = envelope.packet ?? {};

  // 1. Gateway id must parse.
  const gatewayNum = parseGatewayNodeNum(envelope.gatewayId);
  if (gatewayNum === null) return { skip: 'no-gateway' };

  // 2. The gateway's own position report.
  if (fromNum === gatewayNum) return { skip: 'own-packet' };

  // 3. Our own publish, echoed back by the broker.
  if (gatewayNum === localGatewayNodeNum) return { skip: 'local-gateway' };

  // 4. Decision D3: a gateway that's one of our OWN radio sources' nodes
  //    already records this reception first-hand via the RF path.
  if (ownNodeCheck(gatewayNum)) return { skip: 'own-node-gateway' };

  // 5. Firmware never uplinks these (MQTT.cpp:743) — belt and braces.
  if ((packet as { viaMqtt?: boolean }).viaMqtt === true) return { skip: 'via-mqtt' };

  // 6. Transport — own-property presence only; a protobufjs prototype
  //    default (0) on an unset field must not count as an explicit LORA.
  const hasOwnTransport = Object.prototype.hasOwnProperty.call(packet, 'transportMechanism');
  const transportMechanism = hasOwnTransport
    ? ((packet as { transportMechanism?: number | null }).transportMechanism ?? null)
    : null;
  if (hasOwnTransport && transportMechanism != null && !isRfTransport(transportMechanism)) {
    return { skip: 'non-rf' };
  }

  // 7. Signal: snr===0 with no rssi at all marks a local/UDP/pre-transport-field
  //    copy. A real 0.0 dB reading WITH rssi present is kept.
  const snr = normalizeSnr((packet as { rxSnr?: number | null }).rxSnr ?? null);
  const rssi = (packet as { rxRssi?: number | null }).rxRssi ?? null;
  if (snr === 0 && rssi == null) return { skip: 'no-signal' };

  // 8. Packet id must be present and non-zero.
  const rawPacketId = (packet as { id?: number | null }).id;
  const packetId = typeof rawPacketId === 'number' ? rawPacketId : null;
  if (!packetId) return { skip: 'no-packet-id' };

  // 9. Decision D1: same 600s stale-replay rule as the RF path.
  const rawRxTime = (packet as { rxTime?: number | null }).rxTime;
  const rxTime = typeof rawRxTime === 'number' ? rawRxTime : null;
  if (isStaleCoverageRxTime(rxTime, nowMs)) return { skip: 'stale' };

  // 10. Decision D4: honour ok_to_mqtt = 0. 'unknown' (encrypted/undecryptable) is recorded.
  const decoded = (packet as { decoded?: { bitfield?: number | null } | null }).decoded;
  const bitfield = typeof decoded?.bitfield === 'number' ? decoded.bitfield : null;
  if (readBitfieldOkToMqtt(bitfield) === 'no') return { skip: 'ok-to-mqtt-no' };

  // 11. Ignored gateway (this source's ignore list).
  if (isIgnored(gatewayNum)) return { skip: 'ignored-gateway' };

  const hopStart = (packet as { hopStart?: number | null }).hopStart ?? null;
  const hopLimit = (packet as { hopLimit?: number | null }).hopLimit ?? null;
  const hasOwnRelayNode = Object.prototype.hasOwnProperty.call(packet, 'relayNode');
  const relayNode = hasOwnRelayNode ? ((packet as { relayNode?: number | null }).relayNode ?? null) : null;
  // Presence, not truthiness: a wire-present bitfield of 0 still counts (D2/§2.4).
  const hasBitfield = typeof decoded?.bitfield === 'number';
  const hopsAway = computeMeshtasticHopsAway({ hopStart, hopLimit, hasBitfield });
  const pathKey = meshtasticPathKey(relayNode, hopsAway);

  const row: MqttCoverageRow = {
    sourceId,
    protocol: 'meshtastic',
    receiverKind: 'mqtt_gateway',
    receiverId: nodeNumToId(gatewayNum),
    receiverNodeNum: gatewayNum,
    senderId: nodeNumToId(fromNum),
    senderNodeNum: fromNum,
    packetKey: String(packetId),
    packetId,
    pathKey,
    snr,
    rssi,
    hopStart,
    hopLimit,
    hopsAway,
    relayNode,
    transportMechanism: hasOwnTransport ? transportMechanism : null,
    rxTime,
  };

  return { skip: null, gatewayNum, row };
}

// Shared across every MQTT source (broker + bridge managers alike) — the
// source is part of the cache key, so this single instance is safe to reuse
// process-wide rather than constructing one per manager (§2.2).
const receiverPositionCache = new CoverageReceiverPositionCache();

/** Test seam — clears the shared position cache between cases. */
export function __resetCoverageMqttPositionCacheForTest(): void {
  receiverPositionCache.clear();
}

export interface MaybeRecordMqttCoverageReceptionInput {
  sourceId: string;
  envelope: ServiceEnvelopeShape;
  fromNum: number;
  localGatewayNodeNum: number | null | undefined;
  lat: number;
  lng: number;
  altitude?: number | null;
  precisionBits?: number | null;
  channel?: number | null;
  nowMs: number;
}

/**
 * Record one MQTT gateway reception of a position packet for the Coverage
 * Report, called non-blocking (`void`) from `mqttIngestion.ts`'s POSITION
 * case — after the geo/ignore/distance gates and only for a non-bogus fix
 * (Decision D2), so Coverage never shows a node the node table refused.
 *
 * Never throws into the ingest path; never emits on `dataEventEmitter`.
 *
 * Order is deliberate (§2.6): the two cheapest possible sync guards
 * (gateway-id parse, own-packet) run FIRST, before the async (though
 * cached) opt-in flag read — most MQTT sources have the flag off, so they
 * should pay for one cached map lookup and nothing more, not the full
 * evaluator (transport/signal/staleness/bitfield/ignored-list checks). The
 * full evaluator re-derives the same two guards; that's cheap, pure, and
 * keeps it self-contained for its own unit tests.
 */
export async function maybeRecordMqttCoverageReception(
  input: MaybeRecordMqttCoverageReceptionInput,
): Promise<void> {
  try {
    const gatewayNum = parseGatewayNodeNum(input.envelope.gatewayId);
    if (gatewayNum === null) return; // no-gateway
    if (input.fromNum === gatewayNum) return; // own-packet

    if (!(await isCoverageMqttEnabled(input.sourceId))) return;

    const evalResult = evaluateMqttCoverageReception({
      sourceId: input.sourceId,
      envelope: input.envelope,
      fromNum: input.fromNum,
      localGatewayNodeNum: input.localGatewayNodeNum,
      nowMs: input.nowMs,
      isOwnNodeNum,
      isIgnored: (n) => databaseService.ignoredNodes.isIgnoredCached(n, input.sourceId),
    });
    if (evalResult.skip !== null) return;

    const pos = await receiverPositionCache.get(input.sourceId, evalResult.gatewayNum);

    await databaseService.coverageReceptions.recordReception({
      ...evalResult.row,
      receiverLatitude: pos.lat,
      receiverLongitude: pos.lon,
      latitude: input.lat,
      longitude: input.lng,
      altitude: input.altitude ?? null,
      precisionBits: input.precisionBits ?? null,
      channel: input.channel ?? null,
      receivedAt: Date.now(),
    });
  } catch (err) {
    logger.debug('📡 Failed to record MQTT Coverage reception (non-fatal):', err);
  }
}
