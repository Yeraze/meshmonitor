/**
 * Reliable PKI (issue #5691; supersedes #5690).
 *
 * PKI is mutual: a node can only read our PKI-encrypted packet if it holds OUR
 * public key. Small NodeDBs drop it, and then every DM or data request we send
 * that node is silently lost. In "As needed" mode MeshMonitor watches whether
 * its PKI exchanges with each node get an answer, and when the last one failed
 * it sends that node our NodeInfo (carrying our public key) before the next PKI
 * send — at most once an hour per node per source.
 *
 * State per (source, node), stored in `pki_exchange_state`:
 *
 *   - A PKI send that asks for something back (`want_ack` or `want_response`)
 *     moves the node to `pending`. A send with neither flag changes nothing.
 *   - `successful` when the node answers: the reply to a `want_response`
 *     request, its ack of a `want_ack` packet, or any routing answer that
 *     proves it decrypted the packet (NO_RESPONSE, NOT_AUTHORIZED, ...).
 *     An implicit ack (our own radio overhearing a relay) is NOT an answer.
 *   - `failed` on the first of:
 *       * the node says PKI_UNKNOWN_PUBKEY or NO_CHANNEL (it could not decrypt);
 *       * our radio reports MAX_RETRANSMIT (the firmware's own delivery timeout);
 *       * our radio refuses to encrypt (PKI_FAILED / PKI_SEND_FAIL_PUBLIC_KEY);
 *       * {@link PKI_EXCHANGE_TIMEOUT_MS} passes with no answer.
 *     One failure is enough: a false "failed" costs one NodeInfo (capped
 *     hourly), a false "ok" costs a request that keeps failing in silence.
 *
 * The in-flight map is memory-only. After a restart a row left `pending` stays
 * `pending` (shown as "unknown"), so a restart can never cause a priming send.
 */
import { logger } from '../../utils/logger.js';
import { RoutingError } from '../constants/meshtastic.js';
import type {
  PkiExchangeStateRow,
  PkiFailureReason,
} from '../../db/repositories/pkiExchangeState.js';

export type ReliablePkiMode = 'off' | 'asNeeded';

/** Global default. Values: `off` (default) | `asNeeded`. */
export const RELIABLE_PKI_MODE_KEY = 'reliablePkiMode';
/**
 * Per-source override, read with the source-scoped key (#5080). Values:
 * `inherit` (or absent) | `off` | `asNeeded`. A separate key from the global
 * one so the merged `GET /api/settings?sourceId=` view can tell "this source
 * has no override" from "this source overrides to the same value".
 */
export const RELIABLE_PKI_SOURCE_MODE_KEY = 'reliablePkiSourceMode';

export const RELIABLE_PKI_MODES: readonly ReliablePkiMode[] = ['off', 'asNeeded'];
export const RELIABLE_PKI_SOURCE_MODES = ['inherit', 'off', 'asNeeded'] as const;
export type ReliablePkiSourceMode = typeof RELIABLE_PKI_SOURCE_MODES[number];

/** At most one priming NodeInfo per node per source in this window. */
export const PRIMING_MIN_INTERVAL_MS = 60 * 60 * 1000;
/**
 * How long a PKI exchange may stay unanswered before it counts as failed.
 * Matches the telemetry-request TTL MeshMonitor already uses (3 min), which
 * covers a multi-hop reply plus the firmware's 3 retransmissions.
 */
export const PKI_EXCHANGE_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * Gap between the priming NodeInfo and the real message. The NodeInfo must be
 * through our radio's queue and on its way first (~1 s airtime on LongFast,
 * plus channel-access backoff); both packets then follow the same flood path,
 * so the NodeInfo keeps its lead. Short enough that a DM send from the UI still
 * returns well inside the 30 s request timeout.
 */
export const PRIMING_GAP_MS = 5_000;
/** How often pending exchanges are checked against the deadline. */
export const PKI_SWEEP_INTERVAL_MS = 30_000;
/** Upper bound on tracked in-flight exchanges per source. */
export const PKI_MAX_TRACKED = 512;

/** Routing errors a destination only sends after it decrypted our packet. */
const DECODED_ROUTING_REPLIES: ReadonlySet<number> = new Set([
  RoutingError.NONE,
  RoutingError.NO_RESPONSE,
  RoutingError.BAD_REQUEST,
  RoutingError.NOT_AUTHORIZED,
  RoutingError.ADMIN_BAD_SESSION_KEY,
  RoutingError.ADMIN_PUBLIC_KEY_UNAUTHORIZED,
  RoutingError.RATE_LIMIT_EXCEEDED,
]);

export function parseReliablePkiMode(value: unknown): ReliablePkiMode | null {
  return value === 'off' || value === 'asNeeded' ? value : null;
}

export function isValidReliablePkiSourceMode(value: unknown): value is ReliablePkiSourceMode {
  return typeof value === 'string' && (RELIABLE_PKI_SOURCE_MODES as readonly string[]).includes(value);
}

