/**
 * Aircraft age-out and "reclassify as fixed" sweep (#5364/#5365 Phase 2,
 * AIRCRAFT_P2_SPEC.md "Backend").
 *
 * `runSweep(sourceId, now)` does two passes over the source's flagged
 * (`likelyAircraft = true`) nodes:
 *
 *  1. **Fixed pass (D4)** — always, while detection is on. A flagged,
 *     non-ignored node heard in the last 24 h whose last-24 h fixes on this
 *     source all sit within 200 m (`isStationaryFix`) is not an aircraft: the
 *     flag is cleared and a sticky "confirmed fixed" anchor is set.
 *  2. **Age-out pass (D2)** — only when `aircraftAgeOutEnabled`. A flagged
 *     node not heard for N hours is ignored (DB-only, `reason 'aircraft'`)
 *     or, on explicit opt-in, deleted. Favourites, the local node, and nodes
 *     already ignored for any reason are never touched.
 *
 * The run time is persisted per source (`aircraftAgeOutLastRunAt`) so a
 * restart or a settings save never counts as a run — the scheduler reads it.
 *
 * `onLivePosition(sourceId, nodeNum)` is the D3 auto-lift, called from the
 * position write sites only for live receptions (`isLiveReception`).
 *
 * Mesh impact: none. Nothing here sends a packet, fires a notification, or
 * emits an automation event.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { isLiveReception } from '../utils/replayGuard.js';
import { aircraftClassificationService, AIRCRAFT_EXCLUDED_SOURCE_TYPES } from './aircraftClassificationService.js';
import {
  AIRCRAFT_FIXED_WINDOW_MS,
  isStationaryFix,
  parseAircraftAgeOutSettings,
  parseAircraftSettings,
  type AircraftAgeOutLastResult,
} from '../../utils/aircraftClassification.js';
import type { AircraftAgeOutCandidate } from '../../db/repositories/nodes.js';

export const LAST_RUN_AT_KEY = 'aircraftAgeOutLastRunAt';
export const LAST_RESULT_KEY = 'aircraftAgeOutLastResult';
/** Upper bound on position rows read per node for the fixed rule (lat + lon rows per fix). */
const FIXED_TELEMETRY_LIMIT = 2000;

export interface AircraftAgeOutDeps {
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  setSourceSetting(sourceId: string, key: string, value: string): Promise<void>;
  getSourceType(sourceId: string): Promise<string | null>;
  getLocalNodeNum(sourceId: string): Promise<number | null>;
  listCandidates(sourceId: string): Promise<AircraftAgeOutCandidate[]>;
  getPositionFixes(nodeId: string, sinceMs: number, sourceId: string): Promise<Array<{ lat: number; lon: number }>>;
  setFixed(nodeNum: number, sourceId: string, fixed: { atMs: number; lat: number; lon: number } | null): Promise<void>;
  addAircraftIgnore(nodeNum: number, sourceId: string, nodeId: string, longName?: string, shortName?: string): Promise<boolean>;
  markAgedOut(nodeNum: number, sourceId: string, atMs: number): Promise<void>;
  deleteNode(nodeNum: number, sourceId: string): Promise<void>;
  getAgedOutAt(nodeNum: number, sourceId: string): Promise<number | null>;
  isIgnoredCached(nodeNum: number, sourceId: string): boolean;
  liftAircraftIgnore(nodeNum: number, sourceId: string): Promise<boolean>;
  clearAgedOut(nodeNum: number, sourceId: string): Promise<void>;
  scheduleClassification(sourceId: string, nodeNum: number): void;
}

/**
 * Pair latitude/longitude telemetry rows into fixes. Both rows of one fix are
 * written with the same `timestamp` (receive time, ms), so pair on that.
 */
export function pairPositionRows(
  rows: Array<{ telemetryType: string; timestamp: number; value: number }>,
): Array<{ lat: number; lon: number }> {
  const lats = new Map<number, number>();
  const lons = new Map<number, number>();
  for (const r of rows) {
    const ts = Number(r.timestamp);
    if (r.telemetryType === 'latitude') lats.set(ts, Number(r.value));
    else if (r.telemetryType === 'longitude') lons.set(ts, Number(r.value));
  }
  const out: Array<{ lat: number; lon: number }> = [];
  for (const [ts, lat] of lats) {
    const lon = lons.get(ts);
    if (lon !== undefined) out.push({ lat, lon });
  }
  return out;
}

