/**
 * mqtt.js client wrapper for connecting to an upstream MQTT broker.
 *
 * Used by MqttBridgeManager to bridge an upstream public broker to the
 * embedded local MqttBroker. Wraps mqtt.js with URL normalization,
 * reconnect-aware subscription tracking, and a small event surface.
 */

import { EventEmitter } from 'events';
import { connect, type IClientSubscribeOptions, type MqttClient } from 'mqtt';
import { logger } from '../../utils/logger.js';

export interface MqttBrokerClientOptions {
  url: string;
  username?: string;
  password?: string;
  /**
   * Explicit MQTT Client ID. When set, used verbatim on CONNECT (no random
   * suffix). Takes precedence over `clientIdPrefix`. Use this when the
   * upstream broker filters CONNECT on Client ID — e.g. community brokers
   * that whitelist `!<8-hex>` patterns. See `MqttBridgePublisherPool` for
   * the per-gateway-identity use case.
   */
  clientId?: string;
  clientIdPrefix?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttBrokerClientMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
}

/** Per-topic SUBACK outcome. `qos === 128` means broker denied the subscription. */
export interface MqttSubscriptionResult {
  topic: string;
  qos: 0 | 1 | 2 | 128;
}

/**
 * Snapshot of capability state inferred from the upstream broker's responses.
 * - canSubscribe: at least one subscribe attempt was granted (or no subs yet).
 * - canPublish: 'unknown' at QoS 0 — broker does not ACK denials, so we
 *   cannot directly observe publish-permission. Set to 'no' if the broker
 *   closed the connection mid-session after a publish (heuristic).
 * - authFailed: CONNACK returned BAD_USERNAME_OR_PASSWORD / NOT_AUTHORIZED.
 * - deniedSubscriptions: topic filters that were rejected with SUBACK 0x80.
 */
export interface MqttClientCapabilities {
  canSubscribe: boolean;
  canPublish: 'yes' | 'no' | 'unknown';
  authFailed: boolean;
  deniedSubscriptions: string[];
}

/**
 * Events emitted on the MqttBrokerClient EventEmitter:
 * - 'connect' / 'reconnect' / 'offline' / 'close'
 * - 'error' (error: Error)
 * - 'message' (msg: MqttBrokerClientMessage)
 * - 'subscription-result' (results: MqttSubscriptionResult[])
 *     fired after every subscribe SUBACK; includes both granted and denied entries.
 * - 'permission-denied' (reason: { kind: 'subscribe' | 'auth'; topics?: string[]; message: string })
 *     fired when the broker denied subscribe or rejected the CONNACK on auth grounds.
 */
export class MqttBrokerClient extends EventEmitter {
  private readonly options: MqttBrokerClientOptions;
  private client: MqttClient | null = null;
  private readonly subscriptions = new Set<string>();
  private readonly deniedSubscriptions = new Set<string>();
  private connected = false;
  private lastError: string | null = null;
  private authFailed = false;

  constructor(options: MqttBrokerClientOptions) {
    super();
    this.options = options;
  }

