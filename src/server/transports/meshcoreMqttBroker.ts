/**
 * Embedded MQTT listener for MeshCore observers (#6197).
 *
 * A thin Aedes wrapper, like `mqttBroker.ts` for Meshtastic, but with the
 * policy pushed out to the caller through three hooks:
 *
 * - `authenticate` decides each CONNECT (token, static login, max clients).
 * - `onPublish` sees every client PUBLISH. The broker itself never refuses a
 *   publish: Aedes closes the connection on an `authorizePublish` error, and a
 *   rate-limited observer should lose the excess frame, not its session. The
 *   caller drops and counts instead.
 * - Every SUBSCRIBE is refused. Observers only publish; letting one subscribe
 *   to `#` would hand it every other observer's raw feed.
 *
 * Nothing is ever routed onward or retained: no client may subscribe, and the
 * retain flag is cleared before Aedes stores it.
 *
 * Payload cap: Aedes and mqtt-packet have no packet size limit, so a client
 * could make the parser buffer a 256 MB packet. A passive reader on the socket
 * walks the MQTT fixed headers and destroys any connection that declares a
 * packet larger than the cap (plus header slack). `onPublish` then enforces the
 * exact payload cap.
 */
import { EventEmitter } from 'events';
import { createServer, type Server, type Socket } from 'net';
import { Aedes, type AedesPublishPacket, type Client } from 'aedes';
import { logger } from '../../utils/logger.js';

export type MeshCoreBrokerAuthDecision =
  | { ok: true }
  | { ok: false; returnCode: 2 | 3 | 4 | 5 };

export interface MeshCoreMqttBrokerOptions {
  port: number;
  host?: string;
  brokerId?: string;
  maxPayloadBytes: number;
  authenticate: (
    client: Client,
    username: string,
    password: Buffer | undefined,
  ) => Promise<MeshCoreBrokerAuthDecision>;
  onPublish: (client: Client, topic: string, payload: Buffer, retained: boolean) => void;
}

export interface MeshCoreMqttBrokerStatus {
  listening: boolean;
  port: number | null;
  host: string | null;
  clientCount: number;
  lastError: string | null;
}

/**
 * Room for a PUBLISH's topic, packet id and (MQTT 5) properties on top of the
 * payload, and for a CONNECT carrying a token. An observer topic is ~90 bytes.
 */
export const PACKET_HEADER_SLACK_BYTES = 2048;

/**
 * Passive MQTT framing reader. Feed it every chunk the socket delivers; it
 * returns false as soon as a packet declares a remaining length above `max`.
 * Exported for tests.
 */
export class MqttFrameSizeGuard {
  private state: 'header' | 'length' | 'body' = 'header';
  private lengthValue = 0;
  private lengthMultiplier = 1;
  private lengthBytes = 0;
  private bodyRemaining = 0;

  constructor(private readonly max: number) {}

  feed(chunk: Buffer): boolean {
    let i = 0;
    while (i < chunk.length) {
      if (this.state === 'header') {
        i++;
        this.state = 'length';
        this.lengthValue = 0;
        this.lengthMultiplier = 1;
        this.lengthBytes = 0;
      } else if (this.state === 'length') {
        const b = chunk[i++];
        this.lengthValue += (b & 0x7f) * this.lengthMultiplier;
        this.lengthMultiplier *= 128;
        this.lengthBytes++;
        if (this.lengthValue > this.max) return false;
        if ((b & 0x80) === 0) {
          this.bodyRemaining = this.lengthValue;
          this.state = this.bodyRemaining > 0 ? 'body' : 'header';
        } else if (this.lengthBytes >= 4) {
          return false; // malformed: a remaining length is at most 4 bytes
        }
      } else {
        const take = Math.min(this.bodyRemaining, chunk.length - i);
        i += take;
        this.bodyRemaining -= take;
        if (this.bodyRemaining === 0) this.state = 'header';
      }
    }
    return true;
  }
}

export class MeshCoreMqttBroker extends EventEmitter {
  private readonly options: MeshCoreMqttBrokerOptions;
  private aedes: Aedes | null = null;
  private server: Server | null = null;
  private listening = false;
  private lastError: string | null = null;
  private sockets = new Set<Socket>();
  private stopping: Promise<void> | null = null;

