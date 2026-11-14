/**
 * Upstream forwarding for the embedded MeshCore MQTT broker (#6197).
 *
 * Off by default. Each enabled target holds one outbound MQTT client that only
 * ever PUBLISHES: it never subscribes, so nothing an upstream broker carries can
 * come back in through this path. Only frames the embedded broker already
 * accepted (auth, rate limit, decode) reach `forward()`, so the per-connection
 * limits cap forwarding too.
 *
 * Two identity modes per target (binding decision 6):
 *
 * - `passthrough`: the original topic and body, verbatim, logged in with the
 *   target's static username/password. Keeps per-observer attribution.
 *   Token-only brokers (LetsMesh) refuse it.
 * - `own`: rewritten under MeshMonitor's own observer key (sealed in the
 *   observer key store, keyed by this source's id), logged in with a minted
 *   token. Upstream sees one observer. Observer `/status` heartbeats are NOT
 *   relayed in this mode: one observer going offline would mark the whole
 *   MeshMonitor identity offline. The target publishes its own online status
 *   on connect and an offline LWT instead.
 *
 * Loop guard: every payload this module publishes is reported through
 * `onForwarded`, and the broker drops an incoming publish whose payload it
 * forwarded moments ago.
 *
 * Credentials (passwords, tokens) never reach a log line or a status field.
 */
import { MqttBrokerClient, type MqttBrokerClientOptions } from '../transports/mqttBrokerClient.js';
import { redactBrokerUrl } from '../utils/brokerUrl.js';
import { logger } from '../../utils/logger.js';
import { mintObserverToken } from './meshcoreObserverToken.js';
import { buildObserverStatusPayload, observerTopics } from './meshcoreObserverPacket.js';
import type { NormalizedForwardTarget } from './meshcoreMqttBrokerConfig.js';

/** Rejected logins in a row before a target stops reconnecting. */
const MAX_AUTH_FAILURES = 5;
/** How often own-identity targets check their token. */
const RENEWAL_CHECK_MS = 3_600_000;

const TOKEN_SHAPE_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[0-9A-Fa-f]{128}/g;

export interface ForwardMessage {
  kind: 'packets' | 'status';
  topic: string;
  payload: Buffer;
  retained: boolean;
  /** Region segment of the original topic, as published. */
  iata: string;
  /** Upper-case observer key (topic key, already cross-checked with the body). */
  observerKey: string;
  /** Parsed JSON body. */
  body: Record<string, unknown>;
}

export interface OwnIdentityKey {
  privateKeyHex: string;
  publicKey: string;
}

export interface ForwardTargetStatus {
  id: string;
  label: string;
  url: string;
  identityMode: 'passthrough' | 'own';
  connected: boolean;
  forwarded: number;
  dropped: number;
  lastError: string | null;
  authStopped: boolean;
}

export interface MeshCoreBrokerForwarderOptions {
  sourceId: string;
  targets: NormalizedForwardTarget[];
  ownIdentityName: string;
  /** Region for own-identity status when a target has no IATA filter. */
  fallbackRegion: string;
  loadOwnKey: () => Promise<OwnIdentityKey | null>;
  onForwarded: (payload: Buffer) => void;
  createClient?: (opts: MqttBrokerClientOptions) => MqttBrokerClient;
}

interface TargetRuntime {
  target: NormalizedForwardTarget;
  client: MqttBrokerClient | null;
  ownPublicKey: string | null;
  tokenExpiresAt: number | null;
  forwarded: number;
  dropped: number;
  lastError: string | null;
  authStopped: boolean;
}

function scrub(message: string, secrets: Array<string | null>): string {
  let out = message.replace(TOKEN_SHAPE_PATTERN, '[token]');
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out;
}

