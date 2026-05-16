import { EventEmitter } from 'events';
import { connect as mqttConnect } from 'mqtt';
import type { MqttClient, IClientOptions, IClientPublishOptions } from 'mqtt';
import { logger } from '../../utils/logger.js';

export interface MqttBrokerClientOptions {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientIdPrefix?: string;
  keepaliveSeconds?: number;
  reconnectPeriodMs?: number;
  connectTimeoutMs?: number;
  tls?: {
    ca?: string | Buffer;
    cert?: string | Buffer;
    key?: string | Buffer;
    rejectUnauthorized?: boolean;
  };
}

export interface MqttBrokerPublishOptions {
  retain?: boolean;
  qos?: 0 | 1 | 2;
}

export interface MqttBrokerMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
}

/**
 * Thin EventEmitter wrapper around the mqtt npm package.
 *
 * Consumers (MqttSourceManager, and Meshtastic Quick Connect via observer)
 * subscribe to events rather than poking the underlying client. Owns reconnect
 * resubscription so callers can treat broker state as continuous.
 *
 * Events:
 *   'connect'    — broker handshake completed (fires on initial connect + every reconnect)
 *   'reconnect'  — auto-reconnect attempt in progress
 *   'offline'    — broker connection lost (will auto-reconnect unless disconnect() was called)
 *   'close'      — explicit close
 *   'error'      — broker error
 *   'message'    — (msg: MqttBrokerMessage) topic / payload / retained
 */
export class MqttBrokerClient extends EventEmitter {
  private client: MqttClient | null = null;
  private readonly options: MqttBrokerClientOptions;
  private readonly subscriptions: Set<string> = new Set();
  private readonly clientId: string;
  private explicitlyClosed = false;

  constructor(options: MqttBrokerClientOptions) {
    super();
    this.options = options;
    const prefix = options.clientIdPrefix ?? 'meshmonitor';
    this.clientId = `${prefix}-${randomShortId()}`;
  }

  get connected(): boolean {
    return !!this.client?.connected;
  }

  get clientIdentifier(): string {
    return this.clientId;
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;

    const opts: IClientOptions = {
      clientId: this.clientId,
      username: this.options.username,
      password: this.options.password,
      keepalive: this.options.keepaliveSeconds ?? 60,
      reconnectPeriod: this.options.reconnectPeriodMs ?? 5_000,
      connectTimeout: this.options.connectTimeoutMs ?? 30_000,
      clean: true,
      protocolVersion: 4, // MQTT 3.1.1 — broadest broker support
    };
    if (this.options.tls) {
      const tls = this.options.tls;
      if (tls.ca !== undefined) opts.ca = tls.ca;
      if (tls.cert !== undefined) opts.cert = tls.cert;
      if (tls.key !== undefined) opts.key = tls.key;
      opts.rejectUnauthorized = tls.rejectUnauthorized ?? true;
    }

    // mqtt.js throws "Missing protocol" if the URL has no scheme. Be forgiving
    // about user input — accept bare host[:port] and host[:port] forms by
    // defaulting to mqtt:// (or mqtts:// if the port looks like a TLS port).
    const normalizedUrl = normalizeBrokerUrl(this.options.brokerUrl);
    const client = mqttConnect(normalizedUrl, opts);
    this.client = client;

    client.on('reconnect', () => {
      logger.debug(`[MqttBrokerClient ${this.clientId}] reconnect attempt`);
      this.emit('reconnect');
    });
    client.on('offline', () => {
      logger.warn(`[MqttBrokerClient ${this.clientId}] offline`);
      this.emit('offline');
    });
    client.on('close', () => {
      this.emit('close');
    });
    client.on('error', (err) => {
      logger.warn(`[MqttBrokerClient ${this.clientId}] error: ${err.message}`);
      this.emit('error', err);
    });
    client.on('message', (topic, payload, packet) => {
      const msg: MqttBrokerMessage = {
        topic,
        payload,
        retained: !!packet.retain,
      };
      this.emit('message', msg);
    });

    // Every 'connect' resubscribes our tracked filters. The first one resolves the
    // pending connect() promise below. Subsequent ones (on reconnect) restore subs
    // since we use clean=true.
    const onConnect = () => {
      logger.info(`[MqttBrokerClient ${this.clientId}] connected to ${this.options.brokerUrl}`);
      if (this.subscriptions.size > 0) {
        const list = Array.from(this.subscriptions);
        client.subscribe(list, { qos: 0 }, (err) => {
          if (err) {
            logger.warn(`[MqttBrokerClient ${this.clientId}] resubscribe failed: ${err.message}`);
            this.emit('error', err);
          }
        });
      }
      this.emit('connect');
    };
    client.on('connect', onConnect);

    await new Promise<void>((resolve, reject) => {
      const settled = { value: false };
      const onceConnect = () => {
        if (settled.value) return;
        settled.value = true;
        client.removeListener('error', onceError);
        resolve();
      };
      const onceError = (err: Error) => {
        if (settled.value) return;
        settled.value = true;
        client.removeListener('connect', onceConnect);
        reject(err);
      };
      client.once('connect', onceConnect);
      client.once('error', onceError);
    });
  }

