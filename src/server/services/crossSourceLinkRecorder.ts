/**
 * Cross-source "heard here" link recorder (#5561).
 *
 * Folds every live hearing of one of our own radios (source A) by another of
 * our sources (source B) into the hourly `cross_source_links` aggregate that
 * the map's edge layer reads. Called non-blocking (`void`) from three RX
 * paths: the Meshtastic radio path (outside the packet_log gate), MQTT
 * ingest, and the MeshCore OTA / Observer hooks.
 *
 * What counts as an edge (maintainer decision):
 *  - `rf`: B's own radio heard it.
 *  - `mqtt_gateway`: a gateway / observer on source B heard it over ITS radio.
 *  - Broker-delivered MQTT and UDP copies are NOT RF edges: never recorded.
 *  - `origin`: the packet is from A's own node AND was heard directly (0
 *    hops). A multi-hop copy proves A sent it, not that B can hear A, so it
 *    is not an A->B edge.
 *  - `relay`: A most likely relayed it (the last hop's short hash matches A).
 *    Inferred, never unique-checked; every matching source gets the edge.
 *
 * Mesh impact: zero packets, no TX timers, and this module NEVER emits on
 * `dataEventEmitter`. It only writes aggregate rows. Every entry point
 * swallows its own errors: a failure here must never break an RX path.
 *
 * Classification runs through the shared `crossSourceCorrelation` module
 * with an index over EVERY enabled source (ingest is not a per-user view;
 * the two-source permission rule is enforced on read).
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  CrossSourceIndex,
  resolveCrossSourceIndex,
  classifyMeshtasticReception,
  classifyMeshCoreReception,
  prepareMeshCoreReception,
  type CrossSourceTags,
} from './crossSourceCorrelation.js';
import { isRfTransport, isNodeDbReplayForPacketLog } from './packetLogDedup.js';
import { resolveRadioPacketTransport, isViaMqtt } from '../constants/meshtastic.js';
import {
  isStaleCoverageRxTime,
  computeMeshtasticHopsAway,
  computeMeshCoreHopsAway,
  COVERAGE_MAX_RX_AGE_SEC,
  isMeshCorePubKeyId,
} from '../../utils/coverage.js';
import { evaluateMqttCoverageReception } from '../utils/coverageMqtt.js';
import { isOwnNodeNum, isOwnPublicKey } from '../utils/ownNodes.js';
import { LruCache } from '../utils/lruCache.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { calculateMeshCorePacketHash } from './meshcoreObserverPacket.js';
import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import type {
  RecordCrossSourceHearingParams,
} from '../../db/repositories/crossSourceLinks.js';

const nodeNumToId = (n: number): string => `!${(n >>> 0).toString(16).padStart(8, '0')}`;

// ---------------------------------------------------------------------------
// Ingest index (every enabled source), cached
// ---------------------------------------------------------------------------

/** How long the ingest identity index is reused. A newly added source shows up within this. */
const INDEX_TTL_MS = 60_000;
let cachedIndex: { index: CrossSourceIndex; at: number } | null = null;
let indexLoad: Promise<CrossSourceIndex> | null = null;

async function getIngestIndex(nowMs: number): Promise<CrossSourceIndex> {
  if (cachedIndex && nowMs - cachedIndex.at < INDEX_TTL_MS) return cachedIndex.index;
  if (!indexLoad) {
    indexLoad = (async () => {
      try {
        const sources = await databaseService.sources.getAllSources();
        const ids = sources.filter((s) => s.enabled !== false).map((s) => s.id);
        const index = await resolveCrossSourceIndex(ids);
        cachedIndex = { index, at: Date.now() };
        return index;
      } finally {
        indexLoad = null;
      }
    })();
  }
  return indexLoad;
}

// ---------------------------------------------------------------------------
// Dedupe + per-bucket write serialisation
// ---------------------------------------------------------------------------

/** One count per (edge, packet): a packet re-heard via a second path or a replay is not a second hearing. */
const seen = new LruCache<string, true>(20_000);
const writeChains = new Map<string, Promise<void>>();

