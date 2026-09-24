/**
 * Coverage Report: MeshCore ADVERT reception evaluator + recording hook
 * (#5277 P3, §2.2).
 *
 * `evaluateMeshCoreCoverageReception` is a pure function — every skip rule
 * tested without touching a database or the network, so
 * `coverageMeshCore.test.ts` exercises each rule directly.
 * `maybeRecordMeshCoreCoverageReception` is the impure wrapper called from
 * both the companion `ota_packet` hook (`meshcoreManager.ts`) and the
 * Observer MQTT hook (`meshcoreMqttManager.ts`): it adds the Ed25519
 * signature check, the clock-free replay guard, the receiver-position
 * lookup and the actual `recordReception` write, all wrapped so a failure
 * anywhere in this path NEVER breaks the OTA or MQTT stream and NEVER emits
 * on `dataEventEmitter` (mesh-impact checklist §0 — MeshMonitor sends
 * nothing for this feature).
 *
 * See docs/internal/dev-notes/COVERAGE_P3_SPEC.md §2.2 and §5 (Decisions
 * D1-D11) for the full rationale.
 */

import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  MESHCORE_PAYLOAD_ADVERT,
  COVERAGE_MAX_RX_AGE_SEC,
  computeMeshCoreHopsAway,
  meshcorePathKey,
  isMeshCorePubKeyId,
} from '../../utils/coverage.js';
import { decodeMeshCorePacket, type DecodedAdvert } from '../../utils/meshcorePacketDecode.js';
import { calculateMeshCorePacketHash } from '../services/meshcoreObserverPacket.js';
import { shouldDiscardPosition } from '../../utils/nullIsland.js';
import { getDiscardInvalidPositions } from '../../utils/positionIngestConfig.js';
import { isOwnPublicKey as defaultIsOwnPublicKey } from './ownNodes.js';
import { LruCache } from './lruCache.js';
import { CoverageReceiverPositionCache, type ReceiverPos } from './coverageReceiverPositionCache.js';
import type { RecordCoverageReceptionParams } from '../../db/repositories/coverageReceptions.js';
// Named export, already a dependency (package.json, `@michaelhart/meshcore-decoder`
// ^0.3.0) and already imported elsewhere in this codebase
// (`meshcoreMqttManager.ts` uses `ChannelCrypto` from the same package). No
// new dependency (U3, #5277).
import { Ed25519SignatureVerifier } from '@michaelhart/meshcore-decoder';

/** `Packet::calculatePacketHash`'s failure sentinel (reference parity). Not exported by its source module. */
const MESHCORE_PACKET_HASH_SENTINEL = '0000000000000000';

export type MeshCoreCoverageSkip =
  | 'not-advert'
  | 'no-receiver'
  | 'decode-failed'
  | 'no-position'
  | 'bogus-position'
  | 'own-advert'
  | 'own-observer'
  | 'no-signal'
  | 'no-hash'
  | 'stale'
  | 'replay';
// 'bad-signature' is added by the async record function (the check is async).

/**
 * The minimal shape both the companion `ota_packet` bridge event and the
 * decoded MQTT Observer event structurally satisfy. Deliberately loose
 * (mirrors `MeshCoreBridgeOtaPacket`'s relevant fields) so both callers can
 * pass their native shape without an adapter.
 */
export interface MeshCoreBridgeOtaPacketLike {
  payload_type?: number;
  route_type?: number;
  snr?: number | null;
  rssi?: number | null;
  raw_hex?: string | null;
}

/**
 * Fields `evaluateMeshCoreCoverageReception` cannot derive on its own — the
 * fix's actual coordinates (the advert's lat/lon, already validated by the
 * evaluator but assembled into the row by the async wrapper alongside the
 * receiver's position), and the insert timestamp. Mirrors P2's
 * `MqttCoverageRow` Omit shape.
 */
export type MeshCoreCoverageRow = Omit<
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

export type MeshCoreCoverageEvalResult =
  | { skip: MeshCoreCoverageSkip }
  | { skip: null; advert: DecodedAdvert; row: MeshCoreCoverageRow };

export interface EvaluateMeshCoreCoverageReceptionInput {
  sourceId: string;
  receiverKind: 'local' | 'mqtt_gateway';
  /** Lowercased by the caller. */
  receiverPubKey: string | null;
  event: MeshCoreBridgeOtaPacketLike;
  /** Observer feed only (D4). The observer's own claimed capture time, ms. */
  observerTimestampMs?: number | null;
  nowMs: number;
  /** True when `k` is one of MeshMonitor's own registered MeshCore companions (D5). */
  isOwnPublicKey: (k: string) => boolean;
  discardNullIsland: boolean;
}

