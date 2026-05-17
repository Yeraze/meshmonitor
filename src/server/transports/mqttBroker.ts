/**
 * Embedded MQTT broker (Aedes) — TCP listener with shared-credentials auth.
 *
 * Owns one Aedes instance + one `net.Server`. Re-emits client lifecycle
 * and `publish` events so the MqttBrokerManager can ingest the
 * Meshtastic ServiceEnvelope payloads that connected devices publish.
 *
 * v1 supports plain TCP MQTT 3.1.1 only. TLS and WebSocket transports
 * are deferred.
 */

import { EventEmitter } from 'events';
import { createServer, type Server, type Socket } from 'net';
import { Aedes, type AedesPublishPacket, type Client } from 'aedes';
import { logger } from '../../utils/logger.js';

export interface MqttBrokerOptions {
  port: number;
  host?: string;
  auth: { username: string; password: string };
  brokerId?: string;
}

export interface MqttBrokerPublish {
  topic: string;
  payload: Buffer;
  retained: boolean;
  clientId: string | null;
}

export interface MqttBrokerStatus {
  listening: boolean;
  port: number | null;
  host: string | null;
  clientCount: number;
  lastError: string | null;
}

/**
 * Events emitted on the MqttBroker EventEmitter:
 * - 'listening' — TCP listener bound
 * - 'closed' — Aedes broker fully shut down
 * - 'client-connected' (clientId: string)
 * - 'client-disconnected' (clientId: string)
 * - 'publish' (msg: MqttBrokerPublish)
 * - 'error' (error: Error)
 */
export class MqttBroker extends EventEmitter {
  private readonly options: MqttBrokerOptions;
  private aedes: Aedes | null = null;
  private server: Server | null = null;
  private listening = false;
  private lastError: string | null = null;

  constructor(options: MqttBrokerOptions) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.aedes) {
      throw new Error('MqttBroker already started');
    }

    const expectedUser = this.options.auth.username;
    const expectedPass = this.options.auth.password;
    if (!expectedUser || !expectedPass) {
      throw new Error('MqttBroker requires auth.username and auth.password');
    }

    this.aedes = await Aedes.createBroker({
      id: this.options.brokerId ?? 'meshmonitor-broker',
    });

    this.aedes.authenticate = (_client, username, password, done) => {
      const u = typeof username === 'string' ? username : '';
      const p = password ? password.toString('utf8') : '';
      if (u === expectedUser && p === expectedPass) {
        done(null, true);
        return;
      }
      const err = new Error('Bad username or password') as Error & {
        returnCode: number;
      };
      err.returnCode = 4; // BAD_USERNAME_OR_PASSWORD
      done(err, false);
    };

    this.aedes.on('client', (client) => {
      this.emit('client-connected', client.id);
    });
    this.aedes.on('clientDisconnect', (client) => {
      this.emit('client-disconnected', client.id);
    });
    this.aedes.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
      // Aedes emits internal $SYS messages with `client === null`. Skip
      // those — only forward publishes from real clients.
      if (!client) return;
      this.emit('publish', {
        topic: packet.topic,
        payload: toBuffer(packet.payload),
        retained: !!packet.retain,
        clientId: client.id ?? null,
      });
    });

    this.server = createServer((socket: Socket) => {
      this.aedes!.handle(socket);
    });

    const host = this.options.host ?? '0.0.0.0';
    const port = this.options.port;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.lastError = err.message;
        reject(err);
      };
      this.server!.once('error', onError);
      this.server!.listen(port, host, () => {
        this.server!.off('error', onError);
        this.listening = true;
        this.lastError = null;
        logger.info(`📡 MQTT broker listening on ${host}:${port}`);
        this.emit('listening');
        resolve();
      });
    });

    this.server.on('error', (err) => {
      this.lastError = err.message;
      logger.error(`MQTT broker server error: ${err.message}`);
      this.emit('error', err);
    });
  }

  async stop(): Promise<void> {
    this.listening = false;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    if (this.aedes) {
      await new Promise<void>((resolve) => {
        this.aedes!.close(() => resolve());
      });
      this.aedes = null;
    }
    this.emit('closed');
  }

  /** Publish a message into the broker as if from the broker itself. */
  publish(topic: string, payload: Buffer, retained = false): Promise<void> {
    if (!this.aedes) throw new Error('MqttBroker not started');
    return new Promise<void>((resolve, reject) => {
      this.aedes!.publish(
        {
          cmd: 'publish',
          topic,
          payload,
          qos: 0,
          retain: retained,
          dup: false,
        } as Parameters<Aedes['publish']>[0],
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }

  getStatus(): MqttBrokerStatus {
    return {
      listening: this.listening,
      port: this.listening ? this.options.port : null,
      host: this.listening ? (this.options.host ?? '0.0.0.0') : null,
      clientCount: this.aedes?.connectedClients ?? 0,
      lastError: this.lastError,
    };
  }
}

function toBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.alloc(0);
}