async function record(hearing: RecordCrossSourceHearingParams, packetKey: string): Promise<void> {
  const edgeKey = `${hearing.txSourceId}|${hearing.txNodeId}|${hearing.rxSourceId}|${hearing.rxNodeId}|${hearing.kind}|${hearing.transportClass}`;
  const dedupeKey = `${edgeKey}|${packetKey}`;
  if (seen.has(dedupeKey)) return;
  seen.set(dedupeKey, true);

  // Serialise read-modify-write per edge so two hearings never lose an update.
  const prev = writeChains.get(edgeKey) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => databaseService.crossSourceLinks.recordHearing(hearing));
  writeChains.set(edgeKey, next);
  try {
    await next;
  } finally {
    if (writeChains.get(edgeKey) === next) writeChains.delete(edgeKey);
  }
}

/** Test seam: forget the cached index, the dedupe set and pending writes. */
export function __resetCrossSourceLinkRecorderForTest(): void {
  cachedIndex = null;
  indexLoad = null;
  seen.clear();
  writeChains.clear();
}

// ---------------------------------------------------------------------------
// Pure: tags -> hearings
// ---------------------------------------------------------------------------

export interface LinkHearingDraft {
  txSourceId: string;
  txNodeId: string;
  kind: 'origin' | 'relay';
}

/**
 * Which edges one classified reception yields. `direct` = heard with 0 hops
 * (required for an origin edge). `nodeIdOf` maps a source to its radio's id.
 */
export function hearingsFromTags(
  tags: CrossSourceTags | null,
  direct: boolean,
  nodeIdOf: (sourceId: string) => string | null,
): LinkHearingDraft[] {
  if (!tags) return [];
  if (tags.transport !== 'rf' && tags.transport !== 'mqtt_gateway') return [];
  const out: LinkHearingDraft[] = [];
  if (tags.originSourceId && direct) {
    const txNodeId = nodeIdOf(tags.originSourceId);
    if (txNodeId) out.push({ txSourceId: tags.originSourceId, txNodeId, kind: 'origin' });
  }
  for (const candidate of tags.likelyRelayCandidates) {
    const txNodeId = nodeIdOf(candidate);
    if (txNodeId) out.push({ txSourceId: candidate, txNodeId, kind: 'relay' });
  }
  return out;
}

const meshtasticNodeIdOf = (index: CrossSourceIndex) => (sourceId: string): string | null => {
  const n = index.nodeNumOf(sourceId);
  return n === null ? null : nodeNumToId(n);
};

// ---------------------------------------------------------------------------
// Meshtastic radio RX path
// ---------------------------------------------------------------------------

export interface MeshtasticLinkPacket {
  from?: number | bigint | null;
  id?: number | bigint | null;
  relayNode?: number | null;
  rxSnr?: number | null;
  rxRssi?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  rxTime?: number | bigint | null;
  viaMqtt?: boolean;
  transportMechanism?: number | null;
  decoded?: { bitfield?: number | null } | null;
}

export interface MaybeRecordMeshtasticLinkInput {
  sourceId: string;
  /** The receiving source's own nodeNum (null until its radio has reported it). */
  localNodeNum: number | null;
  packet: MeshtasticLinkPacket;
  /** Store & Forward replay or a virtual-node-originated packet: not a live hearing. */
  replayed?: boolean;
  nowMs?: number;
}

/** Pure part of the Meshtastic hook: the hearings this packet yields, or [] (with the reason it was skipped). */
export function evaluateMeshtasticLink(
  index: CrossSourceIndex,
  input: MaybeRecordMeshtasticLinkInput,
): { skip: string | null; packetKey: string; hearings: RecordCrossSourceHearingParams[] } {
  const none = (skip: string) => ({ skip, packetKey: '', hearings: [] });
  const nowMs = input.nowMs ?? Date.now();
  const p = input.packet;
  if (input.localNodeNum === null) return none('no-local-node');
  if (input.replayed) return none('replayed');

  const fromNum = p.from ? Number(p.from) : 0;
  if (!fromNum || fromNum === input.localNodeNum) return none('own-packet');

  const viaMqtt = p.viaMqtt === true || isViaMqtt(p.transportMechanism ?? undefined);
  const transport = resolveRadioPacketTransport(p);
  if (viaMqtt || !isRfTransport(transport)) return none('not-rf');

  const packetId = p.id ? Number(p.id) : 0;
  if (!packetId) return none('no-packet-id');

  const rxTimeSec = p.rxTime != null ? Number(p.rxTime) : null;
  if (isStaleCoverageRxTime(rxTimeSec, nowMs)) return none('stale');
  // Firmware 2.8 replays its NodeDB on connect as "LoRa" packets with no RSSI
  // and an old rx_time (#5426). Cached history, not a hearing.
  if (isNodeDbReplayForPacketLog(transport, rxTimeSec, p.rxRssi ?? null, nowMs)) return none('nodedb-replay');

  const hopStart = p.hopStart ?? null;
  const hopLimit = p.hopLimit ?? null;
  const tags = classifyMeshtasticReception(index, {
    sourceId: input.sourceId,
    fromNode: fromNum,
    relayNode: p.relayNode ?? null,
    hopStart,
    hopLimit,
    transportMechanism: transport,
  });
  if (!tags) return none('no-correlation');

  const hopsAway = computeMeshtasticHopsAway({
    hopStart, hopLimit, hasBitfield: typeof p.decoded?.bitfield === 'number',
  });
  const drafts = hearingsFromTags(tags, hopsAway === 0, meshtasticNodeIdOf(index));
  if (drafts.length === 0) return none('not-direct');

  const snr = p.rxSnr != null && p.rxSnr !== -128 ? p.rxSnr : null;
  const rssi = p.rxRssi ?? null;
  return {
    skip: null,
    packetKey: String(packetId),
    hearings: drafts.map((d) => ({
      ...d,
      rxSourceId: input.sourceId,
      rxNodeId: nodeNumToId(input.localNodeNum as number),
      protocol: 'meshtastic' as const,
      transportClass: 'rf' as const,
      snr,
      rssi,
      heardAt: nowMs,
    })),
  };
}

