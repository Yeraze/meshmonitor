/**
 * Direct RF Contacts recorder (#6210).
 *
 * Feeds `direct_rf_contacts`, the per-source daily rollup of nodes a source's
 * OWN radio heard directly over RF (zero hops, not via MQTT). Two live RX
 * paths call it:
 *
 *  - Meshtastic TCP (`meshtasticManager.ts`), every portnum. See
 *    {@link evaluateMeshtasticDirectRf} for the rules.
 *  - The MeshCore companion's raw RX feed (`ota_packet`, push 0x88), signed
 *    zero-hop ADVERTs only. See {@link evaluateMeshCoreDirectRf}.
 *
 * MQTT sources (`mqttIngestion.ts`, `meshcoreMqttManager.ts`) never call it:
 * a broker copy is not a hearing by any of our radios.
 *
 * Writes are coalesced in memory and flushed every {@link FLUSH_INTERVAL_MS}
 * (or sooner when {@link MAX_PENDING_KEYS} distinct day rows are waiting):
 * a node heard ten times in five seconds costs one read-modify-write, not
 * ten. The flush timer is a one-shot armed by the first pending reception,
 * so an idle install runs no timer at all. A crash loses at most one
 * interval of counts; graceful shutdown calls {@link flushDirectRfContacts}.
 *
 * Mesh impact: none. This is receive-only bookkeeping: it sends nothing,
 * emits nothing on `dataEventEmitter`, and its only timer writes to the DB.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  MESHCORE_PAYLOAD_ADVERT,
  computeMeshCoreHopsAway,
  computeMeshtasticHopsAway,
  isMeshCorePubKeyId,
  nodeNumToId,
} from '../../utils/coverage.js';
import { decodeMeshCorePacket, type DecodedAdvert } from '../../utils/meshcorePacketDecode.js';
import { isRfTransport, isNodeDbReplayForPacketLog } from './packetLogDedup.js';
import { resolveRadioPacketTransport, isViaMqtt } from '../constants/meshtastic.js';
import { isLiveReception } from '../utils/replayGuard.js';
import { MeshCoreReplayGuard } from '../utils/meshcoreReplayGuard.js';
import { calculateMeshCorePacketHash } from './meshcoreObserverPacket.js';
import {
  directRfDayBucket,
  type DirectRfContactDelta,
  type DirectRfProtocol,
} from '../../db/repositories/directRfContacts.js';
import { Ed25519SignatureVerifier } from '@michaelhart/meshcore-decoder';

/** One qualifying direct reception, before coalescing. */
export interface DirectRfReception {
  sourceId: string;
  protocol: DirectRfProtocol;
  nodeKey: string;
  nodeNum: number | null;
  snr: number | null;
  rssi: number | null;
  heardAt: number;
}

// ---------------------------------------------------------------------------
// Meshtastic
// ---------------------------------------------------------------------------

export interface MeshtasticDirectRfPacket {
  from?: number | bigint | null;
  id?: number | bigint | null;
  rxSnr?: number | null;
  rxRssi?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  rxTime?: number | bigint | null;
  viaMqtt?: boolean | null;
  transportMechanism?: number | null;
  decoded?: { bitfield?: number | null } | null;
}

export interface EvaluateMeshtasticDirectRfInput {
  sourceId: string;
  /** The receiving source's own nodeNum (null until its radio has reported it). */
  localNodeNum: number | null;
  packet: MeshtasticDirectRfPacket;
  /** Store & Forward replay or a virtual-node-originated packet: not a live hearing. */
  replayed?: boolean;
  nowMs: number;
}

export type MeshtasticDirectRfSkip =
  | 'no-local-node'
  | 'replayed'
  | 'own-packet'
  | 'via-mqtt'
  | 'not-rf'
  | 'no-hop-start'
  | 'not-direct'
  | 'not-live'
  | 'nodedb-replay';

/**
 * Does this Meshtastic packet count as a direct RF contact? Pure, so every
 * rule is tested on its own (`directRfContactRecorder.test.ts`). In order:
 *
 *  1. The local node must be known, and the packet must not be ours.
 *  2. Not a Store & Forward or virtual-node replay.
 *  3. `viaMqtt` must be false. An MQTT downlink rebroadcast over LoRa reaches
 *     us as transport LORA with `via_mqtt = true`; `classifyNodeTransport`
 *     would call that RF, so this flag is checked on its own (#6210).
 *  4. The transport must be RF (LoRa or unset).
 *  5. Zero hops by `computeMeshtasticHopsAway`: `hopStart` present,
 *     `hopStart >= hopLimit`, `hopStart - hopLimit == 0` (0/0 only with a
 *     bitfield, so pre-2.3 firmware with `hop_start` unset never counts).
 *  6. A live reception (`isLiveReception`, 120 s on `rx_time`), and not a
 *     firmware NodeDB replay (#5426, `isNodeDbReplayForPacketLog`, which also
 *     catches a 2.8 replay by its packet id), so a reconnect does not mark
 *     every node as freshly heard direct.
 */
