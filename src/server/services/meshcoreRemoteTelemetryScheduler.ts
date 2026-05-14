/**
 * MeshCore Remote-Telemetry Scheduler — periodic `req_telemetry_sync` for
 * each opt-in node across every connected source.
 *
 * Unlike `MeshCoreTelemetryPoller` (which only touches the locally-attached
 * companion), this scheduler PUTS PACKETS ON THE AIR. Throttling is
 * non-negotiable:
 *
 *   - Per-node cadence: `telemetryIntervalMinutes` from `meshcore_nodes`.
 *   - Per-source minimum: `MIN_INTERVAL_BETWEEN_REQUESTS_MS` (60s) between
 *     any two scheduled telemetry requests on the same manager — enforced
 *     via the shared `MeshCoreManager.lastMeshTxAt` primitive so future
 *     scheduled mesh-ops on the same source (auto-traceroute, etc.)
 *     coordinate against the same field without each owning their own
 *     bookkeeping.
 *   - Per-tick budget: at most one request per manager per tick.
 *
 * Tick cadence defaults to 30s (the scheduler can't physically do better
 * than the global minimum, but a shorter tick lets a newly-eligible node
 * get serviced sooner than waiting a full minute). Configurable via
 * `MESHCORE_REMOTE_TELEMETRY_TICK_MS`.
 */
import { logger } from '../../utils/logger.js';
import type { DbTelemetry } from '../../services/database.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { MeshCoreManager, MeshCoreTelemetryRecord } from '../meshcoreManager.js';
import type { MeshCoreManagerRegistry } from '../meshcoreRegistry.js';
import { MC_TELEMETRY_PREFIX, nodeNumFromPubkey } from './meshcoreTelemetryPoller.js';

/** Database surface the scheduler depends on (kept thin for testability). */
export interface RemoteTelemetrySchedulerDatabase {
  meshcore: {
    getTelemetryEnabledNodes: (sourceId: string) => Promise<DbMeshCoreNode[]>;
    markTelemetryRequested: (sourceId: string, publicKey: string, when?: number) => Promise<void>;
  };
  telemetry: {
    insertTelemetryBatch: (rows: DbTelemetry[], sourceId?: string) => Promise<number>;
  };
}

/** Minimum spacing between scheduled telemetry requests on the same source (ms). */
export const MIN_INTERVAL_BETWEEN_REQUESTS_MS = 60_000;

/** Default scheduler tick (ms); always >= 1s, clamped on parse. */
export const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 1_000;

/** Sanity ceiling on the per-node interval the UI can set, in minutes. */
export const MAX_INTERVAL_MINUTES = 24 * 60;

