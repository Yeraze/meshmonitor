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
  /**
   * Stop a gateway's client after this many rejected logins in a row. Each
   * gateway counts on its own: a broker that refuses one Client ID stops that
   * gateway only, and the rest keep publishing. Unset = retry for ever.
   */
  maxAuthFailures?: number;
  /**
   * Stop a gateway's client after this many evictions inside
   * `evictionWindowMs` (#5893). Per gateway, like `maxAuthFailures`.
   * Unset = reconnect for ever.
   */
  maxEvictions?: number;
  evictionWindowMs?: number;
}

/**
 * What a stopped gateway's status says in place of an error.
 *
 * A fixed string on purpose: the bridge status is readable without a login, so
 * nothing from the config and nothing from the broker's own error text may ride
 * along.
 */
export const GATEWAY_AUTH_STOPPED_MESSAGE =
  'Broker rejected this gateway\'s login repeatedly; it stopped reconnecting.';

/** Fixed text for a gateway that stopped after repeated evictions (#5893). */
export const GATEWAY_EVICTION_STOPPED_MESSAGE =
  'Broker kept closing this gateway\'s connection (another client is using the same Client ID or login); it stopped reconnecting.';

/** `published` = handed to mqtt.js. `dropped` = the gateway is stopped. */
export type PoolPublishResult = 'published' | 'dropped';

export interface PublisherStatus {
  /** `!<8-hex>` representation of the gateway, matching the entry's clientId. */
  clientId: string;
  connected: boolean;
  publishes: number;
  lastPublishAt: number | null;
  lastError: string | null;
  /** True once the broker rejected this gateway's login too many times. */
  authStopped: boolean;
  /** True once the broker evicted this gateway too many times (#5893). */
  evictionStopped: boolean;
  /** Uplink packets thrown away because this gateway is stopped. */
  droppedPublishes: number;
}

interface PoolEntry {
  client: MqttBrokerClient;
  clientId: string;
  publishes: number;
  lastPublishAt: number | null;
  lastError: string | null;
  /** Resolves once the initial CONNACK lands (or the first reconnect, etc.). */
  ready: Promise<void>;
  /**
   * True once the broker rejected this gateway's login too many times. The
   * entry stays in the map as a marker: without it the next packet from this
   * gateway would build a fresh client and hand the broker five more logins.
   */
  authStopped: boolean;
  /** Same marker role as `authStopped`, for a stop after evictions (#5893). */
  evictionStopped: boolean;
  droppedPublishes: number;
}