export function evaluateMeshtasticDirectRf(
  input: EvaluateMeshtasticDirectRfInput,
): { skip: MeshtasticDirectRfSkip } | { skip: null; reception: DirectRfReception } {
  const p = input.packet;
  if (input.localNodeNum === null) return { skip: 'no-local-node' };
  if (input.replayed) return { skip: 'replayed' };

  const fromNum = p.from ? Number(p.from) : 0;
  if (!fromNum || fromNum === input.localNodeNum) return { skip: 'own-packet' };

  if (p.viaMqtt === true || isViaMqtt(p.transportMechanism ?? undefined)) return { skip: 'via-mqtt' };
  const transport = resolveRadioPacketTransport(p);
  if (!isRfTransport(transport)) return { skip: 'not-rf' };

  if (p.hopStart == null) return { skip: 'no-hop-start' };
  const hopsAway = computeMeshtasticHopsAway({
    hopStart: p.hopStart,
    hopLimit: p.hopLimit ?? null,
    hasBitfield: typeof p.decoded?.bitfield === 'number',
  });
  if (hopsAway !== 0) return { skip: 'not-direct' };

  const rxTimeSec = p.rxTime != null ? Number(p.rxTime) : null;
  if (!isLiveReception(rxTimeSec ?? undefined, input.nowMs)) return { skip: 'not-live' };
  const packetId = p.id ? Number(p.id) : 0;
  if (isNodeDbReplayForPacketLog(transport, rxTimeSec, p.rxRssi ?? null, input.nowMs, { fromNum, packetId })) {
    return { skip: 'nodedb-replay' };
  }

  return {
    skip: null,
    reception: {
      sourceId: input.sourceId,
      protocol: 'meshtastic',
      nodeKey: nodeNumToId(fromNum),
      nodeNum: fromNum,
      // -128 is the firmware "no SNR" sentinel; 0 dB is a real reading.
      snr: p.rxSnr != null && p.rxSnr !== -128 && Number.isFinite(p.rxSnr) ? p.rxSnr : null,
      rssi: p.rxRssi != null && Number.isFinite(p.rxRssi) ? p.rxRssi : null,
      heardAt: input.nowMs,
    },
  };
}

