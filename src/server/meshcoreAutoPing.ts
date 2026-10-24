/**
 * MeshCore Auto Ping (#5953): the `ping N` / `ping stop` DM command, ported
 * from the Meshtastic Auto Ping (meshtasticManager.ts, "Auto-Ping Methods").
 *
 * Companion sources only. A requester DMs `ping N`; we DM back N short pings
 * (`Ping 3/20`) at the configured interval. Each ping is one DM with no
 * retry. The firmware's `SendConfirmed` push (0x82, ack code + trip time)
 * marks it ACKed with that RTT; no ACK inside the timeout marks it timed out.
 * Each ping also records whether it went direct (the contact had a known out
 * path when we sent it) or flood. A summary DM ends the session.
 *
 * Mesh impact: limits and defaults mirror Meshtastic exactly (off by default,
 * 1-100 pings, interval >= 10 s, timeout >= 10 s, one session per requester).
 * Sessions live in memory only, so a restart ends them and never resumes
 * them, and a settings save never starts, restarts or re-arms one.
 *
 * The controller owns no radio code. The manager passes in a host that sends,
 * looks up contacts and reads settings, so the logic is testable on its own.
 */
import { logger } from '../utils/logger.js';
import { MESHCORE_MAX_MESSAGE_BYTES_DM } from './constants/meshcoreMessageLimits.js';

/** Defaults and floors, shared with the Meshtastic Auto Ping and the settings routes. */
export const AUTO_PING_DEFAULTS = {
  maxPings: 20,
  intervalSeconds: 30,
  timeoutSeconds: 60,
} as const;
export const AUTO_PING_MIN_INTERVAL_SECONDS = 10;
export const AUTO_PING_MIN_TIMEOUT_SECONDS = 10;
export const AUTO_PING_MAX_PINGS_LIMIT = 100;

const PING_START_RE = /^ping\s+(\d+)$/;
const PING_STOP_RE = /^ping\s+stop$/;

/**
 * Text the auto-ping itself sends: the pings, the start / refusal replies and
 * the summaries. Auto-Acknowledge and the Auto-Responder skip a DM that
 * matches, so two MeshMonitor companions (or two installs) never answer each
 * other's pings. None of these can match the `ping N` command regex either.
 */
const AUTO_PING_OUTPUT_RE =
  /^(Ping \d+\/\d+$|Auto-ping (done|cancelled|force_stopped)|Starting \d+ pings every |No active ping session to stop|You already have an active ping session|Ping count must be at least 1)/;

export function isAutoPingOutputText(text: string | null | undefined): boolean {
  return !!text && AUTO_PING_OUTPUT_RE.test(text.trim());
}

export type AutoPingRoute = 'direct' | 'flood';

export interface MeshCoreAutoPingResult {
  pingNum: number;
  status: 'ack' | 'timeout';
  /** RTT in ms, from the firmware's trip time. ACKs only. */
  durationMs?: number;
  sentAt: number;
  route: AutoPingRoute;
}

export interface MeshCoreAutoPingSessionInfo {
  requestedBy: string;
  requestedByName: string;
  totalPings: number;
  completedPings: number;
  successfulPings: number;
  failedPings: number;
  directPings: number;
  floodPings: number;
  startTime: number;
  results: MeshCoreAutoPingResult[];
}

interface Session {
  requesterKey: string;
  requesterName: string;
  totalPings: number;
  completedPings: number;
  successfulPings: number;
  failedPings: number;
  intervalMs: number;
  /** The setting's timeout; the firmware's estimate replaces it per ping when longer. */
  timeoutMs: number;
  timer: ReturnType<typeof setInterval> | null;
  sending: boolean;
  pendingAckCrc: number | null;
  pendingMessageId: string | null;
  pendingRoute: AutoPingRoute;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
  startTime: number;
  lastPingSentAt: number;
  results: MeshCoreAutoPingResult[];
}

export interface AutoPingContact {
  publicKey: string;
  name: string;
  /** True when the contact has a known out path, so a DM goes direct. */
  direct: boolean;
}

export interface AutoPingSendResult {
  ok: boolean;
  ackCrc?: number;
  /** Firmware's suggested ack timeout, ms. */
  estTimeoutMs?: number;
  messageId?: string;
}

