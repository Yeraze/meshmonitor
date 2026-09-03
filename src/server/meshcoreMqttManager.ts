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
  type MeshCoreBridgeOtaPacket,
} from './services/meshcoreMqttIngestPacket.js';
import { logger } from '../utils/logger.js';

/** Persisted `sources.config` shape for a `meshcore_mqtt` source. */
export interface MeshCoreMqttSourceConfig {
  /** Broker URL: ws://, wss://, mqtt://, mqtts://, or bare host:port. */
  brokerUrl: string;
  /** IATA-ish region code — the topic's region segment. Uppercased on use. */
  region: string;
  /** Static MQTT username, when the broker uses fixed credentials. */
  username?: string;
  /** Static MQTT password. Stored encrypted; resolved before construction. */
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
  lastPacketAt: number | null;
  lastError: string | null;
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
    lastPacketAt: null,
    lastError: null,
  };
  /** Observer keys seen this session, for the `observers` counter. */
  private readonly seenObservers = new Set<string>();

  constructor(sourceId: string, sourceName: string, config: MeshCoreMqttSourceConfig) {
    super();
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

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
      if (!this.seenObservers.has(decoded.originId)) {
        this.seenObservers.add(decoded.originId);
        this.stats.observers = this.seenObservers.size;
      }

      // Phase 1 ends here: the packet is decoded and counted, not persisted.
      // Phase 2 routes this into the same handleOtaPacket seam the local radio
      // path uses. The event is emitted now so a consumer can be attached
      // without changing this method.
      this.emit('ota_packet', decoded.event satisfies MeshCoreBridgeOtaPacket);
    } catch (err) {
      this.stats.rejected++;
      logger.debug(`[MeshCoreMqtt:${this.sourceId}] failed to handle message:`, err);
    }
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