export interface MeshCoreRemoteTelemetrySchedulerOptions {
  registry: MeshCoreManagerRegistry;
  database: RemoteTelemetrySchedulerDatabase;
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
 * Map Cayenne-LPP type ids → `telemetry.telemetryType` strings the rest
 * of MeshMonitor already knows how to graph. Anything missing falls
 * back to `mc_lpp_<type>` so the row still lands in the DB rather than
 * being silently dropped.
 *
 * Keeping this map small + explicit beats decoding the python lib's
 * naming on the fly: each entry is something the UI's telemetry
 * formatter already labels.
 */
const LPP_TYPE_NAMES: Record<number, { type: string; unit?: string }> = {
  2: { type: 'analog_input' },
  3: { type: 'analog_output' },
  101: { type: 'illuminance', unit: 'lux' },
  102: { type: 'presence' },
  103: { type: 'temperature', unit: '°C' },
  104: { type: 'humidity', unit: '%' },
  115: { type: 'barometer', unit: 'hPa' },
  116: { type: 'battery_volts', unit: 'V' },
  117: { type: 'current', unit: 'A' },
  118: { type: 'frequency', unit: 'Hz' },
  120: { type: 'percentage', unit: '%' },
  121: { type: 'altitude', unit: 'm' },
  122: { type: 'load', unit: 'kg' },
  125: { type: 'concentration', unit: 'ppm' },
  128: { type: 'power', unit: 'W' },
  130: { type: 'distance', unit: 'm' },
  131: { type: 'energy', unit: 'Wh' },
  133: { type: 'time', unit: 's' },
};

/**
 * Decide whether a node is currently eligible for a fresh telemetry
 * request. Pure function, exported for the unit test.
 */
export function isNodeEligible(
  node: DbMeshCoreNode,
  now: number,
): boolean {
  if (!node.telemetryEnabled) return false;
  const interval = node.telemetryIntervalMinutes;
  if (interval === null || interval === undefined || interval <= 0) return false;
  const last = node.lastTelemetryRequestAt ?? 0;
  const overdueBy = now - last;
  return overdueBy >= interval * 60_000;
}

/**
 * Pick the most overdue eligible node from a list, or undefined if none.
 * Stable tiebreaker on publicKey so two nodes that came due in the same
 * tick don't ping-pong on every cycle.
 */
export function pickMostOverdue(
  nodes: DbMeshCoreNode[],
  now: number,
): DbMeshCoreNode | undefined {
  const eligible = nodes.filter((n) => isNodeEligible(n, now));
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => {
    const aOver = now - (a.lastTelemetryRequestAt ?? 0);
    const bOver = now - (b.lastTelemetryRequestAt ?? 0);
    if (aOver !== bOver) return bOver - aOver;
    return a.publicKey.localeCompare(b.publicKey);
  });
  return eligible[0];
}

/**
 * Convert a Cayenne-LPP record from the bridge into a DbTelemetry row.
 * Multi-component values (gps, accelerometer, colour) explode into one
 * row per axis with a `_<axis>` suffix. Anything we can't reduce to a
 * finite number is dropped — the alternative is poisoning the
 * telemetry table with NaN.
 */
export function recordToTelemetryRows(
  record: MeshCoreTelemetryRecord,
  nodeId: string,
  nodeNum: number,
  timestamp: number,
): DbTelemetry[] {
  if (record.type === null || record.type === undefined) return [];
  const naming = LPP_TYPE_NAMES[record.type] ?? { type: `lpp_${record.type}` };
  const baseType = `${MC_TELEMETRY_PREFIX}${naming.type}`;
  const out: DbTelemetry[] = [];

  const pushScalar = (typeName: string, raw: unknown, unit?: string) => {
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num)) return;
    out.push({
      nodeId,
      nodeNum,
      telemetryType: typeName,
      value: num,
      unit,
      timestamp,
      createdAt: timestamp,
    });
  };

  const value = record.value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'number') {
    pushScalar(baseType, value, naming.unit);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      pushScalar(`${baseType}_${i}`, value[i], naming.unit);
    }
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      pushScalar(`${baseType}_${k}`, v, naming.unit);
    }
  } else if (typeof value === 'string') {
    pushScalar(baseType, value, naming.unit);
  }
  return out;
}