  connect(): Promise<void> {
    if (this.client) return Promise.resolve();

    const url = normalizeBrokerUrl(this.options.url);
    const clientId =
      this.options.clientId ??
      (this.options.clientIdPrefix ?? 'meshmonitor') +
        '-' +
        Math.random().toString(36).slice(2, 10);

    // Per-client reconnect jitter: when N publisher-pool entries reconnect
    // after an upstream broker bounce, a flat 5000ms period would have them
    // all CONNECT in the same window. Random 4000-6000ms spreads the herd.
    const reconnectPeriod = 5000 + Math.floor((Math.random() - 0.5) * 2000);

    this.client = connect(url, {
      clientId,
      username: this.options.username,
      password: this.options.password,
      protocolVersion: 4, // MQTT 3.1.1
      clean: true,
      keepalive: 60,
      reconnectPeriod,
      connectTimeout: 30_000,
      rejectUnauthorized: this.options.rejectUnauthorized ?? true,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      this.authFailed = false;
      logger.info(`📡 MQTT client connected to ${url}`);
      // Re-subscribe on every connect (covers reconnects with clean=true).
      // Clear previously-tracked denials too — a fresh session may have
      // different ACLs (e.g. broker reconfigured).
      this.deniedSubscriptions.clear();
      if (this.subscriptions.size > 0) {
        const topics = Array.from(this.subscriptions);
        this.client!.subscribe(topics, { qos: 0 }, (err, granted, packet) => {
          this.handleSubscribeCallback(topics, err, granted, packet);
        });
      }
      this.emit('connect');
    });

    this.client.on('reconnect', () => this.emit('reconnect'));
    this.client.on('offline', () => {
      this.connected = false;
      this.emit('offline');
    });
    this.client.on('close', () => {
      this.connected = false;
      this.emit('close');
    });
    this.client.on('error', (err) => {
      this.lastError = err.message;
      logger.warn(`MQTT client error (${url}): ${err.message}`);
      // Classify CONNACK auth rejections. mqtt.js surfaces these as
      // ErrorWithReasonCode whose .code matches the MQTT 3.1.1 CONNACK
      // return code: 4 = BAD_USERNAME_OR_PASSWORD, 5 = NOT_AUTHORIZED.
      const code = (err as Error & { code?: number }).code;
      if (code === 4 || code === 5) {
        this.authFailed = true;
        const reason =
          code === 4
            ? 'Broker rejected username or password.'
            : 'Broker rejected authentication (not authorized).';
        this.emit('permission-denied', {
          kind: 'auth' as const,
          message: reason,
        });
      }
      this.emit('error', err);
    });
    this.client.on('message', (topic, payload, packet) => {
      this.emit('message', {
        topic,
        payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
        retained: !!packet.retain,
      });
    });

    return new Promise<void>((resolve) => {
      const onConnect = () => {
        this.client!.off('connect', onConnect);
        resolve();
      };
      this.client!.on('connect', onConnect);
      // Don't reject on initial failure — mqtt.js will reconnect.
    });
  }

  subscribe(topics: string[]): Promise<void> {
    for (const t of topics) this.subscriptions.add(t);
    if (!this.client || !this.connected) return Promise.resolve();
    const opts: IClientSubscribeOptions = { qos: 0 };
    return new Promise<void>((resolve, reject) => {
      this.client!.subscribe(topics, opts, (err, granted, packet) => {
        const settled = this.handleSubscribeCallback(topics, err, granted, packet);
        // Reject only for true protocol/transport errors — a SUBACK that
        // denies some topics is captured in capabilities, not surfaced as
        // a thrown error, so the caller can keep running with reduced
        // functionality.
        if (settled.kind === 'error') reject(settled.error);
        else resolve();
      });
    });
  }

