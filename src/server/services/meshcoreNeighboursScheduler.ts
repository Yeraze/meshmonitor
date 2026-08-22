/**
 * MeshCore Neighbours Scheduler — periodic `get_neighbours` for each opt-in
 * node across every connected source (issue #4618).
 *
 * Models the MeshCoreRemoteTelemetryScheduler exactly, but drives the
 * neighbour-table query instead of telemetry. Like that scheduler it PUTS
 * PACKETS ON THE AIR, so throttling is non-negotiable:
 *
 *   - Per-node cadence: `neighborsIntervalMinutes` from `meshcore_nodes`.
 *   - Per-source minimum: `MIN_INTERVAL_BETWEEN_REQUESTS_MS` (60s) between
 *     any two scheduled mesh ops on the same manager — enforced via the
 *     SHARED `MeshCoreManager.lastMeshTxAt` primitive. Because telemetry,
 *     room-sync, and neighbours schedulers all coordinate against that one
 *     field, a neighbours request and a telemetry request are never emitted
 *     within 60s of each other on the same source — they interleave rather
 *     than collide.
 *   - Per-tick budget: at most one request per manager per tick.
 *
 * The per-node cadence and last-request stamp are held in a SEPARATE column
 * set (`lastNeighborsRequestAt`) from the telemetry trio, so a neighbours
 * poll never resets the telemetry timer or vice versa — the "separate 60s
 * spacing" the issue asks for.
 *
 * Tick cadence defaults to 30s. Configurable via `MESHCORE_NEIGHBORS_TICK_MS`.
 */
import { logger } from '../../utils/logger.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';

/** Database surface the scheduler depends on (kept thin for testability). */
export interface NeighboursSchedulerDatabase {
  meshcore: {
    getNeighborsEnabledNodes: (sourceId: string) => Promise<DbMeshCoreNode[]>;
    markNeighborsRequested: (sourceId: string, publicKey: string, when?: number) => Promise<void>;
  };
}

/** Minimum spacing between scheduled mesh requests on the same source (ms). */
export const MIN_INTERVAL_BETWEEN_REQUESTS_MS = 60_000;

/** Default scheduler tick (ms); always >= 1s, clamped on parse. */
export const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 1_000;

/** Sanity ceiling on the per-node interval the UI can set, in minutes. */
export const MAX_INTERVAL_MINUTES = 24 * 60;

export interface MeshCoreNeighboursSchedulerOptions {
  registry: SourceManagerRegistry;
  database: NeighboursSchedulerDatabase;
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
 * Decide whether a node is currently eligible for a fresh neighbours request.
 * Pure function, exported for the unit test.
 */
export function isNodeEligible(node: DbMeshCoreNode, now: number): boolean {
  if (!node.neighborsEnabled) return false;
  const interval = node.neighborsIntervalMinutes;
  if (interval === null || interval === undefined || interval <= 0) return false;
  const last = node.lastNeighborsRequestAt ?? 0;
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
    const aOver = now - (a.lastNeighborsRequestAt ?? 0);
    const bOver = now - (b.lastNeighborsRequestAt ?? 0);
    if (aOver !== bOver) return bOver - aOver;
    return a.publicKey.localeCompare(b.publicKey);
  });
  return eligible[0];
}

export class MeshCoreNeighboursScheduler {
  private readonly registry: SourceManagerRegistry;
  private readonly database: NeighboursSchedulerDatabase;
  private readonly tickMs: number;
  private readonly minIntervalMs: number;
  private readonly nowFn: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: MeshCoreNeighboursSchedulerOptions) {
    this.registry = opts.registry;
    this.database = opts.database;
    this.tickMs = opts.tickMs ?? resolveTickMs(process.env.MESHCORE_NEIGHBORS_TICK_MS);
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_BETWEEN_REQUESTS_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      `[MeshCoreNeighbours] Scheduler starting (tick=${Math.round(this.tickMs / 1000)}s, ` +
        `min-interval=${Math.round(this.minIntervalMs / 1000)}s)`,
    );
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error('[MeshCoreNeighbours] Unhandled tick error:', err));
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
   * at most one neighbours request per source, gated by both the in-DB
   * per-node cadence and the per-manager 60s minimum.
   */
  async tick(): Promise<void> {
    if (this.running) {
      logger.debug('[MeshCoreNeighbours] Previous tick still running, skipping');
      return;
    }
    this.running = true;
    try {
      const managers = this.registry.getAllManagers().filter(isMeshCoreManager);
      for (const manager of managers) {
        try {
          await this.tickOneManager(manager);
        } catch (err) {
          logger.warn(`[MeshCoreNeighbours:${manager.sourceId}] Tick failed:`, err);
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
    // pollNeighborsAndStore → getNeighbours → requireTransmit would otherwise
    // throw and rely on tick()'s per-manager catch.
    if (manager.isReceiveOnly()) {
      logger.debug(`[MeshCoreNeighbours:${manager.sourceId}] Skipping - receive-only mode`);
      return;
    }

    const now = this.nowFn();
    const sinceLastTx = now - manager.getLastMeshTxAt();
    if (manager.getLastMeshTxAt() > 0 && sinceLastTx < this.minIntervalMs) {
      logger.debug(
        `[MeshCoreNeighbours:${manager.sourceId}] Throttled — last mesh tx was ${Math.round(sinceLastTx / 1000)}s ago`,
      );
      return;
    }

    const nodes = await this.database.meshcore.getNeighborsEnabledNodes(manager.sourceId);
    if (nodes.length === 0) return;

    const target = pickMostOverdue(nodes, now);
    if (!target) return;

    const keyShort = target.publicKey.substring(0, 16);
    logger.debug(`[MeshCoreNeighbours:${manager.sourceId}] Requesting neighbours from ${keyShort}…`);

    // Stamp BEFORE issuing — preserves fair rotation when several nodes share
    // the same overdue-by, and applies the per-source 60s gate regardless of
    // how long the query takes. Mirrors the telemetry scheduler.
    await this.database.meshcore.markNeighborsRequested(manager.sourceId, target.publicKey, now);
    manager.recordMeshTx(now);

    try {
      const result = await manager.pollNeighborsAndStore(target.publicKey);
      if (result) {
        logger.debug(
          `[MeshCoreNeighbours:${manager.sourceId}] ${keyShort}… → ${result.total} reported, ${result.written} stored`,
        );
      } else {
        logger.debug(
          `[MeshCoreNeighbours:${manager.sourceId}] ${keyShort}… → no neighbours (failed/timeout/not a Companion source)`,
        );
      }
    } catch (err) {
      logger.warn(
        `[MeshCoreNeighbours:${manager.sourceId}] pollNeighborsAndStore(${keyShort}…) threw:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — mirrors the telemetry/room-sync schedulers so the
// manual-poll route can reach the same instance.
// ---------------------------------------------------------------------------

let _scheduler: MeshCoreNeighboursScheduler | null = null;

export function setMeshCoreNeighboursScheduler(scheduler: MeshCoreNeighboursScheduler | null): void {
  _scheduler = scheduler;
}

export function getMeshCoreNeighboursScheduler(): MeshCoreNeighboursScheduler | null {
  return _scheduler;
}
