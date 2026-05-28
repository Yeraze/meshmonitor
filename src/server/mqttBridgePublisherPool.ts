/**
 * Per-gateway upstream MQTT publisher pool.
 *
 * In `forwardingMode: 'per_gateway'` mode (the default), `MqttBridgeManager`
 * dispatches each `local-packet` to a separate upstream MQTT connection
 * keyed on the packet's `gateway_id`. Each connection authenticates with
 * `clientId = '!' + hex8(gatewayNum)` so the upstream broker sees the
 * packet as if it came directly from the gateway node — mirroring the
 * wire behavior of a Meshtastic device that publishes its own MQTT-out.
 *
 * The motivating use case is community brokers (e.g. `mqtt.areyoumeshingwith.us`)
 * that gate CONNECT on a Client ID regex like `^!\[0-9a-f]{8,}$` and
 * return CONNACK 4 to MeshMonitor's legacy `mm-bridge-<sourceId>-…`
 * prefix regardless of credentials. With per-gateway identities the
 * bridge looks indistinguishable from N firmware MQTT clients.
 *
 * Pool entries are created lazily on the first `publish()` for a gateway
 * and held open for the pool's lifetime — no idle eviction in v1. At
 * realistic local-node counts (single digits per host) the socket cost
 * is negligible and the cold-publish CONNACK round-trip on every new
 * gateway would noticeably hurt latency on bursty traffic.
 *
 * NOT included in v1, intentionally:
 *   - LWT (Last-Will) on per-gateway clients — defer until we have parity
 *     with firmware's exact disconnect payload shape.
 *   - Idle eviction policy.
 *   - `gateway_id` provenance check against known local nodes.
 */

import { MqttBrokerClient, type MqttReconnectCoordinator } from './transports/mqttBrokerClient.js';
import { logger } from '../utils/logger.js';

export interface PublisherPoolOptions {
  /** Upstream URL passed through to each MqttBrokerClient. */
  url: string;
  /** Optional upstream auth, shared across every pool entry. */
  username?: string;
  password?: string;
  /** Pool diagnostic label — usually the owning bridge's sourceId. */
  poolLabel: string;
  /** Shared reconnect coordinator — all pool entries use the same backoff timer. */
  reconnectCoordinator?: MqttReconnectCoordinator;
}

export interface PublisherStatus {
  /** `!<8-hex>` representation of the gateway, matching the entry's clientId. */
  clientId: string;
  connected: boolean;
  publishes: number;
  lastPublishAt: number | null;
  lastError: string | null;
}

interface PoolEntry {
  client: MqttBrokerClient;
  clientId: string;
  publishes: number;
  lastPublishAt: number | null;
  lastError: string | null;
  /** Resolves once the initial CONNACK lands (or the first reconnect, etc.). */
  ready: Promise<void>;
}

/**
 * Format a Meshtastic node number as the canonical `!<8-hex>` Client ID.
 * Treats `gatewayNum` as unsigned 32-bit; values exceeding that range
 * are masked, which preserves the firmware convention.
 */
export function formatGatewayClientId(gatewayNum: number): string {
  return '!' + (gatewayNum >>> 0).toString(16).padStart(8, '0');
}

export class MqttBridgePublisherPool {
  private readonly options: PublisherPoolOptions;
  private readonly entries = new Map<number, PoolEntry>();
  private closed = false;

  constructor(options: PublisherPoolOptions) {
    this.options = options;
  }

  /**
   * Returns the count of pool entries currently held open. Used for
   * diagnostic surfaces; pool size has no upper bound in v1.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Snapshot of every pool entry's state, keyed by `!<8-hex>` Client ID.
   * Safe to read at any time; reflects the most recent publish outcome.
   */
  getStatus(): Record<string, PublisherStatus> {
    const out: Record<string, PublisherStatus> = {};
    for (const entry of this.entries.values()) {
      out[entry.clientId] = {
        clientId: entry.clientId,
        connected: entry.client.isConnected(),
        publishes: entry.publishes,
        lastPublishAt: entry.lastPublishAt,
        lastError: entry.lastError,
      };
    }
    return out;
  }

  /**
   * Publish through the per-gateway connection, creating it on first use.
   *
   * Resolves once the publish is queued to mqtt.js. If the underlying
   * connection isn't yet connected (initial CONNACK pending), the publish
   * still resolves — mqtt.js queues it client-side and flushes on connect.
   * That's the same behavior as direct mqtt.connect() use; callers don't
   * have to wait for `ready`.
   *
   * Errors are recorded on the entry's `lastError` and rethrown so the
   * caller can log them at the bridge level. They don't tear the pool
   * entry down — mqtt.js handles reconnection.
   */
  async publish(
    gatewayNum: number,
    topic: string,
    payload: Buffer,
    retained = false,
  ): Promise<void> {
    if (this.closed) {
      throw new Error(`Publisher pool ${this.options.poolLabel} is closed`);
    }
    const entry = this.ensureEntry(gatewayNum);
    try {
      await entry.client.publish(topic, payload, retained);
      entry.publishes++;
      entry.lastPublishAt = Date.now();
      entry.lastError = null;
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Pre-create a pool entry without publishing — useful when the bridge
   * wants the broker-identity connection up before any uplink traffic
   * arrives. Returns the entry's ready-promise so callers can await
   * the initial CONNACK if they need to.
   */
  prepare(gatewayNum: number): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        new Error(`Publisher pool ${this.options.poolLabel} is closed`),
      );
    }
    return this.ensureEntry(gatewayNum).ready;
  }

  /**
   * Close every pool entry in parallel. After this resolves the pool
   * rejects further publishes — call `new MqttBridgePublisherPool(...)`
   * to rebuild.
   */
  async close(): Promise<void> {
    this.closed = true;
    const closes = Array.from(this.entries.values()).map((e) =>
      e.client.disconnect().catch((err) => {
        logger.warn(
          `Publisher pool ${this.options.poolLabel}: disconnect failed for ${e.clientId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }),
    );
    this.entries.clear();
    await Promise.all(closes);
  }

  private ensureEntry(gatewayNum: number): PoolEntry {
    const key = gatewayNum >>> 0; // normalize to unsigned 32-bit
    const existing = this.entries.get(key);
    if (existing) return existing;

    const clientId = formatGatewayClientId(key);
    const client = new MqttBrokerClient({
      url: this.options.url,
      username: this.options.username,
      password: this.options.password,
      clientId,
    });
    if (this.options.reconnectCoordinator) {
      client.setCoordinator(this.options.reconnectCoordinator);
    }
    const entry: PoolEntry = {
      client,
      clientId,
      publishes: 0,
      lastPublishAt: null,
      lastError: null,
      // connect() returns a promise that resolves on the first CONNACK;
      // we keep it so prepare() callers can await it explicitly.
      ready: client.connect(),
    };
    client.on('error', (err) => {
      entry.lastError = err.message;
    });
    this.entries.set(key, entry);
    logger.info(
      `Publisher pool ${this.options.poolLabel}: created entry for gateway ${clientId}`,
    );
    return entry;
  }
}