interface SettingsReader {
  getSetting(key: string): Promise<string | null>;
  getSettingForSource(sourceId: string | null | undefined, key: string): Promise<string | null>;
}

/**
 * The mode in effect for one source: its own override when set, else the
 * global default, else `off`. The override is read with the source-scoped key.
 */
export async function resolveReliablePkiMode(settings: SettingsReader, sourceId: string): Promise<ReliablePkiMode> {
  const override = parseReliablePkiMode(await settings.getSettingForSource(sourceId, RELIABLE_PKI_SOURCE_MODE_KEY));
  if (override) return override;
  return parseReliablePkiMode(await settings.getSetting(RELIABLE_PKI_MODE_KEY)) ?? 'off';
}

export interface PkiStateStore {
  getState(sourceId: string, nodeNum: number): Promise<PkiExchangeStateRow | null>;
  markPending(sourceId: string, nodeNum: number, now?: number): Promise<PkiExchangeStateRow>;
  markSuccessful(sourceId: string, nodeNum: number, now?: number): Promise<PkiExchangeStateRow>;
  markFailed(sourceId: string, nodeNum: number, reason: PkiFailureReason, now?: number): Promise<PkiExchangeStateRow>;
  recordPriming(sourceId: string, nodeNum: number, now?: number): Promise<PkiExchangeStateRow>;
}

export interface ReliablePkiDeps {
  sourceId: string;
  store: PkiStateStore;
  getMode(): Promise<ReliablePkiMode>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** What the manager knows about the send, supplied per priming decision. */
export interface PrimingHooks {
  /** Not the local node, not ignored, MeshMonitor holds its key, no key mismatch. */
  isEligibleTarget(): Promise<boolean>;
  /** Null when we may transmit now; otherwise why not (not connected, TX off, airtime cutoff). */
  txBlockedReason(): Promise<string | null>;
  /** Send the priming NodeInfo. Throws when it could not be sent. */
  sendNodeInfo(): Promise<void>;
}

export type PrimingOutcome =
  | 'off' | 'not_failed' | 'window_closed' | 'in_progress' | 'ineligible' | 'tx_blocked' | 'send_failed' | 'primed';

interface InFlight {
  nodeNum: number;
  sentAt: number;
}

const hex = (n: number): string => `!${(n >>> 0).toString(16).padStart(8, '0')}`;

/**
 * Per-source tracker. One instance per MeshtasticManager.
 */
export class ReliablePkiTracker {
  private readonly inFlight = new Map<number, InFlight>();
  private readonly primingNow = new Set<number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ReliablePkiDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Number of exchanges waiting for an answer (tests, diagnostics). */
  get trackedCount(): number {
    return this.inFlight.size;
  }

  /**
   * Record a PKI send. Only a send that asks for something back changes the
   * node's state (maintainer rule on #5691).
   */
  async track(packetId: number, nodeNum: number, flags: { wantAck: boolean; wantResponse: boolean }): Promise<void> {
    if (!packetId || !nodeNum) return;
    if (!flags.wantAck && !flags.wantResponse) return;
    const now = this.now();
    this.inFlight.set(packetId >>> 0, { nodeNum: nodeNum >>> 0, sentAt: now });
    // Bound the map. An evicted exchange is dropped, not settled: its row
    // stays `pending` (read as "unknown" after the deadline), the same as an
    // exchange lost to a restart. Never marking it failed means eviction can
    // never cause a priming send.
    while (this.inFlight.size > PKI_MAX_TRACKED) {
      const oldest = this.inFlight.keys().next().value;
      if (oldest === undefined) break;
      this.inFlight.delete(oldest);
    }
    this.ensureSweep();
    try {
      await this.deps.store.markPending(this.deps.sourceId, nodeNum >>> 0, now);
    } catch (error) {
      logger.debug(`Reliable PKI: could not mark ${hex(nodeNum)} pending:`, error);
    }
  }

  /** A non-routing packet arrived. A reply to one of our requests settles it as successful. */
  async observeReply(fromNum: number, requestId: number | null | undefined): Promise<void> {
    if (!requestId) return;
    const entry = this.inFlight.get(requestId >>> 0);
    if (!entry || entry.nodeNum !== fromNum >>> 0) return;
    this.inFlight.delete(requestId >>> 0);
    await this.settle(entry.nodeNum, null);
  }

