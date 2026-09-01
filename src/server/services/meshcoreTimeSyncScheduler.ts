/**
 * MeshCore Time-Sync Scheduler — periodic clock push to each opt-in remote
 * repeater across every connected source (issue #4916).
 *
 * Models the MeshCoreNeighboursScheduler exactly, but drives a `time <epoch>`
 * push instead of a neighbour-table query. Like that scheduler it PUTS
 * PACKETS ON THE AIR, and it is the most expensive of the three, so
 * throttling is non-negotiable:
 *
 *   - Per-node cadence: `timeSyncIntervalMinutes` from `meshcore_nodes`,
 *     defaulting to 12h and floored at 1h (`MIN_INTERVAL_MINUTES`).
 *   - Per-source minimum: `MIN_INTERVAL_BETWEEN_REQUESTS_MS` (60s) between
 *     any two scheduled mesh ops on the same manager — enforced via the
 *     SHARED `MeshCoreManager.lastMeshTxAt` primitive. Because telemetry,
 *     room-sync, neighbours, and now time-sync all coordinate against that
 *     one field, no two of them transmit within 60s of each other on the
 *     same source; they interleave rather than collide.
 *   - Per-tick budget: at most one sync per manager per tick.
 *
 * WHY THE CADENCE IS SO MUCH SLOWER THAN MESHTASTIC'S. The Meshtastic auto
 * time-sync defaults to 15 minutes and costs one admin packet. One MeshCore
 * repeater sync costs FOUR packets: `ensureSavedLogin()` does not cache, so
 * every sync is a login DM plus its reply, then the `time <epoch>` CliData DM
 * plus its reply — and each of those floods when the target's `out_path` is
 * unknown, which multiplies it again. At 12h across ten repeaters that is
 * roughly 3 packets/hour; at 15 min it would be roughly 160/hour, which no
 * LoRa mesh should be asked to carry. Repeater RTC drift is seconds-to-minutes
 * per day, so 12h has ample margin. (The "~22 minutes behind" in #3954 was
 * inherited drift from our own unsynced companion, since fixed — not the
 * repeater's own RTC.)
 *
 * The per-node cadence and last-sync stamp live in a SEPARATE column set
 * (`lastTimeSyncAt`, migration 156) from both the telemetry trio and the
 * neighbours trio, so a time-sync never resets either of those timers. The
 * stamp is written to the DATABASE, not to an instance field, so a restart or
 * a settings save cannot re-arm it and trigger a mesh-wide burst.
 *
 * Tick cadence defaults to 30s. Configurable via `MESHCORE_TIME_SYNC_TICK_MS`.
 */
import { logger } from '../../utils/logger.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';

/** Database surface the scheduler depends on (kept thin for testability). */
export interface TimeSyncSchedulerDatabase {
  meshcore: {
    getTimeSyncEnabledNodes: (sourceId: string) => Promise<DbMeshCoreNode[]>;
    markTimeSyncRequested: (sourceId: string, publicKey: string, when?: number) => Promise<void>;
  };
}

/** Minimum spacing between scheduled mesh requests on the same source (ms). */
export const MIN_INTERVAL_BETWEEN_REQUESTS_MS = 60_000;

/** Default scheduler tick (ms); always >= 1s, clamped on parse. */
export const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 1_000;

/**
 * Default per-node cadence, in minutes (12h). Also the column default in
 * migration 156 — kept in sync so a row written before the column existed and
 * a row written by the UI agree.
 */
export const DEFAULT_INTERVAL_MINUTES = 720;

/**
 * Floor on the per-node interval, in minutes (1h). A sync is four packets, so
 * a mistyped `5` would put a repeater's worth of traffic on the air every five
 * minutes. Enforced here AND at the route, so neither the UI nor a direct API
 * call can go below it.
 */
export const MIN_INTERVAL_MINUTES = 60;

/** Sanity ceiling on the per-node interval the UI can set, in minutes (7d). */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export interface MeshCoreTimeSyncSchedulerOptions {
  registry: SourceManagerRegistry;
  database: TimeSyncSchedulerDatabase;
  /** Override the env-derived tick (tests). */
  tickMs?: number;
  /** Override the inter-request minimum (tests). */
  minIntervalMs?: number;
  /** Inject a clock for tests. */
  now?: () => number;
}

export function resolveTickMs(envValue: string | undefined): number {
  if (!envValue) return DEFAULT_TICK_MS;
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_MS;
  return Math.max(parsed, MIN_TICK_MS);
}

/**
 * Clamp a user-supplied interval to [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES].
 * Exported so the route and the scheduler cannot disagree about the floor.
 * Returns null for values that aren't a positive finite number, letting the
 * caller reject rather than silently substitute something.
 */
export function clampIntervalMinutes(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.round(n), MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
}

/**
 * Decide whether a node is currently eligible for a fresh time-sync push.
 * Pure function, exported for the unit test.
 *
 * The stored interval is floored at read time as well as at write time: a row
 * written before the floor existed, or edited directly in the database, must
 * not be able to drive a faster cadence than the scheduler permits.
 */
export function isNodeEligible(node: DbMeshCoreNode, now: number): boolean {
  if (!node.timeSyncEnabled) return false;
  const raw = node.timeSyncIntervalMinutes;
  if (raw === null || raw === undefined || raw <= 0) return false;
  const interval = Math.max(raw, MIN_INTERVAL_MINUTES);
  const last = node.lastTimeSyncAt ?? 0;
  return (now - last) >= interval * 60_000;
}

/**
 * Pick the most overdue eligible node, or undefined if none. Stable
 * tiebreaker on publicKey so two nodes that came due in the same tick don't
 * ping-pong on every cycle.
 */