  async subscribe(filters: string[]): Promise<void> {
    if (!this.client) throw new Error('MqttBrokerClient not connected');
    for (const f of filters) this.subscriptions.add(f);
    await new Promise<void>((resolve, reject) => {
      this.client!.subscribe(filters, { qos: 0 }, (err, granted) => {
        if (err) return reject(err);
        if (granted) {
          const failed = granted.filter((g) => g.qos >= 128);
          if (failed.length > 0) {
            return reject(
              new Error(`Subscribe denied for: ${failed.map((g) => g.topic).join(', ')}`),
            );
          }
        }
        resolve();
      });
    });
  }

  async unsubscribe(filters: string[]): Promise<void> {
    if (!this.client) return;
    for (const f of filters) this.subscriptions.delete(f);
    await new Promise<void>((resolve, reject) => {
      this.client!.unsubscribe(filters, (err) => (err ? reject(err) : resolve()));
    });
  }

  async publish(
    topic: string,
    payload: Buffer | string | Uint8Array,
    opts: MqttBrokerPublishOptions = {},
  ): Promise<void> {
    if (!this.client) throw new Error('MqttBrokerClient not connected');
    const pubOpts: IClientPublishOptions = {
      qos: opts.qos ?? 0,
      retain: opts.retain ?? false,
    };
    const body: Buffer | string = payload instanceof Buffer
      ? payload
      : typeof payload === 'string'
        ? payload
        : Buffer.from(payload);
    await new Promise<void>((resolve, reject) => {
      this.client!.publish(topic, body, pubOpts, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    this.explicitlyClosed = true;
    const client = this.client;
    this.client = null;
    this.subscriptions.clear();
    await new Promise<void>((resolve) => {
      client.end(true, undefined, () => resolve());
    });
  }

  /** For tests only — true if disconnect() was explicitly called. */
  get isExplicitlyClosed(): boolean {
    return this.explicitlyClosed;
  }
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Accept user-friendly forms (`host`, `host:port`) by prepending `mqtt://`
 * when the input is missing a scheme. Default to `mqtts://` only when the
 * port is one of the canonical TLS ports so we don't silently misuse TLS
 * (or, worse, silently downgrade).
 */
export function normalizeBrokerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  // Already has a scheme like mqtt://, mqtts://, ws://, wss://, tcp://, tls://
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const portMatch = trimmed.match(/:(\d+)(?:\/|$)/);
  const port = portMatch ? Number(portMatch[1]) : NaN;
  const tlsPort = port === 8883 || port === 8884;
  return `${tlsPort ? 'mqtts' : 'mqtt'}://${trimmed}`;
}