/** True when the entry gave up for either reason and takes no publishes. */
function isStopped(entry: PoolEntry): boolean {
  return entry.authStopped || entry.evictionStopped;
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
  /** Uplink packets dropped on auth-stopped gateways, over the pool's lifetime. */
  private authStoppedDrops = 0;
  /** Uplink packets dropped on eviction-stopped gateways (#5893). */
  private evictionStoppedDrops = 0;

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
        // Fixed text for a stopped gateway, never the broker's own words.
        lastError: entry.authStopped
          ? GATEWAY_AUTH_STOPPED_MESSAGE
          : entry.evictionStopped
            ? GATEWAY_EVICTION_STOPPED_MESSAGE
            : entry.lastError,
        authStopped: entry.authStopped,
        evictionStopped: entry.evictionStopped,
        droppedPublishes: entry.droppedPublishes,
      };
    }
    return out;
  }

  /** `!<8-hex>` ids of the gateways that stopped after rejected logins, sorted. */
  getAuthStoppedGateways(): string[] {
    return Array.from(this.entries.values())
      .filter((e) => e.authStopped)
      .map((e) => e.clientId)
      .sort();
  }

  /** Uplink packets dropped because their gateway was stopped. */
  getAuthStoppedDrops(): number {
    return this.authStoppedDrops;
  }

  /** `!<8-hex>` ids of the gateways that stopped after repeated evictions, sorted. */
  getEvictionStoppedGateways(): string[] {
    return Array.from(this.entries.values())
      .filter((e) => e.evictionStopped)
      .map((e) => e.clientId)
      .sort();
  }

  /** Uplink packets dropped because their gateway stopped after evictions. */
  getEvictionStoppedDrops(): number {
    return this.evictionStoppedDrops;
  }

  /**
   * Give every stopped gateway (rejected logins or repeated evictions) a
   * fresh client, and so a fresh count. Healthy and still-retrying gateways
   * are left alone. Returns how many gateways were restarted.
   *
   * The dropped packets are gone: nothing is replayed.
   */
  restartAuthStopped(): number {
    if (this.closed) return 0;
    const stopped = Array.from(this.entries.entries()).filter(([, e]) => isStopped(e));
    for (const [key] of stopped) {
      this.entries.delete(key);
      this.ensureEntry(key);
    }
    return stopped.length;
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
   *
   * A gateway that stopped after rejected logins takes no publishes: the
   * packet is dropped and counted, and the call resolves `'dropped'`. It does
   * not throw, so nothing upstream sees a failure to retry.
   */
  async publish(
    gatewayNum: number,
    topic: string,
    payload: Buffer,
    retained = false,
  ): Promise<PoolPublishResult> {
    if (this.closed) {
      throw new Error(`Publisher pool ${this.options.poolLabel} is closed`);
    }
    const entry = this.ensureEntry(gatewayNum);
    if (isStopped(entry)) {
      this.noteDrop(entry);
      return 'dropped';
    }
    try {
      await entry.client.publish(topic, payload, retained);
      entry.publishes++;
      entry.lastPublishAt = Date.now();
      entry.lastError = null;
      return 'published';
    } catch (err) {
      // The stop can land while the publish is in flight.
      if (isStopped(entry)) {
        this.noteDrop(entry);
        return 'dropped';
      }
      entry.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private noteDrop(entry: PoolEntry): void {
    entry.droppedPublishes++;
    if (entry.authStopped) this.authStoppedDrops++;
    else this.evictionStoppedDrops++;
    // Once per stop, not per packet.
    if (entry.droppedPublishes === 1) {
      const why = entry.authStopped ? 'rejected logins' : 'repeated evictions';
      logger.warn(
        `Publisher pool ${this.options.poolLabel}: gateway ${entry.clientId} is stopped after ${why}; ` +
          'dropping its uplink packets until the source is saved or reconnected',
      );
    }
  }

  /**
   * The broker evicted this gateway too many times (#5893). Same handling as
   * an auth stop: mark the entry so the next packet does not build a fresh
   * client, and close the socket. Other gateways are untouched.
   */
  private onEvictionStopped(entry: PoolEntry): void {
    if (isStopped(entry)) return;
    entry.evictionStopped = true;
    logger.warn(
      `Publisher pool ${this.options.poolLabel}: broker evicted gateway ${entry.clientId} ` +
        `${this.options.maxEvictions} times; that gateway stopped reconnecting`,
    );
    void entry.client.disconnect().catch((err) => {
      logger.debug(`Publisher pool ${this.options.poolLabel}: error closing evicted client:`, err);
    });
  }

  /**
   * The broker rejected this gateway's login too many times. Mark the entry
   * and close its client, which also throws away whatever mqtt.js had queued
   * while the logins were failing. Other gateways are untouched.
   */
  private onAuthStopped(entry: PoolEntry): void {
    if (isStopped(entry)) return;
    entry.authStopped = true;
    logger.warn(
      `Publisher pool ${this.options.poolLabel}: broker rejected gateway ${entry.clientId} ` +
        `${this.options.maxAuthFailures} times in a row; that gateway stopped reconnecting`,
    );
    // The 'error' listener stays on: the client still emits 'error' for this
    // same rejection, and an EventEmitter with no 'error' listener throws.
    void entry.client.disconnect().catch((err) => {
      logger.debug(`Publisher pool ${this.options.poolLabel}: error closing rejected client:`, err);
    });
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
      maxAuthFailures: this.options.maxAuthFailures,
      maxEvictions: this.options.maxEvictions,
      evictionWindowMs: this.options.evictionWindowMs,
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
      authStopped: false,
      evictionStopped: false,
      droppedPublishes: 0,
    };
    client.on('error', (err) => {
      entry.lastError = err.message;
    });
    client.on('auth-stopped', () => this.onAuthStopped(entry));
    client.on('eviction-stopped', () => this.onEvictionStopped(entry));
    this.entries.set(key, entry);
    logger.info(
      `Publisher pool ${this.options.poolLabel}: created entry for gateway ${clientId}`,
    );
    return entry;
  }
}