/**
 * Pure evaluation of one MeshCore OTA/Observer reception against the P3 skip
 * rules (§2.2, in order). Returns either the reason it was skipped, or the
 * decoded advert plus the row to record (missing only the fields the async
 * wrapper resolves after this: the signature check, the replay guard, and
 * the receiver's coordinates).
 */
export function evaluateMeshCoreCoverageReception(
  input: EvaluateMeshCoreCoverageReceptionInput,
): MeshCoreCoverageEvalResult {
  const { sourceId, receiverKind, event, observerTimestampMs, nowMs, isOwnPublicKey, discardNullIsland } = input;

  // 1. Every non-advert packet costs one integer compare. Sync, before any decode.
  if (event.payload_type !== MESHCORE_PAYLOAD_ADVERT) return { skip: 'not-advert' };

  // 2. Receiver identity must be a real MeshCore pubkey (e.g. not the
  //    repeater CLI placeholder 'repeater' — belt and braces; repeater/serial
  //    sources never emit ota_packet in the first place, D9).
  const receiverPubKey = input.receiverPubKey;
  if (!receiverPubKey || !isMeshCorePubKeyId(receiverPubKey)) return { skip: 'no-receiver' };

  // 3. Decode the frame.
  const rawHex = event.raw_hex;
  if (!rawHex) return { skip: 'decode-failed' };
  const packet = decodeMeshCorePacket(rawHex);
  const advert = packet?.payload.advert;
  if (!packet || !advert) return { skip: 'decode-failed' };

  // 4. Only a positioned advert is Coverage data.
  if (advert.latitude === undefined || advert.longitude === undefined) return { skip: 'no-position' };

  // 5. Same rule `meshcore.upsertNode` uses.
  if (shouldDiscardPosition(advert.latitude, advert.longitude, undefined, discardNullIsland)) {
    return { skip: 'bogus-position' };
  }

  // 6. Our own advert, relayed back to us.
  const sender = advert.publicKey.toLowerCase();
  if (sender === receiverPubKey) return { skip: 'own-advert' };

  // 7. Observer only (D5): skip observers that are our own companions —
  //    the companion source already records its own hearings first-hand.
  if (receiverKind === 'mqtt_gateway' && isOwnPublicKey(receiverPubKey)) return { skip: 'own-observer' };

  // 8. No usable measurement at all.
  const snr = event.snr ?? null;
  const rssi = event.rssi ?? null;
  if (snr == null && rssi == null) return { skip: 'no-signal' };

  // 9. packetKey must be computable (firmware packet hash, path excluded — D2).
  const packetKey = calculateMeshCorePacketHash(rawHex);
  if (packetKey === MESHCORE_PACKET_HASH_SENTINEL) return { skip: 'no-hash' };

  // 10. Observer only (D4): stale on the OBSERVER's own capture clock, never
  //     the advert's sender-controlled timestamp. Absent -> kept.
  if (
    receiverKind === 'mqtt_gateway' &&
    observerTimestampMs != null &&
    nowMs - observerTimestampMs > COVERAGE_MAX_RX_AGE_SEC * 1000
  ) {
    return { skip: 'stale' };
  }

  // D7: pathKey = hop count + last-hop hash (SNR belongs to the last link).
  const hopsAway = computeMeshCoreHopsAway(packet.header.routeType, packet.path.hopCount);
  const lastHop = packet.path.hops.length > 0 ? packet.path.hops[packet.path.hops.length - 1] : null;
  const pathKey = meshcorePathKey(hopsAway, lastHop);

  const row: MeshCoreCoverageRow = {
    sourceId,
    protocol: 'meshcore',
    receiverKind,
    receiverId: receiverPubKey,
    receiverNodeNum: null,
    senderId: sender,
    senderNodeNum: null,
    packetKey,
    packetId: null,
    pathKey,
    snr,
    rssi,
    hopStart: null,
    hopLimit: null,
    hopsAway,
    relayNode: null,
    transportMechanism: null,
    rxTime: null,
  };

  return { skip: null, advert, row };
}

// ---------------------------------------------------------------------------
// Replay guard (D3)
// ---------------------------------------------------------------------------

interface ReplayGuardEntry {
  maxTs: number;
  packetKey: string;
  firstSeenMs: number;
  updatedMs: number;
}

const REPLAY_GUARD_DEFAULT_MAX_ENTRIES = 10_000;
const REPLAY_GUARD_DEFAULT_PATH_WINDOW_MS = 60_000;
const REPLAY_GUARD_DEFAULT_TTL_MS = 3_600_000;