export class MeshCoreRemoteTelemetryScheduler {
  private readonly registry: MeshCoreManagerRegistry;
  private readonly database: RemoteTelemetrySchedulerDatabase;
  private readonly tickMs: number;
  private readonly minIntervalMs: number;
  private readonly nowFn: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: MeshCoreRemoteTelemetrySchedulerOptions) {
    this.registry = opts.registry;
    this.database = opts.database;
    this.tickMs = opts.tickMs ?? resolveTickMs(process.env.MESHCORE_REMOTE_TELEMETRY_TICK_MS);
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_BETWEEN_REQUESTS_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      `[MeshCoreRemoteTelem] Scheduler starting (tick=${Math.round(this.tickMs / 1000)}s, ` +
        `min-interval=${Math.round(this.minIntervalMs / 1000)}s)`,
    );
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error('[MeshCoreRemoteTelem] Unhandled tick error:', err));
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
   * One tick. Visible for tests. Walks every registered manager and
   * issues at most one telemetry request per source, gated by both
   * the in-DB per-node cadence and the per-manager 60s minimum.
   */
  async tick(): Promise<void> {
    if (this.running) {
      logger.debug('[MeshCoreRemoteTelem] Previous tick still running, skipping');
      return;
    }
    this.running = true;
    try {
      const managers = this.registry.list();
      for (const manager of managers) {
        try {
          await this.tickOneManager(manager);
        } catch (err) {
          logger.warn(`[MeshCoreRemoteTelem:${manager.sourceId}] Tick failed:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Process a single manager. Visible for tests. */
  async tickOneManager(manager: MeshCoreManager): Promise<void> {
    if (!manager.isConnected()) return;

    const now = this.nowFn();
    const sinceLastTx = now - manager.getLastMeshTxAt();
    if (manager.getLastMeshTxAt() > 0 && sinceLastTx < this.minIntervalMs) {
      logger.debug(
        `[MeshCoreRemoteTelem:${manager.sourceId}] Throttled — last mesh tx was ${Math.round(sinceLastTx / 1000)}s ago`,
      );
      return;
    }

    const nodes = await this.database.meshcore.getTelemetryEnabledNodes(manager.sourceId);
    if (nodes.length === 0) return;

    const target = pickMostOverdue(nodes, now);
    if (!target) return;

    logger.info(
      `[MeshCoreRemoteTelem:${manager.sourceId}] Requesting telemetry from ${target.publicKey.substring(0, 16)}…`,
    );

    // Stamp the request time BEFORE issuing — keeps a slow / failing node
    // from being re-selected on every tick while we wait. The manager
    // also bumps its own `lastMeshTxAt` inside `requestRemoteTelemetry`.
    await this.database.meshcore.markTelemetryRequested(manager.sourceId, target.publicKey, now);
    manager.recordMeshTx(now);

    const records = await manager.requestRemoteTelemetry(target.publicKey);
    if (!records || records.length === 0) {
      logger.debug(
        `[MeshCoreRemoteTelem:${manager.sourceId}] No telemetry from ${target.publicKey.substring(0, 16)}… (timeout or empty)`,
      );
      return;
    }

    const nodeNum = nodeNumFromPubkey(target.publicKey);
    const ts = this.nowFn();
    const rows: DbTelemetry[] = [];
    for (const rec of records) {
      rows.push(...recordToTelemetryRows(rec, target.publicKey, nodeNum, ts));
    }

    if (rows.length === 0) {
      logger.debug(
        `[MeshCoreRemoteTelem:${manager.sourceId}] LPP frame decoded to 0 rows for ${target.publicKey.substring(0, 16)}…`,
      );
      return;
    }

    try {
      await this.database.telemetry.insertTelemetryBatch(rows, manager.sourceId);
      logger.debug(
        `[MeshCoreRemoteTelem:${manager.sourceId}] Wrote ${rows.length} telemetry rows for ${target.publicKey.substring(0, 16)}…`,
      );
    } catch (err) {
      logger.warn(`[MeshCoreRemoteTelem:${manager.sourceId}] insertTelemetryBatch failed:`, err);
    }
  }
}

/**
 * Module-level singleton handle, mirroring the local-node poller. server.ts
 * constructs the scheduler once at startup and route handlers don't need
 * to reach into it directly — but exposing it via setter/getter keeps the
 * pattern consistent with the local poller and leaves room for routes
 * that want to peek at scheduler state.
 */
let _scheduler: MeshCoreRemoteTelemetryScheduler | null = null;

export function setMeshCoreRemoteTelemetryScheduler(
  scheduler: MeshCoreRemoteTelemetryScheduler | null,
): void {
  _scheduler = scheduler;
}

export function getMeshCoreRemoteTelemetryScheduler(): MeshCoreRemoteTelemetryScheduler | null {
  return _scheduler;
}