/** Meshtastic hook: never throws into the packet path. */
export function maybeRecordMeshtasticDirectRf(input: Omit<EvaluateMeshtasticDirectRfInput, 'nowMs'> & { nowMs?: number }): void {
  try {
    const result = evaluateMeshtasticDirectRf({ ...input, nowMs: input.nowMs ?? Date.now() });
    if (result.skip === null) directRfContactRecorder.record(result.reception);
  } catch (err) {
    logger.debug('Direct RF contact record (Meshtastic) failed (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// MeshCore
// ---------------------------------------------------------------------------

export interface MeshCoreDirectRfEvent {
  payload_type?: number;
  snr?: number | null;
  rssi?: number | null;
  raw_hex?: string | null;
}

export interface EvaluateMeshCoreDirectRfInput {
  sourceId: string;
  /** This companion's own public key (null until it has reported one). */
  localPubKey: string | null;
  event: MeshCoreDirectRfEvent;
  nowMs: number;
}

export type MeshCoreDirectRfSkip =
  | 'not-advert'
  | 'no-local-node'
  | 'decode-failed'
  | 'not-direct'
  | 'own-advert';

/**
 * Does this MeshCore OTA frame count as a direct RF contact? Pure part.
 *
 * Only an ADVERT names its sender in full (the signed 32-byte public key);
 * every other payload carries a 1-byte source hash, which collides, so it
 * cannot key a row. Zero hops is `computeMeshCoreHopsAway === 0`: a flood
 * whose path is still empty, or a direct-routed frame with no hops. The
 * caller still checks the Ed25519 signature and the replay guard.
 */
export function evaluateMeshCoreDirectRf(
  input: EvaluateMeshCoreDirectRfInput,
): { skip: MeshCoreDirectRfSkip } | { skip: null; advert: DecodedAdvert; rawHex: string } {
  if (input.event.payload_type !== MESHCORE_PAYLOAD_ADVERT) return { skip: 'not-advert' };
  const local = input.localPubKey ? input.localPubKey.toLowerCase() : null;
  if (!local || !isMeshCorePubKeyId(local)) return { skip: 'no-local-node' };
  const rawHex = input.event.raw_hex;
  if (!rawHex) return { skip: 'decode-failed' };
  const packet = decodeMeshCorePacket(rawHex);
  const advert = packet?.payload.advert;
  if (!packet || !advert || !isMeshCorePubKeyId(advert.publicKey)) return { skip: 'decode-failed' };
  if (computeMeshCoreHopsAway(packet.header.routeType, packet.path.hopCount) !== 0) return { skip: 'not-direct' };
  if (advert.publicKey.toLowerCase() === local) return { skip: 'own-advert' };
  return { skip: null, advert, rawHex };
}

// Separate from the Coverage Report's guard: the two features accept the
// same advert independently, and sharing one would let either starve the other.
const meshCoreReplayGuard = new MeshCoreReplayGuard();

/**
 * MeshCore hook: a signed zero-hop advert heard by this companion. Never
 * throws into the OTA path. The signature check runs only after the cheap
 * structural rules pass, and before the replay guard, so a forged advert
 * can never poison the guard (the same order the Coverage Report uses).
 */
export async function maybeRecordMeshCoreDirectRf(
  input: Omit<EvaluateMeshCoreDirectRfInput, 'nowMs'> & { nowMs?: number },
): Promise<void> {
  try {
    if (input.event.payload_type !== MESHCORE_PAYLOAD_ADVERT) return;
    const nowMs = input.nowMs ?? Date.now();
    const result = evaluateMeshCoreDirectRf({ ...input, nowMs });
    if (result.skip !== null) return;
    const { advert, rawHex } = result;
    let verified = false;
    try {
      verified = await Ed25519SignatureVerifier.verifyAdvertisementSignature(
        advert.publicKey,
        advert.signature,
        advert.timestamp,
        advert.appDataHex ?? '',
      );
    } catch {
      verified = false;
    }
    if (!verified) return;
    const sender = advert.publicKey.toLowerCase();
    const guardKey = `${input.sourceId}|${sender}`;
    if (!meshCoreReplayGuard.check(guardKey, advert.timestamp, calculateMeshCorePacketHash(rawHex), nowMs)) return;
    const snr = input.event.snr;
    const rssi = input.event.rssi;
    directRfContactRecorder.record({
      sourceId: input.sourceId,
      protocol: 'meshcore',
      nodeKey: sender,
      nodeNum: null,
      snr: snr != null && Number.isFinite(snr) ? snr : null,
      rssi: rssi != null && Number.isFinite(rssi) ? rssi : null,
      heardAt: nowMs,
    });
  } catch (err) {
    logger.debug('Direct RF contact record (MeshCore) failed (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// Coalescing writer
// ---------------------------------------------------------------------------

export const FLUSH_INTERVAL_MS = 5_000;
export const MAX_PENDING_KEYS = 500;

type ApplyDelta = (d: DirectRfContactDelta) => Promise<void>;

export class DirectRfContactRecorder {
  private pending = new Map<string, DirectRfContactDelta>();
  private timer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly apply: ApplyDelta = (d) => databaseService.directRfContacts.applyDelta(d),
    private readonly intervalMs = FLUSH_INTERVAL_MS,
    private readonly maxPending = MAX_PENDING_KEYS,
  ) {}

  /** Fold one reception into its pending (source, node, day) delta. */
  record(r: DirectRfReception): void {
    const dayBucket = directRfDayBucket(r.heardAt);
    const key = `${r.sourceId}|${r.nodeKey}|${dayBucket}`;
    const snr = r.snr;
    const rssi = r.rssi;
    const cur = this.pending.get(key);
    if (!cur) {
      this.pending.set(key, {
        sourceId: r.sourceId,
        protocol: r.protocol,
        nodeKey: r.nodeKey,
        nodeNum: r.nodeNum,
        dayBucket,
        firstHeardAt: r.heardAt,
        lastHeardAt: r.heardAt,
        count: 1,
        bestSnr: snr,
        bestRssi: rssi,
        snrSum: snr ?? 0,
        snrCount: snr !== null ? 1 : 0,
        rssiSum: rssi ?? 0,
        rssiCount: rssi !== null ? 1 : 0,
      });
    } else {
      cur.firstHeardAt = Math.min(cur.firstHeardAt, r.heardAt);
      cur.lastHeardAt = Math.max(cur.lastHeardAt, r.heardAt);
      cur.count += 1;
      if (snr !== null) {
        cur.bestSnr = cur.bestSnr === null ? snr : Math.max(cur.bestSnr, snr);
        cur.snrSum += snr;
        cur.snrCount += 1;
      }
      if (rssi !== null) {
        cur.bestRssi = cur.bestRssi === null ? rssi : Math.max(cur.bestRssi, rssi);
        cur.rssiSum += rssi;
        cur.rssiCount += 1;
      }
    }

    if (this.pending.size >= this.maxPending) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** Write every pending delta. Flushes run one at a time, in order. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = Array.from(this.pending.values());
    this.pending = new Map();
    if (batch.length === 0) return this.flushChain;
    this.flushChain = this.flushChain.then(async () => {
      for (const d of batch) {
        try {
          await this.apply(d);
        } catch (err) {
          logger.debug(`Direct RF contact flush failed for ${d.sourceId}/${d.nodeKey} (non-fatal):`, err);
        }
      }
    });
    return this.flushChain;
  }

  /** Test seam: drop pending deltas and any armed timer. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = new Map();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

export const directRfContactRecorder = new DirectRfContactRecorder();

/** Graceful-shutdown hook: write what is pending before the DB closes. */
export function flushDirectRfContacts(): Promise<void> {
  return directRfContactRecorder.flush();
}

/** Test seam: clears the module-level recorder and replay guard. */
export function __resetDirectRfContactRecorderForTest(): void {
  directRfContactRecorder.reset();
  meshCoreReplayGuard.clear();
}