/**
 * Clock-free replay guard (D3). MeshCore advert timestamps are the SENDER's
 * clock, and are often badly wrong, so this cannot be an advert-age rule
 * like the Meshtastic `isStaleCoverageRxTime` check. Instead it mirrors
 * firmware's own replay rule (`timestamp <= last_advert_timestamp` -> "possible
 * replay") and catches a shared-contact re-send: `shareContactZeroHop`
 * re-transmits the STORED advert bytes zero-hop from a third node
 * (`BaseChatMesh.cpp`), which looks like a direct reception from the
 * original sender with the sharer's SNR.
 *
 * State per key (`${sourceId}|${receiverId}|${senderId}`) in a bounded LRU:
 * - No entry, or the entry is older than `ttlMs` (measured from its last
 *   ACCEPTED update, never touched on a reject) -> accept, store. This is
 *   the recovery path for a receiver clock that jumped backwards (reboot
 *   without time sync): after an hour of nothing but rejects, the next
 *   packet is treated as fresh again.
 * - `advertTs > maxTs` -> accept, store the new advert (a genuinely newer
 *   advert instance).
 * - `advertTs === maxTs && packetKey === entry.packetKey && nowMs -
 *   firstSeenMs <= pathWindowMs` -> accept (another relayed copy of the SAME
 *   advert, arriving via a different path within the window).
 * - Else -> reject.
 *
 * Residual (documented, not fixed here, §2.2): a share of an advert this
 * receiver has not heard in the last `ttlMs` records as a zero-hop
 * reception, indistinguishable from a genuine direct hearing.
 */
export class MeshCoreReplayGuard {
  private readonly cache: LruCache<string, ReplayGuardEntry>;
  private readonly pathWindowMs: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxEntries?: number; pathWindowMs?: number; ttlMs?: number }) {
    this.cache = new LruCache<string, ReplayGuardEntry>(opts?.maxEntries ?? REPLAY_GUARD_DEFAULT_MAX_ENTRIES);
    this.pathWindowMs = opts?.pathWindowMs ?? REPLAY_GUARD_DEFAULT_PATH_WINDOW_MS;
    this.ttlMs = opts?.ttlMs ?? REPLAY_GUARD_DEFAULT_TTL_MS;
  }

  /** True = accept and record; false = reject as a replay. */
  check(key: string, advertTs: number, packetKey: string, nowMs: number): boolean {
    // `get()` promotes recency on a hit, so a rejected (unmodified) entry
    // still stays alive in the LRU as long as it's being consulted.
    const entry = this.cache.get(key);

    if (!entry || nowMs - entry.updatedMs > this.ttlMs) {
      this.cache.set(key, { maxTs: advertTs, packetKey, firstSeenMs: nowMs, updatedMs: nowMs });
      return true;
    }

    if (advertTs > entry.maxTs) {
      this.cache.set(key, { maxTs: advertTs, packetKey, firstSeenMs: nowMs, updatedMs: nowMs });
      return true;
    }

    if (advertTs === entry.maxTs && packetKey === entry.packetKey && nowMs - entry.firstSeenMs <= this.pathWindowMs) {
      this.cache.set(key, { ...entry, updatedMs: nowMs });
      return true;
    }

    return false;
  }

  clear(): void {
    this.cache.clear();
  }
}

// Module-level guard shared across every companion + observer source — the
// source is part of the cache key, so a single process-wide instance is
// safe (mirrors `coverageMqtt.ts`'s shared receiver-position cache).
const replayGuard = new MeshCoreReplayGuard();

// ---------------------------------------------------------------------------
// Observer receiver-position cache (§2.3)
// ---------------------------------------------------------------------------

/**
 * MeshCore Observer receiver-position loader: this source's `meshcore_nodes`
 * row for the observer's own pubkey (written by `ingestAdvert` when the feed
 * carries the observer's own advert). Filtered through `shouldDiscardPosition`
 * so a `(0,0)` self-info position (or any other bogus fix) resolves to
 * `null`, same as the sender-position check in the evaluator.
 */
async function meshCoreObserverPositionLoader(sourceId: string, publicKey: string): Promise<ReceiverPos> {
  const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);
  const lat = node?.latitude ?? null;
  const lon = node?.longitude ?? null;
  if (shouldDiscardPosition(lat, lon, undefined, getDiscardInvalidPositions())) {
    return { lat: null, lon: null };
  }
  return { lat, lon };
}

// Shared across every MeshCore Observer source (the source is part of the
// cache key, matching `coverageMqtt.ts`'s shared instance for Meshtastic
// gateways).
const observerPositionCache = new CoverageReceiverPositionCache({ loader: meshCoreObserverPositionLoader });

/** Test seam — clears the module-level replay guard and observer position cache between cases. */
export function __resetCoverageMeshCoreForTest(): void {
  replayGuard.clear();
  observerPositionCache.clear();
}