  publish(topic: string, payload: Buffer, retained = false): Promise<void> {
    if (!this.client) return Promise.reject(new Error('MqttBrokerClient not connected'));
    return new Promise<void>((resolve, reject) => {
      this.client!.publish(topic, payload, { qos: 0, retain: retained }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await new Promise<void>((resolve) => {
      this.client!.end(true, {}, () => resolve());
    });
    this.client = null;
    this.connected = false;
    this.subscriptions.clear();
    this.deniedSubscriptions.clear();
    this.authFailed = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getCapabilities(): MqttClientCapabilities {
    const denied = Array.from(this.deniedSubscriptions).sort();
    const requested = this.subscriptions.size;
    // canSubscribe is true unless we asked for subs and every one was denied.
    const canSubscribe = requested === 0 ? true : denied.length < requested;
    return {
      canSubscribe,
      canPublish: 'unknown',
      authFailed: this.authFailed,
      deniedSubscriptions: denied,
    };
  }

  /**
   * Unify mqtt.js's two subscribe-callback shapes into a single decision:
   *
   * - On full success, mqtt.js v5 calls `cb(null, subs, packet)` where each
   *   `subs[i]` is `{topic, qos}` with the QoS the broker actually granted.
   * - On partial failure (any topic returned qos 0x80 in SUBACK), mqtt.js
   *   raises `cb(err, subs, packet)` where `err` is an `ErrorWithSubackPacket`
   *   with `err.packet.granted` holding the raw per-topic grant codes
   *   (numbers, including 128 for denials). The `subs[i].qos` array in this
   *   path is the *requested* qos, not the granted one — so we must read
   *   `err.packet.granted` to recover the denial bits.
   *
   * For a true protocol/transport error (no SUBACK arrived), `err.packet`
   * is absent and we propagate the failure to the caller.
   */
  private handleSubscribeCallback(
    requested: string[],
    err: Error | null | undefined,
    granted: Array<{ topic: string; qos: number }> | undefined,
    // mqtt.js's ISubackPacket['granted'] is `number[] | Object[]` because
    // MQTT 5 SUBACK uses reason-code objects while MQTT 3.1.1 uses plain
    // numbers. We hardcode protocolVersion: 4, so entries are numbers in
    // practice — but the type system can't narrow that, so accept the
    // broader shape and runtime-filter to numbers.
    packet: { granted?: ReadonlyArray<number | object> } | undefined,
  ): { kind: 'ok' } | { kind: 'error'; error: Error } {
    const subackPacket =
      packet ??
      (err as (Error & { packet?: { granted?: ReadonlyArray<number | object> } }) | null)?.packet;
    const rawGrants = subackPacket?.granted;

    if (rawGrants && Array.isArray(rawGrants) && rawGrants.length > 0) {
      const results: MqttSubscriptionResult[] = rawGrants.map((code, i) => ({
        topic: requested[i] ?? `?[${i}]`,
        qos: (typeof code === 'number'
          ? code
          : // MQTT 5 path (unused with protocolVersion:4 but kept defensive):
            // reason-code object may carry its own `reasonCode` field.
            (((code as { reasonCode?: number }).reasonCode ?? 0) as number)) as MqttSubscriptionResult['qos'],
      }));
      this.applySubackResults(results);
      return { kind: 'ok' };
    }

    if (granted && granted.length > 0) {
      const results: MqttSubscriptionResult[] = granted.map((g, i) => ({
        topic: typeof g.topic === 'string' ? g.topic : requested[i] ?? `?[${i}]`,
        qos: g.qos as MqttSubscriptionResult['qos'],
      }));
      this.applySubackResults(results);
      return { kind: 'ok' };
    }

    if (err) {
      logger.warn(`MQTT subscribe failed: ${err.message}`);
      return { kind: 'error', error: err };
    }
    // No err, no SUBACK packet, no granted — nothing to do.
    return { kind: 'ok' };
  }

  private applySubackResults(results: MqttSubscriptionResult[]): void {
    const newlyDenied: string[] = [];
    for (const r of results) {
      if (r.qos === 128) {
        if (!this.deniedSubscriptions.has(r.topic)) newlyDenied.push(r.topic);
        this.deniedSubscriptions.add(r.topic);
      } else {
        // Broker may grant a topic that was previously denied (ACL change).
        // Clear so capability state reflects the new reality.
        this.deniedSubscriptions.delete(r.topic);
      }
    }
    this.emit('subscription-result', results);
    if (newlyDenied.length > 0) {
      const list = newlyDenied.join(', ');
      logger.warn(
        `MQTT broker denied subscription to ${newlyDenied.length} topic(s): ${list}`,
      );
      this.emit('permission-denied', {
        kind: 'subscribe' as const,
        topics: newlyDenied,
        message: `Broker denied subscription to: ${list}`,
      });
    }
  }
}

// Bare host → mqtt://host; canonical TLS ports get mqtts://.
export function normalizeBrokerUrl(input: string): string {
  const trimmed = input.trim();
  if (/^(mqtt|mqtts|ws|wss|tcp|tls):\/\//i.test(trimmed)) {
    return trimmed;
  }
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx > 0) {
    const port = Number(trimmed.slice(colonIdx + 1));
    if (port === 8883 || port === 8884) return 'mqtts://' + trimmed;
  }
  return 'mqtt://' + trimmed;
}
