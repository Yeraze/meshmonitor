/**
 * MeshCoreMqttManager — MeshCore ingest from an Analyzer Observer MQTT broker
 * (issue #5040, Phase 1).
 *
 * The mirror of `meshcoreObserverPublisher.ts`. Where that publishes what our
 * Companion heard to analyzer brokers, this **subscribes** to one broker and
 * ingests what every observer in a region heard — giving a view of the mesh far
 * wider than a single radio's earshot.
 *
 * ## No radio, ever
 *
 * This source has no device. It cannot transmit, and that is enforced
 * structurally rather than by policy:
 *
 * - Its `sourceType` is `meshcore_mqtt`, so `isMeshCoreManager()` — which every
 *   TX-driving scheduler and device route filters on — excludes it by
 *   construction. Nothing has to remember to skip it.
 * - `getLocalNode()` / `getLocalNodeInfo()` return null. There is no local
 *   identity: we are not a node on this mesh, we are reading someone else's
 *   observations. Both are already-supported null states on the device-backed
 *   manager, so consumers need no change.
 *
 * Read surfaces that *should* see this source use `isAnyMeshCoreManager()`.
 * See `sourceManagerTypes.ts` for which predicate is which, and #5040's Phase
 * 5.5 for the audit that walks every call site.
 *
 * ## One broker per source
 *
 * Deliberate (#5040). The publish side allows up to 8 brokers per source, but
 * subscribing to several regional brokers carrying overlapping traffic tangles
 * with the per-observer dedup design. One broker per source keeps "which broker
 * did this come from" collapsed to "which source", which is what makes the
 * downstream analysis surfaces tractable. Add a second source for a second
 * broker.
 *
 * ## Phase 1 scope
 *
 * Connect, subscribe, decode, count — and drop. Nothing is persisted yet; that
 * is Phase 2. This phase proves the pipe end to end and gives the later phases
 * a manager to hang off.
 */
import { EventEmitter } from 'events';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { MqttBrokerClient } from './transports/mqttBrokerClient.js';
import {
  decodeObserverPacketMessage,
  observerPacketsSubscription,
  observerKeyFromTopic,
  type IngestedObserverPacket,
} from './services/meshcoreMqttIngestPacket.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import databaseService from '../services/database.js';
import { decodeMeshCorePacket } from '../utils/meshcorePacketDecode.js';
import { createHash } from 'node:crypto';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';
import { ALL_SOURCES } from '../db/repositories/base.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { logger } from '../utils/logger.js';

/** Persisted `sources.config` shape for a `meshcore_mqtt` source. */
export interface MeshCoreMqttSourceConfig {
  /** Broker URL: ws://, wss://, mqtt://, mqtts://, or bare host:port. */
  brokerUrl: string;
  /** IATA-ish region code — the topic's region segment. Uppercased on use. */
  region: string;
  /** Static MQTT username, when the broker uses fixed credentials. */
  username?: string;
  /**
   * Static MQTT password.
   *
   * Stored as plaintext in the source's `config` blob, like `mqtt_broker`'s
   * `auth.password` — there is no encryption layer for source config. It is
   * kept out of non-admin API responses by `stripSourceSecrets`, and preserved
   * across an edit that leaves the field blank by `preserveSourceCredentials`.
   */
  password?: string;
  /** Reject invalid TLS certs. Defaults true; only lower it for a local broker. */
  rejectUnauthorized?: boolean;
  /** When false the source is enabled but must be connected manually. */
  autoConnect?: boolean;
}

/** Counters surfaced on the source status panel. */
export interface MeshCoreMqttIngestStats {
  /** Messages received on the packets topic, before validation. */
  received: number;
  /** Messages that decoded into a usable packet. */
  accepted: number;
  /** Messages rejected as malformed, unparseable, or identity-mismatched. */
  rejected: number;
  /** Distinct observer public keys seen this session. */
  observers: number;
  /** ADVERT frames turned into node create/updates. */
  advertsIngested: number;
  /** GRP_TXT frames decrypted and stored as channel messages. */
  channelMessages: number;
  lastPacketAt: number | null;
  lastError: string | null;
}