// ---------------------------------------------------------------------------
// Async record function
// ---------------------------------------------------------------------------

export interface MaybeRecordMeshCoreCoverageReceptionInput {
  sourceId: string;
  receiverKind: 'local' | 'mqtt_gateway';
  /** Not necessarily lowercased — this function lowercases it. */
  receiverPubKey: string | null;
  /** local: `{lat: this.localNode?.latitude, lon: this.localNode?.longitude}`; observer: the shared cache. */
  receiverPosition: () => Promise<ReceiverPos>;
  event: MeshCoreBridgeOtaPacketLike;
  observerTimestampMs?: number | null;
}

/**
 * Record one MeshCore reception of a positioned, signed ADVERT for the
 * Coverage Report. Called non-blocking (`void`) from the companion
 * `ota_packet` handler (always on, D8) and the Observer MQTT `handleMessage`
 * hook (opt-in, U1).
 *
 * Never throws into the OTA/MQTT stream; never emits on `dataEventEmitter`
 * (mesh-impact checklist §0 — nothing is sent for this feature, so there is
 * no cost and no feedback loop to guard against).
 *
 * Order (§2.2, deliberate): the sync payload-type check runs FIRST (every
 * non-advert packet — the overwhelming majority of OTA/Observer traffic —
 * costs one compare and nothing else). Only an ADVERT reaches the pure
 * evaluator (skip rules 2-10). Only a reception that passes ALL of those
 * reaches the Ed25519 signature check (U3) — expensive, so it runs after
 * every cheap sync/structural guard, not before. Only a GENUINE signature
 * reaches the replay guard, so a forged advert can never poison replay-guard
 * state (a genuine copy that follows still records normally). Only then is
 * the receiver's position resolved and the row written.
 */
export async function maybeRecordMeshCoreCoverageReception(
  input: MaybeRecordMeshCoreCoverageReceptionInput,
): Promise<void> {
  try {
    // Cheapest possible guard first: every non-advert packet costs one
    // compare, paying for nothing else in this function.
    if (input.event.payload_type !== MESHCORE_PAYLOAD_ADVERT) return;

    // One clock read for the stale check, the replay guard and the stored row.
    const nowMs = Date.now();

    const evalResult = evaluateMeshCoreCoverageReception({
      sourceId: input.sourceId,
      receiverKind: input.receiverKind,
      receiverPubKey: input.receiverPubKey ? input.receiverPubKey.toLowerCase() : null,
      event: input.event,
      observerTimestampMs: input.observerTimestampMs,
      nowMs,
      isOwnPublicKey: defaultIsOwnPublicKey,
      discardNullIsland: getDiscardInvalidPositions(),
    });
    if (evalResult.skip !== null) return;

    const { advert, row } = evalResult;

    // U3: verify the Ed25519 advert signature BEFORE the replay guard, so a
    // forged advert can never poison the guard's state.
    let verified = false;
    try {
      verified = await Ed25519SignatureVerifier.verifyAdvertisementSignature(
        advert.publicKey,
        advert.signature,
        advert.timestamp,
        advert.appDataHex ?? '',
      );
    } catch (err) {
      logger.debug(`📡 MeshCore Coverage signature check threw (treated as invalid, non-fatal): ${err}`);
      verified = false;
    }
    if (!verified) return; // bad-signature

    const guardKey = `${row.sourceId}|${row.receiverId}|${row.senderId}`;
    if (!replayGuard.check(guardKey, advert.timestamp, row.packetKey, nowMs)) return; // replay

    const rawPos = await input.receiverPosition();
    const discardReceiverPos = shouldDiscardPosition(rawPos.lat, rawPos.lon, undefined, getDiscardInvalidPositions());
    const receiverLatitude = discardReceiverPos ? null : rawPos.lat;
    const receiverLongitude = discardReceiverPos ? null : rawPos.lon;

    await databaseService.coverageReceptions.recordReception({
      ...row,
      receiverLatitude,
      receiverLongitude,
      latitude: advert.latitude!,
      longitude: advert.longitude!,
      altitude: null,
      precisionBits: null,
      channel: null,
      receivedAt: nowMs,
    });
  } catch (err) {
    logger.debug(`📡 Failed to record MeshCore Coverage reception (non-fatal): ${err}`);
  }
}

/**
 * Resolve a MeshCore Observer's receiver position from its own
 * `meshcore_nodes` row on `sourceId`, via the shared TTL cache.
 * `publicKey` is expected lowercased.
 */
export function getMeshCoreObserverReceiverPosition(sourceId: string, publicKey: string): Promise<ReceiverPos> {
  return observerPositionCache.get(sourceId, publicKey);
}