function defaultDeps(): AircraftAgeOutDeps {
  return {
    getSourceSetting: (sourceId, key) => databaseService.settings.getSettingForSource(sourceId, key),
    setSourceSetting: (sourceId, key, value) => databaseService.settings.setSourceSetting(sourceId, key, value),
    getSourceType: async (sourceId) => (await databaseService.sources.getSource(sourceId))?.type ?? null,
    getLocalNodeNum: async (sourceId) => {
      const raw = await databaseService.settings.getLocalNodeNumForSource(sourceId);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    },
    listCandidates: (sourceId) => databaseService.listAircraftAgeOutCandidatesAsync(sourceId),
    getPositionFixes: async (nodeId, sinceMs, sourceId) =>
      pairPositionRows(
        await databaseService.telemetry.getPositionTelemetryByNode(nodeId, FIXED_TELEMETRY_LIMIT, sinceMs, sourceId),
      ),
    setFixed: (nodeNum, sourceId, fixed) => databaseService.setAircraftFixedAsync(nodeNum, sourceId, fixed),
    addAircraftIgnore: (nodeNum, sourceId, nodeId, longName, shortName) =>
      databaseService.addAircraftIgnoreAsync(nodeNum, sourceId, nodeId, longName, shortName),
    markAgedOut: (nodeNum, sourceId, atMs) => databaseService.markAircraftAgedOutAsync(nodeNum, sourceId, atMs),
    deleteNode: async (nodeNum, sourceId) => {
      await databaseService.deleteNodeAsync(nodeNum, sourceId);
    },
    getAgedOutAt: (nodeNum, sourceId) => databaseService.getAircraftAgedOutAtAsync(nodeNum, sourceId),
    isIgnoredCached: (nodeNum, sourceId) => databaseService.ignoredNodes.isIgnoredCached(nodeNum, sourceId),
    liftAircraftIgnore: (nodeNum, sourceId) => databaseService.liftAircraftIgnoreAsync(nodeNum, sourceId),
    clearAgedOut: (nodeNum, sourceId) => databaseService.clearAircraftAgedOutAsync(nodeNum, sourceId),
    scheduleClassification: (sourceId, nodeNum) => aircraftClassificationService.schedule(sourceId, nodeNum),
  };
}

export interface AircraftSweepOutcome extends AircraftAgeOutLastResult {
  /** False when the sweep was skipped (detection off, excluded source type). */
  ran: boolean;
}

export class AircraftAgeOutService {
  private readonly deps: AircraftAgeOutDeps;
  /**
   * Live-position lifts since the source's last sweep, reported as `lifted`
   * in `aircraftAgeOutLastResult`. In memory only: a restart loses the
   * running count, which is a status figure, not a safety timer.
   */
  private liftedSinceLastRun = new Map<string, number>();