  /** A routing packet (ack / nak) arrived for one of our packets. */
  async observeRouting(
    fromNum: number,
    requestId: number | null | undefined,
    errorReason: number | null | undefined,
    localNodeNum: number | null | undefined,
  ): Promise<void> {
    if (!requestId) return;
    const key = requestId >>> 0;
    const entry = this.inFlight.get(key);
    if (!entry) return;
    const reason = typeof errorReason === 'number' ? errorReason : RoutingError.NONE;
    const from = fromNum >>> 0;

    if (from === entry.nodeNum) {
      if (reason === RoutingError.PKI_UNKNOWN_PUBKEY || reason === RoutingError.NO_CHANNEL) {
        this.inFlight.delete(key);
        await this.settle(entry.nodeNum, reason === RoutingError.PKI_UNKNOWN_PUBKEY ? 'pki_unknown_pubkey' : 'no_channel');
        if (reason === RoutingError.PKI_UNKNOWN_PUBKEY) {
          // Our radio answers this NAK by sending the node our NodeInfo on its
          // own (firmware ReliableRouter, since 2.5). Count it against the
          // hourly window so MeshMonitor does not send a second one.
          await this.safe(() => this.deps.store.recordPriming(this.deps.sourceId, entry.nodeNum, this.now()));
          logger.debug(`Reliable PKI: ${hex(entry.nodeNum)} does not hold our key (PKI_UNKNOWN_PUBKEY); the radio sent it our NodeInfo`);
        }
        return;
      }
      if (DECODED_ROUTING_REPLIES.has(reason)) {
        this.inFlight.delete(key);
        await this.settle(entry.nodeNum, null);
      }
      return;
    }

    if (localNodeNum != null && from === localNodeNum >>> 0) {
      // NONE from our own radio is an implicit ack (a relay was overheard):
      // it says nothing about whether the node could read the packet.
      if (reason === RoutingError.MAX_RETRANSMIT) {
        this.inFlight.delete(key);
        await this.settle(entry.nodeNum, 'max_retransmit');
      } else if (reason === RoutingError.PKI_FAILED || reason === RoutingError.PKI_SEND_FAIL_PUBLIC_KEY) {
        this.inFlight.delete(key);
        await this.settle(entry.nodeNum, 'radio_refused');
      }
    }
    // Anything from an intermediate node is ignored: it may have reached the
    // destination another way.
  }

  /** Mark exchanges past the deadline as failed. Called by the sweep timer. */
  async sweep(): Promise<void> {
    const now = this.now();
    const expired: InFlight[] = [];
    for (const [packetId, entry] of this.inFlight) {
      if (now - entry.sentAt >= PKI_EXCHANGE_TIMEOUT_MS) {
        this.inFlight.delete(packetId);
        expired.push(entry);
      }
    }
    for (const entry of expired) {
      // A later exchange with the same node may still be in flight; it will
      // settle on its own. The newest outcome wins.
      await this.settle(entry.nodeNum, 'timeout');
    }
    if (this.inFlight.size === 0) this.stopSweep();
  }

  /**
   * Run before a PKI send to `nodeNum`. Sends one priming NodeInfo when the
   * mode is As needed, the last exchange failed, and none went to this node in
   * the last hour. Never throws; a failure to prime leaves the real send as is.
   */
  async primeBeforeSend(nodeNum: number, hooks: PrimingHooks): Promise<PrimingOutcome> {
    const node = nodeNum >>> 0;
    // Synchronous guard: two sends to one node at once must not both prime.
    if (this.primingNow.has(node)) return 'in_progress';
    this.primingNow.add(node);
    try {
      if ((await this.deps.getMode()) !== 'asNeeded') return 'off';
      const row = await this.deps.store.getState(this.deps.sourceId, node);
      if (!row || row.state !== 'failed') return 'not_failed';
      const now = this.now();
      if (row.lastPrimedAt != null && now - row.lastPrimedAt < PRIMING_MIN_INTERVAL_MS) return 'window_closed';
      if (!(await hooks.isEligibleTarget())) return 'ineligible';
      const blocked = await hooks.txBlockedReason();
      if (blocked) {
        logger.debug(`Reliable PKI: not priming ${hex(node)} (${blocked}); sending without it`);
        return 'tx_blocked';
      }
      // Stamp the hourly timer BEFORE the send. A send that throws part-way
      // (after the frame reached the radio) must still count, or a flaky
      // error path could prime the same node over and over.
      await this.deps.store.recordPriming(this.deps.sourceId, node, now);
      try {
        await hooks.sendNodeInfo();
      } catch (error) {
        logger.debug(`Reliable PKI: priming NodeInfo to ${hex(node)} failed; sending without it:`, error);
        return 'send_failed';
      }
      logger.debug(
        `Reliable PKI: sent NodeInfo to ${hex(node)} on source ${this.deps.sourceId} before a PKI send ` +
        `(last exchange failed: ${row.lastFailureReason ?? 'unknown'}); next send in ${PRIMING_GAP_MS / 1000}s`,
      );
      await this.sleep(PRIMING_GAP_MS);
      return 'primed';
    } catch (error) {
      logger.debug(`Reliable PKI: priming check for ${hex(node)} failed; sending without it:`, error);
      return 'send_failed';
    } finally {
      this.primingNow.delete(node);
    }
  }

  stop(): void {
    this.stopSweep();
    this.inFlight.clear();
  }

  private async settle(nodeNum: number, failure: PkiFailureReason | null): Promise<void> {
    const now = this.now();
    await this.safe(() => failure
      ? this.deps.store.markFailed(this.deps.sourceId, nodeNum, failure, now)
      : this.deps.store.markSuccessful(this.deps.sourceId, nodeNum, now));
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.debug('Reliable PKI: state write failed:', error);
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, PKI_SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