/**
 * Convert an ADVERT's self-reported unix-seconds timestamp into a `lastHeard`
 * milliseconds value, or `undefined` when it carries none.
 *
 * Clamped to now: the value comes from an untrusted publisher, so a future
 * claim is either a forgery or a node with a bad clock, and both would corrupt
 * every "last heard" ordering that reads this column.
 */
/**
 * Content-derived message id for a channel message ingested over MQTT
 * (#5040 Phase 4).
 *
 * Includes `sourceId` so a copy your own radio heard keeps its own row under
 * its own source — the two are different observations and the UI labels them —
 * while every observer relaying the SAME frame on THIS source collapses to one
 * id and therefore one row.
 *
 * Keyed on (channel, sender timestamp, text) rather than the raw frame: two
 * observers can report the same message with different hop paths and signal
 * metadata, so the raw bytes differ while the message does not.
 */
/** The shape `ChannelCrypto.decryptGroupTextMessage` returns in `data`. */
interface ChannelPlaintext {
  timestamp?: number;
  flags?: number;
  sender?: string;
  message?: string;
}

export function channelMessageId(
  sourceId: string,
  channelHash: string,
  timestampSec: number,
  text: string,
): string {
  const digest = createHash('sha256')
    .update(`${channelHash}\u0000${timestampSec}\u0000${text}`)
    .digest('hex')
    .slice(0, 24);
  return `mqtt_${sourceId}_${digest}`;
}

/** Base64 or hex channel secret -> lowercase hex, or null when unusable. */
export function pskToHex(psk: string | null | undefined): string | null {
  if (!psk) return null;
  if (/^[0-9a-fA-F]+$/.test(psk) && psk.length % 2 === 0) return psk.toLowerCase();
  try {
    const buf = Buffer.from(psk, 'base64');
    return buf.length > 0 ? buf.toString('hex') : null;
  } catch {
    return null;
  }
}

export function advertLastHeardMs(timestampSec: number, nowMs: number = Date.now()): number | undefined {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return undefined;
  return Math.min(timestampSec * 1000, nowMs);
}

export class MeshCoreMqttManager extends EventEmitter implements ISourceManager {
  readonly sourceId: string;
  readonly sourceType = 'meshcore_mqtt' as const;

  private readonly sourceName: string;
  private readonly config: MeshCoreMqttSourceConfig;
  private client: MqttBrokerClient | null = null;
  private started = false;

  private readonly stats: MeshCoreMqttIngestStats = {
    received: 0,
    accepted: 0,
    rejected: 0,
    observers: 0,
    advertsIngested: 0,
    channelMessages: 0,
    lastPacketAt: null,
    lastError: null,
  };
  /**
   * Observer keys seen this session, for the `observers` counter.
   *
   * Capped: a busy regional feed can carry hundreds of distinct observers, and
   * this is a display counter, not state anything depends on. Past the cap the
   * count stops rising rather than growing the set without bound.
   */
  private readonly seenObservers = new Set<string>();
  private static readonly MAX_TRACKED_OBSERVERS = 1_000;

