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
import type {
  MeshCoreManager,
  MeshCoreStatus,
  MeshCoreTelemetryRecord,
} from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import { MC_TELEMETRY_PREFIX, nodeNumFromPubkey } from './meshcoreTelemetryPoller.js';
import { isNullIsland } from '../../utils/nullIsland.js';

/**
 * `adv_type` values for MeshCore contacts. Matches the `MeshCoreDeviceType`
 * enum (companion=1, repeater=2, room=3) but kept as a local literal-union
 * to avoid importing the enum just for the integer comparison.
 *
 * Repeater and Room Server targets get the path-#1 (`SendStatusReq`)
 * treatment plus a best-effort guest-login before path-#3 (LPP); other
 * advTypes use path #3 only.
 */
const REPEATER_ADV_TYPES = new Set<number>([2, 3]);

/** Cayenne-LPP type id for GPS/GNSS position records (lat/lon/alt object). */
const LPP_GPS_TYPE = 136;

/** Database surface the scheduler depends on (kept thin for testability). */
export interface RemoteTelemetrySchedulerDatabase {
  meshcore: {
    getTelemetryEnabledNodes: (sourceId: string) => Promise<DbMeshCoreNode[]>;
    markTelemetryRequested: (sourceId: string, publicKey: string, when?: number) => Promise<void>;
    upsertNode: (node: Partial<DbMeshCoreNode> & { publicKey: string }, sourceId: string) => Promise<void>;
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
  registry: SourceManagerRegistry;
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
  // Cayenne-LPP responses can carry several records of the same `type` under
  // different `channel` bytes (e.g. battery on ch1=main, ch2=solar). Encode
  // the channel into the telemetry-type string so each lands as a distinct
  // chart instead of clobbering its peers. See issue #3139.
  const channelSuffix = `_ch${record.channel}`;
  const baseType = `${MC_TELEMETRY_PREFIX}${naming.type}${channelSuffix}`;
  const out: DbTelemetry[] = [];

  // NOTE: we deliberately do NOT write `record.channel` into the row's
  // `channel` column — that column is for the *mesh* channel the packet
  // rode on (used by `maskTelemetryByChannel` for per-channel permission
  // filtering, see src/server/utils/nodeEnhancer.ts). LPP's `channel` is a
  // within-packet sensor-instance discriminator, an entirely different
  // concept. Mixing the two would cause permission filtering to deny
  // access to LPP channel 2/3/4 readings on private mesh channels.
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

/**
 * Map a `MeshCoreStatus` (returned by `SendStatusReq` / `getStatus(pubkey)`)
 * into telemetry rows under the `mc_status_*` namespace. Battery is
 * normalised from mV → V to match the LPP `battery_volts` convention so
 * the UI's existing battery graph picks it up. Counter fields are written
 * raw (no derivation) so a future renderer can do its own deltas.
 *
 * Fields the firmware reports as 0/undefined are still emitted as zero
 * rather than dropped — uptime starting at 0 is meaningful, and a
 * Companion target that doesn't ship these counters simply omits them
 * (the manager's `requestNodeStatus` decoder leaves the field undefined).
 *
 * Exported for the unit test.
 */
export interface StatusFieldDef {
  source: keyof MeshCoreStatus;
  telemetryType: string;
  unit?: string;
  transform?: (v: number) => number;
}

export const STATUS_FIELD_MAP: readonly StatusFieldDef[] = [
  { source: 'batteryMv', telemetryType: 'battery_volts', unit: 'V', transform: (v) => v / 1000 },
  { source: 'uptimeSecs', telemetryType: 'uptime_secs', unit: 's' },
  { source: 'queueLen', telemetryType: 'queue_len' },
  { source: 'noiseFloor', telemetryType: 'noise_floor', unit: 'dB' },
  { source: 'lastRssi', telemetryType: 'last_rssi', unit: 'dBm' },
  { source: 'lastSnr', telemetryType: 'last_snr', unit: 'dB' },
  { source: 'packetsRecv', telemetryType: 'packets_recv' },
  { source: 'packetsSent', telemetryType: 'packets_sent' },
  { source: 'airTimeSecs', telemetryType: 'air_time_secs', unit: 's' },
  { source: 'sentFlood', telemetryType: 'sent_flood' },
  { source: 'sentDirect', telemetryType: 'sent_direct' },
  { source: 'recvFlood', telemetryType: 'recv_flood' },
  { source: 'recvDirect', telemetryType: 'recv_direct' },
  { source: 'errors', telemetryType: 'errors' },
  { source: 'directDups', telemetryType: 'direct_dups' },
  { source: 'floodDups', telemetryType: 'flood_dups' },
];

export function statusToTelemetryRows(
  status: MeshCoreStatus,
  nodeId: string,
  nodeNum: number,
  timestamp: number,
): DbTelemetry[] {
  const out: DbTelemetry[] = [];
  for (const def of STATUS_FIELD_MAP) {
    const raw = status[def.source];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const value = def.transform ? def.transform(raw) : raw;
    if (!Number.isFinite(value)) continue;
    out.push({
      nodeId,
      nodeNum,
      telemetryType: `${MC_TELEMETRY_PREFIX}status_${def.telemetryType}`,
      value,
      unit: def.unit,
      timestamp,
      createdAt: timestamp,
    });
  }
  return out;
}

export class MeshCoreRemoteTelemetryScheduler {
  private readonly registry: SourceManagerRegistry;
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
      const managers = this.registry.getAllManagers().filter(isMeshCoreManager);
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

    const isRepeaterLike = typeof target.advType === 'number' && REPEATER_ADV_TYPES.has(target.advType);
    const keyShort = target.publicKey.substring(0, 16);
    logger.info(
      `[MeshCoreRemoteTelem:${manager.sourceId}] Requesting telemetry from ${keyShort}… (${isRepeaterLike ? 'repeater: status + LPP' : 'companion: LPP'})`,
    );

    // Stamp the request time BEFORE issuing — preserves fair rotation
    // when several nodes share the same overdue-by, so a slow / failing
    // node doesn't starve its peers on subsequent ticks. The manager
    // also bumps its own `lastMeshTxAt` inside `requestRemoteTelemetry`
    // on success; we pre-bump here so the per-source 60s gate applies
    // regardless of which sub-call returns first.
    await this.database.meshcore.markTelemetryRequested(manager.sourceId, target.publicKey, now);
    manager.recordMeshTx(now);

    // For repeater-like targets, request both the status blob and LPP;
    // companions only ship LPP. Throttle/stamp bookkeeping is owned here
    // (above); the actual request → convert → insert is shared with the
    // manual-poll routes via requestTelemetryForNode.
    await this.requestTelemetryForNode(manager, target, {
      includeStatus: isRepeaterLike,
      includeLpp: true,
    });
  }

  /**
   * Issue the telemetry request(s) for a single target and persist any
   * resulting rows. Shared by the scheduler tick and the manual-poll
   * routes so both paths use identical request → convert → insert logic.
   *
   * This does NOT enforce the per-source 60s gate or stamp
   * `lastMeshTxAt` / `lastTelemetryRequestAt` — callers own that policy
   * (the scheduler pre-stamps for fair rotation; the manual routes gate
   * and stamp themselves before calling in).
   *
   * @param opts.includeStatus request the `SendStatusReq` stats blob
   *   (path #1). Only meaningful for Repeater / Room Server targets;
   *   companions don't ship these counters.
   * @param opts.includeLpp request `GetTelemetryData` LPP sensor data
   *   (path #3), best-effort guest-login first on repeater-like targets.
   * @returns the number of telemetry rows written and the per-path
   *   source tags (e.g. `['status:16', 'lpp:3']`).
   */
  async requestTelemetryForNode(
    manager: MeshCoreManager,
    target: Pick<DbMeshCoreNode, 'publicKey'> & { advType?: number | null },
    opts: { includeStatus: boolean; includeLpp: boolean },
  ): Promise<{ written: number; sources: string[] }> {
    const isRepeaterLike =
      typeof target.advType === 'number' && REPEATER_ADV_TYPES.has(target.advType);
    const keyShort = target.publicKey.substring(0, 16);
    const nodeNum = nodeNumFromPubkey(target.publicKey);
    const ts = this.nowFn();
    const rows: DbTelemetry[] = [];
    const sources: string[] = [];

    // Path #1: SendStatusReq → StatusResponse. Works on any reachable
    // Repeater / Room Server with no login required, returns the
    // 16-field operational stats blob (battery, uptime, queue, packet
    // counters, RSSI/SNR, errors). Companion firmware doesn't ship
    // these counters, so the scheduler skips the call there to avoid
    // wasted air time. See https://github.com/Yeraze/meshmonitor/issues/3092.
    if (opts.includeStatus) {
      try {
        const status = await manager.requestNodeStatus(target.publicKey);
        if (status) {
          const statusRows = statusToTelemetryRows(status, target.publicKey, nodeNum, ts);
          if (statusRows.length > 0) {
            rows.push(...statusRows);
            sources.push(`status:${statusRows.length}`);
          }
          // Persist batteryMv to meshcore_nodes so getLowVoltageNodes() can
          // find it. Without this, batteryMv stays NULL in the table and the
          // low-battery notification service never fires for MeshCore nodes.
          // See https://github.com/Yeraze/meshmonitor/issues/3417
          if (typeof status.batteryMv === 'number' && status.batteryMv > 0) {
            try {
              await this.database.meshcore.upsertNode(
                { publicKey: target.publicKey, batteryMv: status.batteryMv },
                manager.sourceId,
              );
            } catch (err) {
              logger.warn(
                `[MeshCoreRemoteTelem:${manager.sourceId}] Failed to persist batteryMv for ${keyShort}…:`,
                err,
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          `[MeshCoreRemoteTelem:${manager.sourceId}] requestNodeStatus(${keyShort}…) threw:`,
          err,
        );
      }
    }

    // Path #3: GetTelemetryData binary request → BinaryResponse with a
    // Cayenne-LPP payload. Companion targets are the primary consumer of
    // this path (they're where actual sensors live), and Repeater targets
    // may also expose LPP channels once a guest session is established.
    if (opts.includeLpp) {
      // Best-effort guest-login: empty-password login is the canonical
      // way to unlock LPP `GetTelemetryData` responses on repeaters
      // whose `telemetry_mode_*` is set to `Disabled` for anonymous
      // callers. Tracked in-memory on the manager so we don't re-login
      // every tick. Failure is silently fine — the LPP request below
      // still runs in case the repeater is configured for anonymous
      // access.
      if (isRepeaterLike) {
        try {
          await manager.ensureGuestLogin(target.publicKey);
        } catch (err) {
          logger.debug(
            `[MeshCoreRemoteTelem:${manager.sourceId}] ensureGuestLogin(${keyShort}…) threw:`,
            err,
          );
        }
      }

      const records = await manager.requestRemoteTelemetry(target.publicKey);
      if (records && records.length > 0) {
        const lppRows: DbTelemetry[] = [];
        for (const rec of records) {
          lppRows.push(...recordToTelemetryRows(rec, target.publicKey, nodeNum, ts));
        }
        if (lppRows.length > 0) {
          rows.push(...lppRows);
          sources.push(`lpp:${lppRows.length}`);
        }

        // Persist GPS position (Cayenne-LPP type 136) to meshcore_nodes so that
        // Contact Details always reflects the latest GNSS fix from a telemetry poll,
        // not just the position carried in the last advert. Mirror of the batteryMv
        // persistence above. Issue: https://github.com/Yeraze/meshmonitor/issues/3861
        const gpsRecord = records.find(
          (r) =>
            r.type === LPP_GPS_TYPE &&
            typeof r.value === 'object' &&
            r.value !== null &&
            !Array.isArray(r.value),
        );
        if (gpsRecord) {
          const gpsVal = gpsRecord.value as Record<string, number>;
          const lat = typeof gpsVal.latitude === 'number' ? gpsVal.latitude : null;
          const lon = typeof gpsVal.longitude === 'number' ? gpsVal.longitude : null;
          if (lat !== null && lon !== null && !isNullIsland(lat, lon)) {
            try {
              await this.database.meshcore.upsertNode(
                {
                  publicKey: target.publicKey,
                  latitude: lat,
                  longitude: lon,
                  // Tag as telemetry-sourced (#3908) so this GNSS fix takes
                  // precedence over the static contact/advert position on
                  // subsequent writes, instead of being clobbered by it.
                  positionSource: 'telemetry',
                },
                manager.sourceId,
              );
            } catch (err) {
              logger.warn(
                `[MeshCoreRemoteTelem:${manager.sourceId}] Failed to persist GPS position for ${keyShort}…:`,
                err,
              );
            }
          }
        }
      }
    }

    if (rows.length === 0) {
      // Logged at info so silent-empty results are visible at normal log
      // levels. Operators have no other signal when a repeater's
      // `telemetry_mode_*` is set restrictively.
      const wanted = [opts.includeStatus ? 'status' : null, opts.includeLpp ? 'LPP' : null]
        .filter(Boolean)
        .join(' + ');
      logger.info(
        `[MeshCoreRemoteTelem:${manager.sourceId}] No telemetry from ${keyShort}… (${wanted} empty/timeout)`,
      );
      return { written: 0, sources };
    }

    try {
      await this.database.telemetry.insertTelemetryBatch(rows, manager.sourceId);
      logger.info(
        `[MeshCoreRemoteTelem:${manager.sourceId}] Wrote ${rows.length} telemetry rows for ${keyShort}… (${sources.join(', ')})`,
      );
      return { written: rows.length, sources };
    } catch (err) {
      logger.warn(`[MeshCoreRemoteTelem:${manager.sourceId}] insertTelemetryBatch failed:`, err);
      return { written: 0, sources };
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
