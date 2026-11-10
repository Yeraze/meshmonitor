/**
 * One-shot MQTT root sampler (#6287, design#167 R1/R2).
 *
 * Connects to a broker with a fresh client ID, subscribes to the adapter's
 * topic filters for a fixed time, counts what it hears per root, then
 * disconnects. It subscribes only. It never publishes, sets no will, decodes
 * nothing but map-report positions, stores nothing, and touches no database,
 * source manager, event bus or notification service. Mesh impact: none.
 */

import { MqttBrokerClient, type MqttBrokerClientOptions } from '../../transports/mqttBrokerClient.js';
import { redactBrokerUrl } from '../../utils/brokerUrl.js';
import { logger } from '../../../utils/logger.js';
import { FLOOD_CAP, type HeardRoot, type LatLon } from './ladder.js';
import type { RootAdapter } from './rootAdapter.js';

export const SAMPLE_DURATION_MS = 60_000;
export const SAMPLE_CONNECT_TIMEOUT_MS = 10_000;
/** Payloads larger than this are ignored. Real Meshtastic packets are far smaller. */
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_ROOTS = 1000;
export const MAX_NODES_PER_ROOT = 500;
export const MAX_MESSAGES = 50_000;

/** Coarse on purpose. Raw broker or socket text never leaves the sampler. */
export type SamplerErrorCode =
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'AUTH_REJECTED'
  | 'SUBSCRIBE_DENIED'
  | 'EVICTED'
  | 'BLOCKED_TARGET';

export type SamplerStatus = 'connecting' | 'sampling' | 'done' | 'failed' | 'cancelled';

/** The part of MqttBrokerClient the sampler uses. Lets tests inject a fake. */
export interface SamplerClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): Promise<void>;
  subscribe(topics: string[]): Promise<void>;
  unsubscribe(topics: string[]): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getLastError(): string | null;
  getCapabilities(): { canSubscribe: boolean };
}

export interface RootSamplerOptions {
  broker: { url: string; username?: string; password?: string };
  regionRoot: string;
  adapter: RootAdapter;
  durationMs?: number;
  /** Test seam. Defaults to a real MqttBrokerClient. */
  createClient?: (opts: MqttBrokerClientOptions) => SamplerClient;
}

export interface SamplerSnapshot {
  status: SamplerStatus;
  elapsedMs: number;
  durationMs: number;
  regionFloor: boolean;
  /** Includes map positions. The service strips them before any response. */
  heard: HeardRoot[];
  error?: SamplerErrorCode;
}

interface RootState {
  messages: number;
  live: number;
  nodes: Set<string>;
  positions: Map<string, LatLon>;
}

/** Options for the sampler's client. Exported so tests can assert on them. */
export function buildSamplerClientOptions(broker: RootSamplerOptions['broker']): MqttBrokerClientOptions {
  return {
    url: broker.url,
    username: broker.username,
    password: broker.password,
    // Always a fresh random ID. Never a configured one: reusing a bridge's ID
    // would evict the running bridge (#5893).
    clientIdPrefix: 'mm-roots',
    // No `will`: the broker must publish nothing on our behalf.
    maxAuthFailures: 1,
    maxEvictions: 1,
    autoReconnect: false,
    connectTimeoutMs: SAMPLE_CONNECT_TIMEOUT_MS,
  };
}

export class RootSampler {
  private readonly opts: RootSamplerOptions;
  private readonly durationMs: number;
  private client: SamplerClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private status: SamplerStatus = 'connecting';
  private error: SamplerErrorCode | undefined;
  private startedAt = 0;
  private endedAt = 0;
  private regionEMessages = 0;
  private regionFloor = false;
  private regionCut = false;
  private totalMessages = 0;
  private readonly roots = new Map<string, RootState>();
  private authRejected = false;
  private evicted = false;
  private finished: Promise<void> | null = null;
  private resolveFinished: (() => void) | null = null;
  private readonly done: Promise<void>;