export interface AutoPingHost {
  readonly sourceId: string;
  isCompanion(): boolean;
  canTransmit(): boolean;
  isConnected(): boolean;
  /** True when `prefix` names one of MeshMonitor's own MeshCore nodes. */
  isOwnKey(prefix: string): boolean;
  resolveContact(prefix: string): AutoPingContact | undefined;
  getSetting(key: string): Promise<string | null>;
  /** One ping DM, no retry. */
  sendPing(text: string, publicKey: string): Promise<AutoPingSendResult>;
  /** A normal DM (command replies, summaries). */
  sendReply(text: string, publicKey: string): Promise<boolean>;
  /** Show a timed-out ping as failed in the message view. */
  markPingFailed(messageId: string, ackCrc: number): void;
  /** Stamp the shared mesh-TX clock so background schedulers back off. */
  recordMeshTx(): void;
}

function clampInt(raw: string | null, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export class MeshCoreAutoPingController {
  private sessions = new Map<string, Session>();

  constructor(private readonly host: AutoPingHost) {}

  /**
   * Handle a received DM. True when it was a `ping` command and we took it,
   * so the caller skips the Auto-Responder (Meshtastic does the same).
   */
  async handleCommand(fromPrefix: string, rawText: string): Promise<boolean> {
    const text = (rawText || '').trim().toLowerCase();
    const startMatch = text.match(PING_START_RE);
    const stopMatch = PING_STOP_RE.test(text);
    if (!startMatch && !stopMatch) return false;

    // Companion only (#5953): a Repeater source has no DM send path.
    if (!this.host.isCompanion()) return false;
    // Self-origin guard: never take a command from one of our own nodes, so
    // two MeshMonitor companions cannot drive each other.
    if (this.host.isOwnKey(fromPrefix)) return false;

    if ((await this.host.getSetting('autoPingEnabled')) !== 'true') {
      logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping command received but feature is disabled`);
      return false;
    }
    if (!this.host.canTransmit()) {
      logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping command received but source is receive-only`);
      return false;
    }

    const contact = this.host.resolveContact(fromPrefix);
    if (!contact) {
      logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping command from unknown contact ${fromPrefix}; cannot DM back`);
      return false;
    }
    const key = contact.publicKey;

    if (stopMatch) {
      if (this.sessions.has(key)) {
        this.stopSession(key, 'cancelled');
      } else {
        await this.reply('No active ping session to stop.', key);
      }
      return true;
    }

    const count = parseInt(startMatch![1], 10);
    const maxPings = clampInt(await this.host.getSetting('autoPingMaxPings'), AUTO_PING_DEFAULTS.maxPings, 1, AUTO_PING_MAX_PINGS_LIMIT);
    const intervalSeconds = clampInt(await this.host.getSetting('autoPingIntervalSeconds'), AUTO_PING_DEFAULTS.intervalSeconds, AUTO_PING_MIN_INTERVAL_SECONDS);
    const timeoutSeconds = clampInt(await this.host.getSetting('autoPingTimeoutSeconds'), AUTO_PING_DEFAULTS.timeoutSeconds, AUTO_PING_MIN_TIMEOUT_SECONDS);

    if (count <= 0) {
      await this.reply('Ping count must be at least 1.', key);
      return true;
    }
    if (this.sessions.has(key)) {
      await this.reply('You already have an active ping session. Send "ping stop" to cancel it first.', key);
      return true;
    }

    const actualCount = Math.min(count, maxPings);
    const session: Session = {
      requesterKey: key,
      requesterName: contact.name,
      totalPings: actualCount,
      completedPings: 0,
      successfulPings: 0,
      failedPings: 0,
      intervalMs: intervalSeconds * 1000,
      timeoutMs: timeoutSeconds * 1000,
      timer: null,
      sending: false,
      pendingAckCrc: null,
      pendingMessageId: null,
      pendingRoute: 'flood',
      pendingTimeout: null,
      startTime: Date.now(),
      lastPingSentAt: 0,
      results: [],
    };
    this.sessions.set(key, session);

    const capped = count > maxPings ? ` (capped to ${maxPings})` : '';
    await this.reply(`Starting ${actualCount} pings every ${intervalSeconds}s${capped}. Send "ping stop" to cancel.`, key);
    logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping session started for ${key.substring(0, 12)}: ${actualCount} pings every ${intervalSeconds}s`);

    // The session may have been stopped while the reply was in flight.
    if (this.sessions.get(key) !== session) return true;
    // Like Meshtastic, the first ping waits one full interval.
    session.timer = setInterval(() => {
      void this.tick(session);
    }, session.intervalMs);
    return true;
  }

  /** `SendConfirmed` (0x82) from the radio. True when it settled a ping. */
  handleSendConfirmed(ackCode: unknown, tripTimeMs: unknown): boolean {
    if (typeof ackCode !== 'number' || ackCode === 0) return false;
    for (const session of this.sessions.values()) {
      if (session.pendingAckCrc !== ackCode) continue;
      if (session.pendingTimeout) {
        clearTimeout(session.pendingTimeout);
        session.pendingTimeout = null;
      }
      const durationMs = typeof tripTimeMs === 'number' && Number.isFinite(tripTimeMs)
        ? Math.round(tripTimeMs)
        : Date.now() - session.lastPingSentAt;
      session.results.push({
        pingNum: session.completedPings + 1,
        status: 'ack',
        durationMs,
        sentAt: session.lastPingSentAt,
        route: session.pendingRoute,
      });
      session.completedPings++;
      session.successfulPings++;
      session.pendingAckCrc = null;
      session.pendingMessageId = null;
      logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping ${session.completedPings}/${session.totalPings} ACK (${durationMs}ms, ${session.pendingRoute})`);
      // Completion is handled by the next interval tick.
      return true;
    }
    return false;
  }

  /** Stop one session and DM the requester a summary of what ran. */
  stopSession(requesterKey: string, reason: 'cancelled' | 'force_stopped' = 'cancelled'): boolean {
    const session = this.sessions.get(requesterKey);
    if (!session) return false;
    this.sessions.delete(requesterKey);
    this.clearTimers(session);
    const { direct, flood } = this.routeCounts(session);
    const summary = `Auto-ping ${reason}: ${session.successfulPings}/${session.completedPings} successful out of ${session.totalPings} planned.`
      + (session.completedPings > 0 ? ` Direct: ${direct} Flood: ${flood}` : '');
    void this.reply(summary, requesterKey);
    logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping session ${reason} for ${requesterKey.substring(0, 12)}`);
    return true;
  }

  /**
   * Drop every session and its timers without sending anything. Called on
   * disconnect and stop: a torn-down link cannot send a summary, and a
   * session must never resume (and burst) on the next connect.
   */
  clearAll(): void {
    for (const session of this.sessions.values()) this.clearTimers(session);
    this.sessions.clear();
  }

  getSessions(): MeshCoreAutoPingSessionInfo[] {
    return [...this.sessions.values()].map((s) => {
      const { direct, flood } = this.routeCounts(s);
      return {
        requestedBy: s.requesterKey,
        requestedByName: s.requesterName,
        totalPings: s.totalPings,
        completedPings: s.completedPings,
        successfulPings: s.successfulPings,
        failedPings: s.failedPings,
        directPings: direct,
        floodPings: flood,
        startTime: s.startTime,
        results: [...s.results],
      };
    });
  }

  /** Build the end-of-session summary. Exposed for tests. */
  static buildSummary(results: MeshCoreAutoPingResult[], totalPings: number): string {
    const ok = results.filter((r) => r.status === 'ack');
    const timeouts = results.filter((r) => r.status === 'timeout').length;
    const direct = results.filter((r) => r.route === 'direct').length;
    const flood = results.length - direct;
    const durations = ok.map((r) => r.durationMs).filter((d): d is number => typeof d === 'number');
    let summary = `Auto-ping done: ${ok.length}/${totalPings} ok`;
    if (durations.length > 0) {
      const min = Math.min(...durations);
      const max = Math.max(...durations);
      const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      summary += `\nMin/Avg/Max: ${min}/${avg}/${max}ms`;
    }
    if (timeouts > 0) summary += `\nTimeouts: ${timeouts}`;
    summary += `\nDirect: ${direct} Flood: ${flood}`;
    // A full 100-ping summary is about 100 bytes; the cap is a backstop.
    return truncateUtf8(summary, MESHCORE_MAX_MESSAGE_BYTES_DM);
  }

  private routeCounts(session: Session): { direct: number; flood: number } {
    const direct = session.results.filter((r) => r.route === 'direct').length;
    return { direct, flood: session.results.length - direct };
  }

  private clearTimers(session: Session): void {
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    if (session.pendingTimeout) {
      clearTimeout(session.pendingTimeout);
      session.pendingTimeout = null;
    }
  }

  private async reply(text: string, publicKey: string): Promise<void> {
    try {
      const sent = await this.host.sendReply(text, publicKey);
      if (sent) this.host.recordMeshTx();
    } catch (err) {
      logger.warn(`[MeshCore:${this.host.sourceId}] Auto-ping reply failed: ${(err as Error).message}`);
    }
  }

  private async tick(session: Session): Promise<void> {
    if (this.sessions.get(session.requesterKey) !== session) return;
    // Receive-only or a dropped link: skip this tick and keep the session,
    // as Meshtastic does for TX-disabled radios.
    if (!this.host.canTransmit() || !this.host.isConnected()) return;

    if (session.completedPings >= session.totalPings) {
      await this.finalize(session);
      return;
    }
    // One ping in flight at a time. `sending` is set before the first await
    // so a second tick during the send cannot launch a duplicate.
    if (session.pendingAckCrc !== null || session.sending) return;
    session.sending = true;

    const pingNum = session.completedPings + 1;
    // Read the route at send time: a flood ACK can teach the contact a path
    // part-way through a session, and that change is what the user is testing.
    const route: AutoPingRoute = this.host.resolveContact(session.requesterKey)?.direct ? 'direct' : 'flood';
    try {
      const result = await this.host.sendPing(`Ping ${pingNum}/${session.totalPings}`, session.requesterKey);
      if (this.sessions.get(session.requesterKey) !== session) return; // stopped mid-send
      this.host.recordMeshTx();
      if (!result.ok || typeof result.ackCrc !== 'number' || result.ackCrc === 0) {
        // Not sent, or sent with no ack code we could ever match.
        this.recordTimeout(session, route, Date.now());
        return;
      }
      session.pendingAckCrc = result.ackCrc;
      session.pendingMessageId = result.messageId ?? null;
      session.pendingRoute = route;
      session.lastPingSentAt = Date.now();
      // Use the setting's timeout (>= 10 s), or the firmware's suggested
      // timeout when that is longer: a long flood route can need more than
      // the setting, and timing it out early would report a false failure.
      const timeoutMs = Math.max(session.timeoutMs, result.estTimeoutMs ?? 0);
      session.pendingTimeout = setTimeout(() => this.handleTimeout(session), timeoutMs);
      logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping ${pingNum}/${session.totalPings} sent to ${session.requesterKey.substring(0, 12)} (${route}, ackCrc=${result.ackCrc}, timeout=${timeoutMs}ms)`);
    } catch (err) {
      logger.warn(`[MeshCore:${this.host.sourceId}] Auto-ping send failed: ${(err as Error).message}`);
      if (this.sessions.get(session.requesterKey) === session) this.recordTimeout(session, route, Date.now());
    } finally {
      session.sending = false;
    }
  }

  private handleTimeout(session: Session): void {
    if (session.pendingAckCrc === null) return;
    const crc = session.pendingAckCrc;
    const messageId = session.pendingMessageId;
    session.pendingTimeout = null;
    this.recordTimeout(session, session.pendingRoute, session.lastPingSentAt);
    if (messageId) this.host.markPingFailed(messageId, crc);
    logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping ${session.completedPings}/${session.totalPings} TIMEOUT for ${session.requesterKey.substring(0, 12)}`);
  }

  private recordTimeout(session: Session, route: AutoPingRoute, sentAt: number): void {
    session.results.push({ pingNum: session.completedPings + 1, status: 'timeout', sentAt, route });
    session.completedPings++;
    session.failedPings++;
    session.pendingAckCrc = null;
    session.pendingMessageId = null;
  }

  private async finalize(session: Session): Promise<void> {
    if (this.sessions.get(session.requesterKey) !== session) return;
    this.sessions.delete(session.requesterKey);
    this.clearTimers(session);
    await this.reply(MeshCoreAutoPingController.buildSummary(session.results, session.totalPings), session.requesterKey);
    logger.debug(`[MeshCore:${this.host.sourceId}] Auto-ping session completed for ${session.requesterKey.substring(0, 12)}: ${session.successfulPings}/${session.totalPings} ok`);
  }
}