export async function maybeRecordMeshtasticLink(input: MaybeRecordMeshtasticLinkInput): Promise<void> {
  try {
    // Cheapest guards first: most packets are not from one of our radios.
    if (input.localNodeNum === null || input.replayed) return;
    const nowMs = input.nowMs ?? Date.now();
    const index = await getIngestIndex(nowMs);
    if (index.size === 0) return;
    const result = evaluateMeshtasticLink(index, { ...input, nowMs });
    for (const h of result.hearings) await record(h, result.packetKey);
  } catch (err) {
    logger.debug('Cross-source link record (Meshtastic) failed (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// MQTT ingest (a gateway heard it over RF)
// ---------------------------------------------------------------------------

export interface MaybeRecordMqttLinkInput {
  sourceId: string;
  envelope: ServiceEnvelopeShape;
  localGatewayNodeNum: number | null | undefined;
  nowMs?: number;
}

/**
 * Pure part of the MQTT hook. Reuses the Coverage Report's gateway rules
 * (`evaluateMqttCoverageReception`): the gateway id must parse, the copy
 * must be an RF hearing (not via-MQTT, not our own publish, not stale), a
 * gateway that is one of our own radios is skipped (it records first-hand),
 * and `ok_to_mqtt = no` is honoured.
 */
export function evaluateMqttLink(
  index: CrossSourceIndex,
  input: MaybeRecordMqttLinkInput & {
    isOwnNodeNum: (n: number) => boolean;
    isIgnored: (n: number) => boolean;
  },
): { skip: string | null; packetKey: string; hearings: RecordCrossSourceHearingParams[] } {
  const none = (skip: string) => ({ skip, packetKey: '', hearings: [] });
  const nowMs = input.nowMs ?? Date.now();
  const rawFrom = input.envelope.packet?.from;
  if (typeof rawFrom !== 'number') return none('no-from');
  const fromNum = rawFrom >>> 0;

  // Cheap pre-check before the full gateway evaluation: a busy feed carries
  // thousands of packets a minute and almost none involve our own radios.
  const rawRelay = (input.envelope.packet as { relayNode?: number | null }).relayNode;
  const maybeOrigin = index.originForNodeNum(fromNum, input.sourceId) !== null;
  const maybeRelay = typeof rawRelay === 'number' && rawRelay > 0
    && index.relayCandidatesForByte(rawRelay, input.sourceId).length > 0;
  if (!maybeOrigin && !maybeRelay) return none('no-correlation');

  const evalResult = evaluateMqttCoverageReception({
    sourceId: input.sourceId,
    envelope: input.envelope,
    fromNum,
    localGatewayNodeNum: input.localGatewayNodeNum,
    nowMs,
    isOwnNodeNum: input.isOwnNodeNum,
    isIgnored: input.isIgnored,
  });
  if (evalResult.skip !== null) return none(evalResult.skip);
  const row = evalResult.row;

  const tags = classifyMeshtasticReception(index, {
    sourceId: input.sourceId,
    fromNode: fromNum,
    relayNode: row.relayNode,
    hopStart: row.hopStart,
    hopLimit: row.hopLimit,
    transportMechanism: row.transportMechanism,
    receiverKind: 'mqtt_gateway',
    receiverNodeNum: evalResult.gatewayNum,
  });
  if (!tags) return none('no-correlation');
  const drafts = hearingsFromTags(tags, row.hopsAway === 0, meshtasticNodeIdOf(index));
  if (drafts.length === 0) return none('not-direct');

  return {
    skip: null,
    packetKey: row.packetKey,
    hearings: drafts.map((d) => ({
      ...d,
      rxSourceId: input.sourceId,
      rxNodeId: nodeNumToId(evalResult.gatewayNum),
      protocol: 'meshtastic' as const,
      transportClass: 'mqtt_gateway' as const,
      snr: row.snr ?? null,
      rssi: row.rssi ?? null,
      heardAt: nowMs,
    })),
  };
}

export async function maybeRecordMqttLink(input: MaybeRecordMqttLinkInput): Promise<void> {
  try {
    if (typeof input.envelope.packet?.from !== 'number') return;
    const nowMs = input.nowMs ?? Date.now();
    const index = await getIngestIndex(nowMs);
    if (index.size === 0) return;
    const result = evaluateMqttLink(index, {
      ...input,
      nowMs,
      isOwnNodeNum,
      isIgnored: (n) => databaseService.ignoredNodes.isIgnoredCached(n, input.sourceId),
    });
    for (const h of result.hearings) await record(h, result.packetKey);
  } catch (err) {
    logger.debug('Cross-source link record (MQTT) failed (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// MeshCore OTA / Observer
// ---------------------------------------------------------------------------

export interface MaybeRecordMeshCoreLinkInput {
  sourceId: string;
  /** `local` = this source's own companion heard it; `mqtt_gateway` = an Observer did. */
  receiverKind: 'local' | 'mqtt_gateway';
  /** The companion's (local) or Observer's (mqtt_gateway) public key. */
  receiverPubKey: string | null;
  event: { raw_hex?: string | null; snr?: number | null; rssi?: number | null };
  /** Observer feed only: the observer's own capture time, ms. */
  observerTimestampMs?: number | null;
  nowMs?: number;
}

export async function maybeRecordMeshCoreLink(input: MaybeRecordMeshCoreLinkInput): Promise<void> {
  try {
    const nowMs = input.nowMs ?? Date.now();
    const rawHex = input.event.raw_hex;
    const receiver = input.receiverPubKey ? input.receiverPubKey.toLowerCase() : null;
    if (!rawHex || !receiver || !isMeshCorePubKeyId(receiver)) return;
    // An Observer that is one of our own companions records first-hand already.
    if (input.receiverKind === 'mqtt_gateway' && isOwnPublicKey(receiver)) return;
    if (
      input.receiverKind === 'mqtt_gateway' &&
      input.observerTimestampMs != null &&
      nowMs - input.observerTimestampMs > COVERAGE_MAX_RX_AGE_SEC * 1000
    ) return;

    const index = await getIngestIndex(nowMs);
    if (index.size === 0) return;

    const prepared = await prepareMeshCoreReception(index, {
      sourceId: input.sourceId,
      rawHex,
      observerId: input.receiverKind === 'mqtt_gateway' ? receiver : null,
    });
    const tags = classifyMeshCoreReception(index, { ...prepared, relayLastHopOnly: true });
    if (!tags) return;

    const packet = decodeMeshCorePacket(rawHex);
    if (!packet) return;
    const direct = computeMeshCoreHopsAway(packet.header.routeType, packet.path.hopCount) === 0;
    const drafts = hearingsFromTags(tags, direct, (s) => index.publicKeyOf(s));
    if (drafts.length === 0) return;

    const packetKey = calculateMeshCorePacketHash(rawHex);
    for (const d of drafts) {
      await record({
        ...d,
        rxSourceId: input.sourceId,
        rxNodeId: receiver,
        protocol: 'meshcore',
        transportClass: input.receiverKind === 'mqtt_gateway' ? 'mqtt_gateway' : 'rf',
        snr: input.event.snr ?? null,
        rssi: input.event.rssi ?? null,
        heardAt: nowMs,
      }, packetKey);
    }
  } catch (err) {
    logger.debug('Cross-source link record (MeshCore) failed (non-fatal):', err);
  }
}
