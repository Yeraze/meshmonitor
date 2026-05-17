/**
 * mqtt.js client wrapper for connecting to an upstream MQTT broker.
 *
 * Used by MqttBridgeManager to bridge an upstream public broker to the
 * embedded local MqttBroker. Wraps mqtt.js with URL normalization,
 * reconnect-aware subscription tracking, and a small event surface.
 */

import { EventEmitter } from 'events';
import { connect, type MqttClient } from 'mqtt';
import { logger } from '../../utils/logger.js';

export interface MqttBrokerClientOptions {
  url: string;
  username?: string;
  password?: string;
  clientIdPrefix?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttBrokerClientMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
}

/**
 * Events emitted on the MqttBrokerClient EventEmitter:
 * - 'connect' / 'reconnect' / 'offline' / 'close'
 * - 'error' (error: Error)
 * - 'message' (msg: MqttBrokerClientMessage)
 */
export class MqttBrokerClient extends EventEmitter {
  private readonly options: MqttBrokerClientOptions;
  private client: MqttClient | null = null;
  private readonly subscriptions = new Set<string>();
  private connected = false;
  private lastError: string | null = null;

  constructor(options: MqttBrokerClientOptions) {
    super();
    this.options = options;
  }

  connect(): Promise<void> {
    if (this.client) return Promise.resolve();

    const url = normalizeBrokerUrl(this.options.url);
    const clientId =
      (this.options.clientIdPrefix ?? 'meshmonitor') +
      '-' +
      Math.random().toString(36).slice(2, 10);

    this.client = connect(url, {
      clientId,
      username: this.options.username,
      password: this.options.password,
      protocolVersion: 4, // MQTT 3.1.1
      clean: true,
      keepalive: 60,
      reconnectPeriod: 5000,
      connectTimeout: 30_000,
      rejectUnauthorized: this.options.rejectUnauthorized ?? true,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      logger.info(`📡 MQTT client connected to ${url}`);
      // Re-subscribe on every connect (covers reconnects with clean=true).
      if (this.subscriptions.size > 0) {
        const topics = Array.from(this.subscriptions);
        this.client!.subscribe(topics, { qos: 0 }, (err) => {
          if (err) {
            logger.error(`MQTT resubscribe failed: ${err.message}`);
          }
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
    return new Promise<void>((resolve, reject) => {
      this.client!.subscribe(topics, { qos: 0 }, (err) => {
        if (err) reject(err);
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
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastError(): string | null {
    return this.lastError;
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