  constructor(sourceId: string, sourceName: string, config: MeshCoreMqttSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.openBroker();
    } catch (err) {
      // Roll back so a later start() can retry. Leaving `started` true after a
      // failed connect would strand the source: never connected, and never
      // retryable short of a process restart.
      this.started = false;
      this.client?.removeAllListeners();
      this.client = null;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Open and subscribe. Separated so start() can roll back cleanly on failure. */
  private async openBroker(): Promise<void> {

    const topic = observerPacketsSubscription(this.config.region);
    const client = new MqttBrokerClient({
      url: this.config.brokerUrl,
      username: this.config.username,
      password: this.config.password,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      clientIdPrefix: 'meshmonitor-ingest',
    });
    this.client = client;

    client.on('message', (msg: { topic: string; payload: Buffer }) => {
      this.handleMessage(msg.topic, msg.payload);
    });
    client.on('error', (err: unknown) => {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`[MeshCoreMqtt:${this.sourceId}] broker error: ${this.stats.lastError}`);
    });
    client.on('close', () => {
      logger.info(`[MeshCoreMqtt:${this.sourceId}] broker connection closed`);
    });

    await client.connect();
    await client.subscribe([topic]);
    logger.info(
      `[MeshCoreMqtt:${this.sourceId}] subscribed to ${topic} on ${this.config.brokerUrl}`,
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeAllListeners();
    try {
      await client.disconnect();
    } catch (err) {
      logger.debug(`[MeshCoreMqtt:${this.sourceId}] error closing broker client:`, err);
    }
  }

  /**
   * Decode one broker message.
   *
   * Everything a remote publisher sends is untrusted input: a malformed body, a
   * frame that contradicts its own metadata, or a publisher claiming another
   * observer's identity must all be dropped without disturbing the stream. A
   * single bad message on a busy region feed can never throw.
   */
  private handleMessage(topic: string, payload: Buffer): void {
    this.stats.received++;
    try {
      const body: unknown = JSON.parse(payload.toString('utf8'));
      const decoded = decodeObserverPacketMessage(body);
      if (!decoded) {
        this.stats.rejected++;
        return;
      }

      // Identity cross-check: the body's origin_id must match the topic the
      // message was published on. A mismatch means the publisher is claiming
      // another observer's identity — reject rather than attribute packets to
      // the wrong node.
      const topicKey = observerKeyFromTopic(topic);
      if (topicKey !== null && topicKey !== decoded.originId) {
        this.stats.rejected++;
        logger.debug(
          `[MeshCoreMqtt:${this.sourceId}] dropping packet: body origin_id ` +
            `${decoded.originId.slice(0, 16)}… does not match topic key ${topicKey.slice(0, 16)}…`,
        );
        return;
      }

      this.stats.accepted++;
      this.stats.lastPacketAt = Date.now();
      if (
        !this.seenObservers.has(decoded.originId) &&
        this.seenObservers.size < MeshCoreMqttManager.MAX_TRACKED_OBSERVERS
      ) {
        this.seenObservers.add(decoded.originId);
        this.stats.observers = this.seenObservers.size;
      }

      // Emitted for the same consumers the local radio path feeds (Virtual
      // Node bridge, channel-echo correlation) — the whole point of
      // reconstructing the bridge shape.
      this.emit('ota_packet', decoded.event);
      void this.persistPacket(decoded);
      void this.ingestAdvert(decoded);
      void this.ingestChannelMessage(decoded);
    } catch (err) {
      this.stats.rejected++;
      logger.debug(`[MeshCoreMqtt:${this.sourceId}] failed to handle message:`, err);
    }
  }

  /**
   * Write one reception to the MeshCore packet monitor (#5040 Phase 2).
   *
   * One row PER OBSERVER, not per packet: the same frame heard by eight
   * observers is eight rows, differing in SNR/RSSI and stamped with who heard
   * it. That is the coverage data a region feed exists to provide, and
   * collapsing it here would throw it away — the repository's grouped queries
   * dedupe at read time instead.
   *
   * Gated on the same opt-in setting as the local packet monitor, and
   * best-effort: a DB failure must never break the ingest stream.
   */
  private async persistPacket(decoded: IngestedObserverPacket): Promise<void> {
    try {
      if (!(await meshcorePacketLogService.isEnabled())) return;
      const now = Date.now();
      const e = decoded.event;
      await meshcorePacketLogService.logPacket({
        sourceId: this.sourceId,
        // Our ingest time, not the publisher's claimed `timestamp` — a remote
        // clock is untrusted input and would corrupt ordering and retention.
        timestamp: now,
        payloadType: e.payload_type,
        payloadTypeName: e.payload_type_string,
        routeType: e.route_type,
        routeTypeName: e.route_type_string,
        pathLenRaw: e.path_len_raw,
        hopCount: e.hop_count,
        pathHops: e.path_hops.length > 0 ? e.path_hops.join(',') : null,
        snr: e.snr ?? null,
        rssi: e.rssi ?? null,
        payloadSize: e.payload_size,
        rawHex: e.raw_hex,
        observerId: decoded.originId,
        createdAt: now,
      });
    } catch (err) {
      logger.debug(`[MeshCoreMqtt:${this.sourceId}] failed to persist packet:`, err);
    }
  }

  /**
   * Create or update a node from an ADVERT frame (#5040 Phase 3).
   *
   * Adverts are the only frame type a region feed can turn into node knowledge:
   * they are unencrypted and self-describing (public key, name, device role,
   * and optionally a position). Everything else on the feed is either encrypted
   * to someone else or carries no identity.
   *
   * ## Signatures are decoded but NOT enforced
   *
   * An advert is self-signed, and this source ingests frames published by
   * strangers, so a forged advert can create a node or move an existing one on
   * THIS source. That is an accepted trade-off, decided deliberately (#5040):
   *
   * - Verification is not free — an Ed25519 check per advert on a busy regional
   *   feed is real CPU on the ingest path.
   * - The device-backed path does not verify either; the radio hands us
   *   contacts without proof, so gating only the MQTT path would be
   *   inconsistent without being complete.
   * - Blast radius is bounded by per-source scoping: forged rows land in this
   *   source's `meshcore_nodes` only, never in a device source's.
   *
   * `decodeMeshCorePacket` exposes `appDataHex` so a caller that DOES want
   * proof can run `Ed25519SignatureVerifier.verifyAdvertisementSignature()` —
   * the packet monitor can show validity per frame on demand. If this ever
   * needs to become a gate, that is the hook, and it belongs here.
   *
   * Best-effort: a decode or write failure must never break the ingest stream.
   */
  private async ingestAdvert(decoded: IngestedObserverPacket): Promise<void> {
    try {
      const packet = decodeMeshCorePacket(decoded.event.raw_hex);
      const advert = packet?.payload?.advert;
      if (!advert?.publicKey) return;

      await databaseService.meshcore.upsertNode(
        {
          publicKey: advert.publicKey,
          // `undefined` means "not observed" to upsertNode, which then PRESERVES
          // the stored value. Passing null would clobber a good name with
          // nothing when an advert omits one.
          name: advert.name ?? undefined,
          advType: advert.advType,
          latitude: advert.latitude,
          longitude: advert.longitude,
          // Same provenance tag the contact-sync path uses: an advert position
          // is the static kind, so a real telemetry fix keeps precedence.
          positionSource: advert.latitude !== undefined ? 'contact' : undefined,
          // When the observer heard it, not when we ingested it — a replayed or
          // delayed publish must not make a silent node look freshly heard.
          //
          // Capped at now, because the timestamp is attacker-controlled in both
          // directions and only the stale one was guarded. A forged or
          // misconfigured advert claiming a FUTURE time would otherwise park the
          // node at the top of every "last heard" sort indefinitely, and no
          // later genuine reception could displace it. Mirrors the Meshtastic
          // NodeInfo path, which caps for the same reason
          // (`meshtasticManager.ts`, "cap at current time to prevent future
          // timestamps").
          lastHeard: advertLastHeardMs(advert.timestamp),
        },
        this.sourceId,
      );
      this.stats.advertsIngested++;
    } catch (err) {
      logger.debug(`[MeshCoreMqtt:${this.sourceId}] failed to ingest advert:`, err);
    }
  }

  /**
   * Decrypt a GRP_TXT (channel) frame and store it as a message (#5040 Phase 4).
   *
   * ## Channel keys are read across ALL sources
   *
   * An ingest source has no device and therefore no channels of its own — the
   * PSKs a user holds live on their device source. Reading every source's
   * channels is the only way this works without asking them to duplicate keys
   * onto a radio-less source, and it matches the codebase's existing
   * cross-source exception: CLAUDE.md names decryption keys as the canonical
   * "global by design" case (the Meshtastic `channel_database` does the same).
   *
   * Keys are selected by channel hash rather than brute-forced: the frame's
   * first payload byte is `SHA256(secret)[0]`, so at most a couple of
   * candidates are ever tried per frame.
   *
   * ## Duplicates collapse at the id, not at read time
   *
   * The id is CONTENT-derived and includes `sourceId`, so the same frame
   * relayed by twenty observers writes ONE row, while a copy your own radio
   * heard keeps its own row under its own source (source-labelled in the UI).
   * `insertMessage` returns whether it actually wrote, and the event emit is
   * gated on that — otherwise twenty observers would mean twenty notifications
   * and twenty automation triggers.
   */
  private async ingestChannelMessage(decoded: IngestedObserverPacket): Promise<void> {
    try {
      const packet = decodeMeshCorePacket(decoded.event.raw_hex);
      const group = packet?.payload?.groupText;
      if (!group) return;

      const plain = await this.decryptGroupText(group);
      if (!plain) return;

      // Sender's own timestamp, not ingest time — every observer's copy of one
      // message must agree, and a delayed relay must not re-date it (the same
      // rule Phase 3 applies to lastHeard).
      const timestampMs = plain.timestampSec > 0 ? plain.timestampSec * 1000 : Date.now();
      const id = channelMessageId(this.sourceId, group.channelHash, plain.timestampSec, plain.text);

      const row = {
          id,
          // 'channel-N' is how this table encodes channel membership; the
          // channel queries match on it. An empty value here would fall through
          // channelWhereClause(0)'s legacy "null recipient, non-channel sender"
          // branch and file EVERY ingested message under channel 0, whichever
          // channel it actually came from.
          fromPublicKey: `channel-${plain.channelIdx}`,
          // undefined, not null: the DB column is nullable but the event's
          // MeshCoreMessage type is `fromName?: string`, and one object has to
          // satisfy both — it is inserted and emitted unchanged.
          fromName: plain.senderName ?? undefined,
          text: plain.text,
          timestamp: timestampMs,
          messageType: 'channel',
          snr: decoded.event.snr ?? undefined,
          rssi: decoded.event.rssi ?? undefined,
          createdAt: Date.now(),
      };

      const inserted = await databaseService.meshcore.insertMessage(row, this.sourceId);
      if (!inserted) return; // A different observer's copy already landed.
      this.stats.channelMessages++;
      dataEventEmitter.emitMeshCoreMessage(row, this.sourceId);
    } catch (err) {
      logger.debug(`[MeshCoreMqtt:${this.sourceId}] failed to ingest channel message:`, err);
    }
  }

  /**
   * Try every known channel key whose hash matches the frame's.
   *
   * Returns null when we hold no matching key — the overwhelmingly common case
   * on a region feed, where most traffic belongs to channels we are not in.
   * That is not an error and must not be logged per packet.
   */
  private async decryptGroupText(
    group: { channelHash: string; cipherMacHex: string; ciphertextHex: string },
  ): Promise<{ text: string; senderName: string | null; timestampSec: number; channelIdx: number } | null> {
    const channels = await databaseService.channels.getAllChannels(ALL_SOURCES);
    for (const ch of channels) {
      const secretHex = pskToHex(ch.psk);
      if (!secretHex) continue;
      if (ChannelCrypto.calculateChannelHash(secretHex) !== group.channelHash) continue;

      const res = ChannelCrypto.decryptGroupTextMessage(
        group.ciphertextHex,
        group.cipherMacHex,
        secretHex,
      );
      // The library already splits the plaintext into timestamp / flags /
      // sender / message, so there is no second parser to keep in step.
      const data = res?.success ? (res.data as ChannelPlaintext | undefined) : undefined;
      if (!data || typeof data.message !== 'string' || data.message === '') continue;
      return {
        text: data.message,
        senderName: typeof data.sender === 'string' && data.sender !== '' ? data.sender : null,
        timestampSec: typeof data.timestamp === 'number' ? data.timestamp : 0,
        // The row id of the key that decrypted it IS the channel index — the
        // only way to know which channel a frame belongs to, since the wire
        // carries a hash rather than an index.
        channelIdx: Number(ch.id),
      };
    }
    return null;
  }

  getStatus(): SourceStatus {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      sourceType: this.sourceType,
      connected: this.client?.isConnected() ?? false,
    };
  }

  /** Ingest counters for the status panel. */
  getIngestStats(): Readonly<MeshCoreMqttIngestStats> {
    return { ...this.stats };
  }

  /**
   * Always null — this source is not a node on the mesh, it reads other nodes'
   * observations. Mirrors `MeshCoreManager.getLocalNodeInfo()`, which is also
   * hardcoded null, so every existing consumer already handles this.
   */
  getLocalNodeInfo(): null {
    return null;
  }

  /** Always null, for the same reason as {@link getLocalNodeInfo}. */
  getLocalNode(): null {
    return null;
  }

  /**
   * No-op: auto-delete-by-distance is anchored on the local node's position,
   * and this source has no local node. Implemented to satisfy ISourceManager
   * rather than left to throw.
   */
  async startDistanceDeleteScheduler(): Promise<void> {
    // Intentionally empty — see doc comment.
  }

  /** No-op counterpart to {@link startDistanceDeleteScheduler}. */
  stopDistanceDeleteScheduler(): void {
    // Intentionally empty — see doc comment.
  }
}