  constructor(deps?: Partial<AircraftAgeOutDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  async runSweep(sourceId: string, now: number): Promise<AircraftSweepOutcome> {
    const result: AircraftSweepOutcome = { ran: false, agedOut: 0, fixed: 0, lifted: 0, deleted: 0 };

    const type = await this.deps.getSourceType(sourceId);
    if (type && AIRCRAFT_EXCLUDED_SOURCE_TYPES.has(type)) return result;

    const [detEnabled, ageEnabled, ageHours, ageAction] = await Promise.all([
      this.deps.getSourceSetting(sourceId, 'aircraftDetectionEnabled'),
      this.deps.getSourceSetting(sourceId, 'aircraftAgeOutEnabled'),
      this.deps.getSourceSetting(sourceId, 'aircraftAgeOutHours'),
      this.deps.getSourceSetting(sourceId, 'aircraftAgeOutAction'),
    ]);
    if (!parseAircraftSettings({ enabled: detEnabled }).enabled) return result;
    const ageOut = parseAircraftAgeOutSettings({ enabled: ageEnabled, hours: ageHours, action: ageAction });

    result.ran = true;
    const candidates = await this.deps.listCandidates(sourceId);
    const fixedNow = new Set<number>();

    // Pass 1: reclassify as fixed (D4).
    const recentCutoffSec = (now - AIRCRAFT_FIXED_WINDOW_MS) / 1000;
    for (const c of candidates) {
      if (c.isIgnored) continue;
      if (c.lastHeard == null || c.lastHeard < recentCutoffSec) continue;
      try {
        const fixes = await this.deps.getPositionFixes(c.nodeId, now - AIRCRAFT_FIXED_WINDOW_MS, sourceId);
        if (!isStationaryFix(fixes)) continue;
        const eff = getEffectiveDbNodePosition(c);
        const anchor =
          eff.latitude != null && eff.longitude != null && Number.isFinite(eff.latitude) && Number.isFinite(eff.longitude)
            ? { lat: eff.latitude, lon: eff.longitude }
            : fixes[fixes.length - 1];
        await this.deps.setFixed(c.nodeNum, sourceId, { atMs: now, lat: anchor.lat, lon: anchor.lon });
        fixedNow.add(c.nodeNum);
        result.fixed++;
      } catch (err) {
        logger.debug(`Aircraft fixed check failed for ${c.nodeNum}@${sourceId}: ${err}`);
      }
    }

    // Pass 2: age out (D2), only when enabled.
    if (ageOut.enabled) {
      const localNodeNum = await this.deps.getLocalNodeNum(sourceId);
      const cutoffSec = (now - ageOut.hours * 3_600_000) / 1000;
      for (const c of candidates) {
        if (fixedNow.has(c.nodeNum)) continue;
        if (c.isFavorite || c.isIgnored) continue;
        if (localNodeNum != null && c.nodeNum === localNodeNum) continue;
        // A never-heard row has nothing to age from; leave it.
        if (c.lastHeard == null || c.lastHeard >= cutoffSec) continue;
        try {
          if (ageOut.action === 'delete') {
            await this.deps.deleteNode(c.nodeNum, sourceId);
            result.deleted++;
          } else {
            await this.deps.addAircraftIgnore(c.nodeNum, sourceId, c.nodeId, c.longName ?? undefined, c.shortName ?? undefined);
            await this.deps.markAgedOut(c.nodeNum, sourceId, now);
            result.agedOut++;
          }
        } catch (err) {
          logger.debug(`Aircraft age-out failed for ${c.nodeNum}@${sourceId}: ${err}`);
        }
      }
    }

    result.lifted = this.liftedSinceLastRun.get(sourceId) ?? 0;
    this.liftedSinceLastRun.delete(sourceId);

    const lastResult: AircraftAgeOutLastResult = {
      agedOut: result.agedOut,
      fixed: result.fixed,
      lifted: result.lifted,
      deleted: result.deleted,
    };
    await this.deps.setSourceSetting(sourceId, LAST_RUN_AT_KEY, String(now));
    await this.deps.setSourceSetting(sourceId, LAST_RESULT_KEY, JSON.stringify(lastResult));

    logger.info(
      `✈️ Aircraft sweep for source ${sourceId}: ${result.agedOut} aged out, ${result.deleted} deleted, ` +
        `${result.fixed} reclassified as fixed, ${result.lifted} returned`,
    );
    return result;
  }

  /**
   * D3 auto-lift. Call only for a live reception. If the node is an aged-out
   * aircraft, lift its `'aircraft'` ignore (manual and geo rows are never
   * touched) and clear the aged-out mark. Then (re)queues classification
   * unless `opts.classify` is false (the MQTT path only classifies a fix that
   * carries an altitude). Never throws; the caller does not await it.
   */
  /**
   * Entry point for the position write sites. A live reception goes through
   * the D3 auto-lift (`onLivePosition`); a replayed one (fw2.8 NodeDB replay,
   * retained MQTT frame) only queues classification, as in Phase 1. Sync,
   * never throws, never awaited.
   */
  handlePositionReception(
    sourceId: string,
    nodeNum: number,
    rxTimeSec: number | null | undefined,
    nowMs: number,
    opts: { classify?: boolean } = {},
  ): void {
    try {
      if (isLiveReception(rxTimeSec, nowMs)) {
        void this.onLivePosition(sourceId, nodeNum, opts);
      } else if (opts.classify !== false) {
        this.deps.scheduleClassification(sourceId, nodeNum);
      }
    } catch (err) {
      logger.debug(`Aircraft position hook failed for ${nodeNum}@${sourceId}: ${err}`);
    }
  }

  async onLivePosition(sourceId: string, nodeNum: number, opts: { classify?: boolean } = {}): Promise<void> {
    try {
      // Cheap pre-check: a node that isn't ignored at all can't be aged out.
      if (this.deps.isIgnoredCached(nodeNum, sourceId)) {
        const agedOutAt = await this.deps.getAgedOutAt(nodeNum, sourceId);
        if (agedOutAt != null) {
          const lifted = await this.deps.liftAircraftIgnore(nodeNum, sourceId);
          if (lifted) {
            await this.deps.clearAgedOut(nodeNum, sourceId);
            this.liftedSinceLastRun.set(sourceId, (this.liftedSinceLastRun.get(sourceId) ?? 0) + 1);
            logger.info(`✈️ Aged-out aircraft ${nodeNum} on source ${sourceId} sent a live position; ignore lifted`);
          }
        }
      }
    } catch (err) {
      logger.debug(`Aircraft auto-lift failed for ${nodeNum}@${sourceId}: ${err}`);
    }
    if (opts.classify !== false) this.deps.scheduleClassification(sourceId, nodeNum);
  }
}

export const aircraftAgeOutService = new AircraftAgeOutService();