  constructor(options: MeshCoreMqttBrokerOptions) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.aedes) throw new Error('MeshCoreMqttBroker already started');

    const aedes = await Aedes.createBroker({ id: this.options.brokerId ?? 'meshmonitor-meshcore-broker' });
    this.aedes = aedes;

    aedes.authenticate = (client, username, password, done) => {
      const u = typeof username === 'string' ? username : '';
      this.options
        .authenticate(client, u, password ?? undefined)
        .then((decision) => {
          if (decision.ok) {
            done(null, true);
            return;
          }
          const err = new Error('Connection refused') as Error & { returnCode: number };
          err.returnCode = decision.returnCode;
          done(err as Parameters<typeof done>[0], false);
        })
        .catch((e: unknown) => {
          logger.debug(`[MeshCoreBroker] authenticate hook threw: ${e instanceof Error ? e.message : String(e)}`);
          const err = new Error('Server unavailable') as Error & { returnCode: number };
          err.returnCode = 3;
          done(err as Parameters<typeof done>[0], false);
        });
    };

    aedes.authorizePublish = (client, packet, callback) => {
      if (!client) {
        // An LWT published by Aedes itself for a client that already left.
        // Nobody can subscribe, so there is nothing to deliver it to.
        callback(null);
        return;
      }
      if (packet.topic.startsWith('$SYS/')) {
        callback(new Error('$SYS topic is reserved'));
        return;
      }
      const retained = !!packet.retain;
      // Nothing may be retained: no client can ever read it back.
      packet.retain = false;
      try {
        this.options.onPublish(client, packet.topic, toBuffer(packet.payload), retained);
      } catch (err) {
        logger.debug(
          `[MeshCoreBroker] publish hook threw on ${packet.topic}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      callback(null);
    };

    aedes.authorizeSubscribe = (_client, _subscription, callback) => {
      callback(null, null);
    };

    aedes.on('client', (client: Client) => this.emit('client-connected', client));
    aedes.on('clientDisconnect', (client: Client) => this.emit('client-disconnected', client));
    aedes.on('publish', (_packet: AedesPublishPacket, _client: Client | null) => {
      /* routed nowhere: see authorizeSubscribe */
    });

    const sockets = this.sockets;
    const frameLimit = this.options.maxPayloadBytes + PACKET_HEADER_SLACK_BYTES;
    this.server = createServer((socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {
        /* reported by Aedes; never crash the listener */
      });
      aedes.handle(socket);
      // Attached after Aedes' own 'readable' listener, so it observes the
      // chunks Aedes reads without changing the stream's flow mode.
      const guard = new MqttFrameSizeGuard(frameLimit);
      socket.on('data', (chunk: Buffer) => {
        if (!guard.feed(chunk)) {
          this.emit('oversize-connection', socket.remoteAddress ?? null);
          socket.destroy();
        }
      });
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
        logger.info(`MeshCore MQTT broker listening on ${host}:${port}`);
        resolve();
      });
    });

    this.server.on('error', (err) => {
      this.lastError = err.message;
      logger.error(`MeshCore MQTT broker server error: ${err.message}`);
    });
  }

  /** The port actually bound (useful when started on port 0 in tests). */
  boundPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  connectedClients(): number {
    return this.aedes?.connectedClients ?? 0;
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.teardown().finally(() => {
        this.stopping = null;
      });
    }
    return this.stopping;
  }

  private async teardown(): Promise<void> {
    this.listening = false;
    const server = this.server;
    const aedes = this.aedes;
    const sockets = this.sockets;
    this.sockets = new Set<Socket>();
    this.server = null;
    this.aedes = null;

    // Close clients before waiting on the listener: net.Server.close waits
    // for every open connection (#5264).
    const serverClosed = server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (aedes) await boundedWait(new Promise<void>((resolve) => aedes.close(() => resolve())), 'Aedes close');
    await boundedWait(serverClosed, 'listener close');
  }

  getStatus(): MeshCoreMqttBrokerStatus {
    return {
      listening: this.listening,
      port: this.listening ? (this.boundPort() ?? this.options.port) : null,
      host: this.listening ? (this.options.host ?? '0.0.0.0') : null,
      clientCount: this.connectedClients(),
      lastError: this.lastError,
    };
  }
}

const STOP_STEP_TIMEOUT_MS = 5000;

async function boundedWait(p: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    p.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), STOP_STEP_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) logger.warn(`MeshCore MQTT broker stop: ${label} did not finish in time; continuing`);
}

function toBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.alloc(0);
}