export function pickMostOverdue(nodes: DbMeshCoreNode[], now: number): DbMeshCoreNode | undefined {
  const eligible = nodes.filter((n) => isNodeEligible(n, now));
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => {
    const aOver = now - (a.lastTimeSyncAt ?? 0);
    const bOver = now - (b.lastTimeSyncAt ?? 0);
    if (aOver !== bOver) return bOver - aOver;
    return a.publicKey.localeCompare(b.publicKey);
  });
  return eligible[0];
}

export class MeshCoreTimeSyncScheduler {
  private readonly registry: SourceManagerRegistry;
  private readonly database: TimeSyncSchedulerDatabase;
  private readonly tickMs: number;
  private readonly minIntervalMs: number;
  private readonly nowFn: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: MeshCoreTimeSyncSchedulerOptions) {
    this.registry = opts.registry;
    this.database = opts.database;
    this.tickMs = opts.tickMs ?? resolveTickMs(process.env.MESHCORE_TIME_SYNC_TICK_MS);
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_BETWEEN_REQUESTS_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      `[MeshCoreTimeSync] Scheduler starting (tick=${Math.round(this.tickMs / 1000)}s, ` +
        `min-interval=${Math.round(this.minIntervalMs / 1000)}s)`,
    );
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error('[MeshCoreTimeSync] Unhandled tick error:', err));
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One tick. Visible for tests. Walks every registered manager and issues
   * at most one time-sync per source, gated by both the in-DB per-node
   * cadence and the per-manager 60s minimum.
   */
  async tick(): Promise<void> {
    if (this.running) {
      logger.debug('[MeshCoreTimeSync] Previous tick still running, skipping');
      return;
    }
    this.running = true;
    try {
      const managers = this.registry.getAllManagers().filter(isMeshCoreManager);
      for (const manager of managers) {
        try {
          await this.tickOneManager(manager);
        } catch (err) {
          logger.warn(`[MeshCoreTimeSync:${manager.sourceId}] Tick failed:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Process a single manager. Visible for tests. */
  async tickOneManager(manager: MeshCoreManager): Promise<void> {
    if (!manager.isConnected()) return;
    // Receive-only (#4547): skip before any guarded send primitive —
    // syncNodeTime → ensureSavedLogin → requireTransmit would otherwise throw
    // and rely on tick()'s per-manager catch.
    if (manager.isReceiveOnly()) {
      logger.debug(`[MeshCoreTimeSync:${manager.sourceId}] Skipping - receive-only mode`);
      return;
    }

    const now = this.nowFn();
    const sinceLastTx = now - manager.getLastMeshTxAt();
    if (manager.getLastMeshTxAt() > 0 && sinceLastTx < this.minIntervalMs) {
      logger.debug(
        `[MeshCoreTimeSync:${manager.sourceId}] Throttled — last mesh tx was ${Math.round(sinceLastTx / 1000)}s ago`,
      );
      return;
    }

    const nodes = await this.database.meshcore.getTimeSyncEnabledNodes(manager.sourceId);
    if (nodes.length === 0) return;

    const target = pickMostOverdue(nodes, now);
    if (!target) return;

    const keyShort = target.publicKey.substring(0, 16);
    logger.debug(`[MeshCoreTimeSync:${manager.sourceId}] Pushing clock to ${keyShort}…`);

    // Stamp BEFORE issuing — preserves fair rotation when several nodes share
    // the same overdue-by, and applies the per-source cadence regardless of
    // how long the two round-trips take or whether they succeed. A repeater
    // that is offline or rejecting the push must not be retried every tick.
    // Mirrors the telemetry and neighbours schedulers.
    await this.database.meshcore.markTimeSyncRequested(manager.sourceId, target.publicKey, now);
    manager.recordMeshTx(now);

    try {
      const result = await manager.syncNodeTime(target.publicKey);
      switch (result.status) {
        case 'ok':
          logger.debug(
            `[MeshCoreTimeSync:${manager.sourceId}] ${keyShort}… clock set in ${result.elapsedMs}ms`,
          );
          break;
        case 'rejected':
          // Firmware refused, virtually always its "clock cannot go backwards"
          // guard. Retrying on the next cadence is harmless but will keep
          // failing until the repeater's RTC is corrected, so say so once at
          // warn level rather than burying it in debug.
          logger.warn(
            `[MeshCoreTimeSync:${manager.sourceId}] ${keyShort}… refused the clock push ` +
              `(likely running ahead of server time): ${result.reply}`,
          );
          break;
        case 'no-credential':
          logger.warn(
            `[MeshCoreTimeSync:${manager.sourceId}] ${keyShort}… has time sync enabled but no ` +
              `usable saved admin password — save one, or disable time sync for this node`,
          );
          break;
        case 'failed':
          logger.debug(
            `[MeshCoreTimeSync:${manager.sourceId}] ${keyShort}… sync failed: ${result.error}`,
          );
          break;
      }
    } catch (err) {
      logger.warn(
        `[MeshCoreTimeSync:${manager.sourceId}] syncNodeTime(${keyShort}…) threw:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — mirrors the telemetry/neighbours/room-sync
// schedulers so the manual-sync route can reach the same instance.
// ---------------------------------------------------------------------------

let _scheduler: MeshCoreTimeSyncScheduler | null = null;

export function setMeshCoreTimeSyncScheduler(scheduler: MeshCoreTimeSyncScheduler | null): void {
  _scheduler = scheduler;
}

export function getMeshCoreTimeSyncScheduler(): MeshCoreTimeSyncScheduler | null {
  return _scheduler;
}