  constructor(opts: RootSamplerOptions) {
    this.opts = opts;
    this.durationMs = opts.durationMs ?? SAMPLE_DURATION_MS;
    this.done = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  /** Resolves when the sample reaches a final state. */
  whenDone(): Promise<void> {
    return this.done;
  }

  getStatus(): SamplerStatus {
    return this.status;
  }

  /** Epoch ms when the sample reached a final state, else null. */
  getEndedAt(): number | null {
    return this.endedAt || null;
  }

  snapshot(): SamplerSnapshot {
    const end = this.endedAt || Date.now();
    const elapsed = this.startedAt ? Math.min(Math.max(0, end - this.startedAt), this.durationMs) : 0;
    const heard: HeardRoot[] = [];
    for (const [root, st] of this.roots) {
      const capped = root === this.opts.regionRoot ? this.regionFloor : false;
      heard.push({
        root,
        nodes: st.nodes.size,
        messages: st.messages,
        retainedOnly: st.live === 0 && st.messages > 0,
        ...(capped || st.messages >= FLOOD_CAP ? { floor: true } : {}),
        ...(st.positions.size ? { positions: [...st.positions.values()] } : {}),
      });
    }
    return {
      status: this.status,
      elapsedMs: elapsed,
      durationMs: this.durationMs,
      regionFloor: this.regionFloor,
      heard,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Connect, subscribe and start the timer. Never throws. */
  async start(): Promise<void> {
    if (this.client || this.status !== 'connecting') return;
    const clientOpts = buildSamplerClientOptions(this.opts.broker);
    const client = this.opts.createClient
      ? this.opts.createClient(clientOpts)
      : (new MqttBrokerClient(clientOpts) as unknown as SamplerClient);
    this.client = client;

    client.on('message', (msg: { topic: string; payload: Buffer; retained: boolean }) =>
      this.onMessage(msg.topic, msg.payload, msg.retained),
    );
    client.on('permission-denied', (info: { kind: 'subscribe' | 'auth' }) => {
      if (info?.kind === 'auth') this.authRejected = true;
    });
    client.on('auth-stopped', () => {
      this.authRejected = true;
    });
    client.on('eviction-stopped', () => {
      this.evicted = true;
    });
    // Errors are classified, never forwarded. Swallow so an EventEmitter
    // 'error' with no listener can never crash the process.
    client.on('error', () => undefined);
    client.on('close', () => {
      // An unexpected close while sampling ends the sample. Teardown by
      // finish() clears the client first, so this only sees real drops.
      if (this.status === 'sampling' && this.client === client) {
        void this.finish('failed', 'EVICTED');
      }
    });

    try {
      await client.connect();
    } catch {
      /* classified below */
    }
    if (this.status !== 'connecting') return; // cancelled while connecting

    if (!client.isConnected()) {
      void this.finish('failed', this.classifyConnectFailure(client));
      return;
    }

    this.status = 'sampling';
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.finish('done');
    }, this.durationMs);

    try {
      await client.subscribe(this.opts.adapter.filters(this.opts.regionRoot));
    } catch {
      if (this.status === 'sampling') void this.finish('failed', 'SUBSCRIBE_DENIED');
      return;
    }
    // canSubscribe is false only when every filter was denied.
    if (this.status === 'sampling' && !client.getCapabilities().canSubscribe) {
      void this.finish('failed', 'SUBSCRIBE_DENIED');
    }
  }

  /** Stop early. Partial results stay readable. */
  cancel(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'sampling') {
      return this.finish('cancelled');
    }
    return this.done;
  }

  private classifyConnectFailure(client: SamplerClient): SamplerErrorCode {
    if (this.authRejected) return 'AUTH_REJECTED';
    if (this.evicted) return 'EVICTED';
    const msg = (client.getLastError() ?? '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return 'TIMEOUT';
    return 'UNREACHABLE';
  }

  private onMessage(topic: string, payload: Buffer, retained: boolean): void {
    if (this.status !== 'sampling') return;
    if (payload.length > MAX_PAYLOAD_BYTES) return;
    if (this.totalMessages >= MAX_MESSAGES) {
      void this.finish('done');
      return;
    }
    const obs = this.opts.adapter.classify(topic, payload);
    if (!obs) return;
    this.totalMessages++;

    let st = this.roots.get(obs.root);
    if (!st) {
      if (this.roots.size >= MAX_ROOTS) return;
      st = { messages: 0, live: 0, nodes: new Set(), positions: new Map() };
      this.roots.set(obs.root, st);
    }
    st.messages++;
    if (!retained) st.live++;
    if (obs.nodeKey && (st.nodes.has(obs.nodeKey) || st.nodes.size < MAX_NODES_PER_ROOT)) {
      st.nodes.add(obs.nodeKey);
      if (obs.pos) st.positions.set(obs.nodeKey, obs.pos);
    }

    // The region's own packet stream is the flood. Cut it after the cap and
    // keep the count as a floor.
    if (obs.root === this.opts.regionRoot && obs.stream === 'e' && !this.regionCut) {
      this.regionEMessages++;
      if (this.regionEMessages >= FLOOD_CAP) {
        this.regionCut = true;
        this.regionFloor = true;
        const capped = this.opts.adapter.cappedFilter(this.opts.regionRoot);
        if (capped && this.client) {
          void this.client.unsubscribe([capped]).catch(() => undefined);
        }
      }
    }
  }

  private finish(status: 'done' | 'failed' | 'cancelled', error?: SamplerErrorCode): Promise<void> {
    if (this.finished) return this.finished;
    if (this.status === 'done' || this.status === 'failed' || this.status === 'cancelled') {
      return this.done;
    }
    this.status = status;
    if (error) this.error = error;
    this.endedAt = Date.now();
    if (!this.startedAt) this.startedAt = this.endedAt;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const client = this.client;
    this.client = null;
    this.finished = (async () => {
      try {
        if (client) await client.disconnect();
      } catch {
        /* nothing to do: the sample is over */
      } finally {
        logger.debug(
          `MQTT root sample ${status}${error ? ` (${error})` : ''} on ${redactBrokerUrl(this.opts.broker.url)}`,
        );
        this.resolveFinished?.();
      }
    })();
    return this.finished;
  }
}