export class MeshCoreBrokerForwarder {
  private readonly opts: MeshCoreBrokerForwarderOptions;
  private readonly runtimes: TargetRuntime[];
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: MeshCoreBrokerForwarderOptions) {
    this.opts = opts;
    this.runtimes = opts.targets.map((target) => ({
      target,
      client: null,
      ownPublicKey: null,
      tokenExpiresAt: null,
      forwarded: 0,
      dropped: 0,
      lastError: null,
      authStopped: false,
    }));
  }

  hasTargets(): boolean {
    return this.runtimes.length > 0;
  }

  /** Open every target's client. Never throws: a failed target only records its error. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await Promise.all(this.runtimes.map((rt) => this.openTarget(rt)));
    if (this.runtimes.some((rt) => rt.target.identityMode === 'own')) {
      this.renewalTimer = setInterval(() => void this.renewTokens(), RENEWAL_CHECK_MS);
      this.renewalTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = null;
    await Promise.all(this.runtimes.map((rt) => this.closeTarget(rt)));
  }

  /** Relay one accepted frame to every target whose filters match. */
  forward(msg: ForwardMessage): void {
    for (const rt of this.runtimes) {
      const t = rt.target;
      if (!t.observers.has(msg.observerKey)) continue;
      if (t.iataFilter.size > 0 && !t.iataFilter.has(msg.iata.toUpperCase())) continue;

      let topic: string;
      let payload: Buffer;
      let retained = false;
      if (t.identityMode === 'passthrough') {
        topic = msg.topic;
        payload = msg.payload;
        retained = msg.retained;
      } else {
        if (msg.kind === 'status') continue; // see the file header
        if (!rt.ownPublicKey) {
          rt.dropped++;
          continue;
        }
        topic = observerTopics(msg.iata, rt.ownPublicKey).packets;
        payload = Buffer.from(
          JSON.stringify({ ...msg.body, origin: this.opts.ownIdentityName, origin_id: rt.ownPublicKey }),
        );
      }

      const client = rt.client;
      if (!client || !client.isConnected()) {
        rt.dropped++;
        continue;
      }
      this.opts.onForwarded(payload);
      client.publish(topic, payload, retained).then(
        () => {
          rt.forwarded++;
        },
        (err: unknown) => {
          rt.dropped++;
          rt.lastError = this.scrubFor(rt, err instanceof Error ? err.message : String(err));
        },
      );
    }
  }

  getStatus(): ForwardTargetStatus[] {
    return this.runtimes.map((rt) => ({
      id: rt.target.id,
      label: rt.target.label,
      url: redactBrokerUrl(rt.target.url),
      identityMode: rt.target.identityMode,
      connected: rt.client?.isConnected() ?? false,
      forwarded: rt.forwarded,
      dropped: rt.dropped,
      lastError: rt.lastError,
      authStopped: rt.authStopped,
    }));
  }

  private scrubFor(rt: TargetRuntime, message: string): string {
    return scrub(message, [rt.target.password, rt.target.username]);
  }

  private async openTarget(rt: TargetRuntime): Promise<void> {
    const t = rt.target;
    let options: MqttBrokerClientOptions;
    try {
      if (t.identityMode === 'passthrough') {
        options = {
          url: t.url,
          username: t.username ?? undefined,
          password: t.password ?? undefined,
          clientIdPrefix: 'meshmonitor-mcbroker-fwd',
          rejectUnauthorized: t.rejectUnauthorized,
          maxAuthFailures: MAX_AUTH_FAILURES,
        };
      } else {
        const key = await this.opts.loadOwnKey();
        if (!key) {
          rt.lastError = 'No MeshMonitor observer key is stored for this source; own-identity forwarding is off';
          return;
        }
        if (!t.tokenAudience) {
          rt.lastError = 'No token audience is set for this target';
          return;
        }
        const token = await mintObserverToken(key.privateKeyHex, t.tokenAudience);
        rt.ownPublicKey = token.publicKey;
        rt.tokenExpiresAt = token.expiresAt * 1000;
        const identity = { origin: this.opts.ownIdentityName, originId: token.publicKey };
        const topics = observerTopics(this.firstRegion(t), token.publicKey);
        options = {
          url: t.url,
          username: `v1_${token.publicKey}`,
          password: token.token,
          clientIdPrefix: 'meshmonitor-mcbroker-fwd',
          rejectUnauthorized: t.rejectUnauthorized,
          maxAuthFailures: MAX_AUTH_FAILURES,
          keepalive: 60,
          will: {
            topic: topics.status,
            payload: Buffer.from(JSON.stringify(buildObserverStatusPayload('offline', identity))),
            qos: 0,
            retain: true,
          },
        };
      }
    } catch (err) {
      rt.lastError = this.scrubFor(rt, err instanceof Error ? err.message : String(err));
      return;
    }

    const create = this.opts.createClient ?? ((o: MqttBrokerClientOptions) => new MqttBrokerClient(o));
    let client: MqttBrokerClient;
    try {
      client = create(options);
    } catch (err) {
      rt.lastError = this.scrubFor(rt, err instanceof Error ? err.message : String(err));
      return;
    }
    rt.client = client;
    rt.authStopped = false;
    client.on('connect', () => {
      rt.lastError = null;
      if (t.identityMode === 'own' && rt.ownPublicKey) void this.publishOwnOnline(rt, client);
    });
    client.on('error', (err: unknown) => {
      rt.lastError = this.scrubFor(rt, err instanceof Error ? err.message : String(err));
    });
    client.on('auth-stopped', () => {
      rt.authStopped = true;
      rt.lastError = `Upstream broker rejected the login ${MAX_AUTH_FAILURES} times in a row; forwarding to it stopped until the source is saved or reconnected`;
      logger.warn(`[MeshCoreBroker:${this.opts.sourceId}] forward target ${t.label} stopped after rejected logins`);
    });
    // Do not block start-up on a slow or dead upstream.
    client.connect().catch((err: unknown) => {
      rt.lastError = this.scrubFor(rt, err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Region for our own `/status` topic: the target's first IATA filter, else
   * the broker-wide fallback (the first allowed region, or `test`).
   */
  private firstRegion(t: NormalizedForwardTarget): string {
    const first = t.iataFilter.values().next();
    return first.done ? this.opts.fallbackRegion : first.value;
  }

  private async publishOwnOnline(rt: TargetRuntime, client: MqttBrokerClient): Promise<void> {
    if (!rt.ownPublicKey) return;
    const identity = { origin: this.opts.ownIdentityName, originId: rt.ownPublicKey };
    const topic = observerTopics(this.firstRegion(rt.target), rt.ownPublicKey).status;
    const payload = Buffer.from(JSON.stringify(buildObserverStatusPayload('online', identity)));
    this.opts.onForwarded(payload);
    try {
      await client.publish(topic, payload, true);
    } catch (err) {
      rt.lastError = this.scrubFor(rt, err instanceof Error ? err.message : String(err));
    }
  }

  private async closeTarget(rt: TargetRuntime): Promise<void> {
    const client = rt.client;
    rt.client = null;
    if (!client) return;
    client.removeAllListeners();
    client.on('error', () => {});
    try {
      await client.disconnect();
    } catch (err) {
      logger.debug(`[MeshCoreBroker:${this.opts.sourceId}] error closing forward client: ${this.scrubFor(rt, String(err))}`);
    }
  }

  /** Reopen own-identity targets whose token is close to expiry, so a reconnect still logs in. */
  private async renewTokens(): Promise<void> {
    if (!this.running) return;
    const horizon = Date.now() + RENEWAL_CHECK_MS + 5 * 60_000;
    for (const rt of this.runtimes) {
      if (rt.target.identityMode !== 'own' || rt.authStopped) continue;
      if (rt.tokenExpiresAt !== null && rt.tokenExpiresAt > horizon) continue;
      await this.closeTarget(rt);
      if (this.running) await this.openTarget(rt);
    }
  }
}
