/**
 * Likely-aircraft classification queue (#5364/#5365 Phase 1 WP2, spec §4.2).
 *
 * A single fire-and-forget, coalescing, single-flight batch queue fed from
 * the three position-write sites (`meshtasticManager.ts` POSITION_APP and
 * NodeInfo, `mqttIngestion.ts` POSITION_APP). `schedule()` never throws and
 * is never awaited by its callers — it just records the (sourceId, nodeNum)
 * key and kicks a drain loop if one isn't already running.
 *
 * The drain loop batches up to `MAX_BATCH` jobs at a time, resolves ground
 * elevation via `ElevationProvider.sample()` (memoised per node so a fixed
 * node is sampled at most once), and writes a classification only when it
 * actually changed. A hung or all-null sample starts a 10-minute provider
 * backoff so an offline DEM source doesn't retry on every packet — see D4.
 *
 * `reclassifySource()` is the D6/D7 silent, no-network recompute run after a
 * settings save. `backfillAll()` is the D11 one-time startup sweep.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter, type NodeAircraftData } from './dataEventEmitter.js';
import { resolveProvider, type ElevationProvider } from './elevationProvider.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { LruCache } from '../utils/lruCache.js';
import type { LatLng } from '../../utils/greatCircle.js';
import {
  classifyAircraft,
  isAircraftTransition,
  normalizeLikelyAircraft,
  parseAircraftSettings,
  type AircraftBasis,
  type AircraftPrevious,
  type AircraftSettings,
} from '../../utils/aircraftClassification.js';
import type { DbNode } from '../../db/types.js';
import type {
  AircraftClassificationWrite,
  AircraftReclassifyRow,
} from '../../db/repositories/nodes.js';

export type AircraftClassifyReason = 'position' | 'backfill';

/** Max points per `ElevationProvider.sample()` call (spec §4.2). */
export const MAX_BATCH = 100;
/** Backstop against an unbounded queue; overflow drops the new key (logged at most once a minute). */
export const MAX_PENDING = 20_000;
/** `safeFetch` has no timeout (`ssrfGuard.ts`); this race prevents a hung fetch from wedging the single-flight queue (D4). */
export const SAMPLE_TIMEOUT_MS = 15_000;
/** How long an all-null / timed-out / failed sample suppresses further fetches (D4). */
export const PROVIDER_BACKOFF_MS = 10 * 60_000;
/** Max `(sourceId,nodeNum)` ground-elevation memo entries (D5). */
export const GROUND_MEMO_MAX = 20_000;
/** Delay after boot before the one-time silent backfill runs (D11). */
export const BACKFILL_DELAY_MS = 120_000;

/** Non-Meshtastic source types the D11 backfill and reclassify never touch (D2). */
const AIRCRAFT_EXCLUDED_SOURCE_TYPES = new Set(['meshcore', 'meshcore_mqtt', 'reticulum']);

interface PendingJob {
  sourceId: string;
  nodeNum: number;
  reason: AircraftClassifyReason;
}

interface GroundMemoEntry {
  latE4: number;
  lonE4: number;
  ground: number | null;
}

/** Per-job working state built up across the ground-resolution and classify passes. */
interface JobContext {
  job: PendingJob;
  node: DbNode;
  eff: ReturnType<typeof getEffectiveDbNodePosition>;
  previous: AircraftPrevious;
  settings: AircraftSettings;
  /** Resolved once ground lookup/fetch completes; null when no ground applies (basis msl/unknown). */
  groundElevationM: number | null;
  /** Set when this job needs a DEM sample (moved / never memoised / no memo hit). */
  needsSample: boolean;
  latE4?: number;
  lonE4?: number;
  lat?: number;
  lng?: number;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface AircraftClassificationDeps {
  getNode(nodeNum: number, sourceId: string): Promise<DbNode | null>;
  writeClassification(nodeNum: number, sourceId: string, c: AircraftClassificationWrite): Promise<void>;
  listForReclassify(sourceId: string): Promise<AircraftReclassifyRow[]>;
  listUnclassifiedWithAltitude(sourceId: string): Promise<number[]>;
  clearClassification(sourceId: string): Promise<number>;
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  getGlobalSetting(key: string): Promise<string | null>;
  listSources(): Promise<Array<{ id: string; type: string }>>;
  resolveProvider(url: string | undefined): ElevationProvider;
  emitAircraft(data: NodeAircraftData, sourceId: string): void;
  now(): number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}

function defaultDeps(): AircraftClassificationDeps {
  return {
    getNode: (nodeNum, sourceId) => databaseService.nodes.getNode(nodeNum, sourceId),
    writeClassification: (nodeNum, sourceId, c) =>
      databaseService.nodes.setAircraftClassification(nodeNum, sourceId, c),
    listForReclassify: (sourceId) => databaseService.nodes.getAircraftReclassifyRows(sourceId),
    listUnclassifiedWithAltitude: (sourceId) =>
      databaseService.nodes.getUnclassifiedNodeNumsWithAltitude(sourceId),
    clearClassification: (sourceId) => databaseService.nodes.clearAircraftClassification(sourceId),
    getSourceSetting: (sourceId, key) => databaseService.settings.getSettingForSource(sourceId, key),
    getGlobalSetting: (key) => databaseService.settings.getSetting(key),
    listSources: async () =>
      (await databaseService.sources.getAllSources()).map((s) => ({ id: s.id, type: s.type })),
    resolveProvider: (url) => resolveProvider(url),
    emitAircraft: (data, sourceId) => dataEventEmitter.emitNodeAircraft(data, sourceId),
    now: () => Date.now(),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  };
}

export class AircraftClassificationService {
  private readonly deps: AircraftClassificationDeps;
  private pending = new Map<string, PendingJob>();
  private drainPromise: Promise<void> | null = null;
  /**
   * Set synchronously the moment a drain is queued, cleared only once that
   * drain finishes. Guards `kickDrain()` against queuing a second microtask
   * while the first is still pending (`drainPromise` alone isn't set until
   * the deferred callback actually runs) — see `kickDrain()`.
   */
  private drainScheduled = false;
  private groundMemo: LruCache<string, GroundMemoEntry>;
  /** Global — `elevationSourceUrl`/`elevationEnabled` are global-only settings, so one provider serves every source. */
  private backoffUntil = 0;
  private lastDropLogAt = 0;

  constructor(deps?: Partial<AircraftClassificationDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
    this.groundMemo = new LruCache<string, GroundMemoEntry>(GROUND_MEMO_MAX);
  }

  /**
   * Coalesces by `${sourceId}:${nodeNum}`; `'position'` wins over
   * `'backfill'` when both are pending for the same key. Sync, never throws,
   * never awaited by the caller — it just records the job and (if no drain
   * loop is already running) starts one.
   */
  schedule(sourceId: string, nodeNum: number, reason: AircraftClassifyReason = 'position'): void {
    try {
      const key = `${sourceId}:${nodeNum}`;
      const existing = this.pending.get(key);
      if (existing?.reason === 'position' && reason === 'backfill') {
        return; // Keep the higher-priority reason already queued.
      }
      if (!existing && this.pending.size >= MAX_PENDING) {
        const now = this.deps.now();
        if (now - this.lastDropLogAt >= 60_000) {
          this.lastDropLogAt = now;
          logger.debug(`Aircraft classification queue full (${MAX_PENDING}); dropping new jobs`);
        }
        return;
      }
      this.pending.set(key, { sourceId, nodeNum, reason });
      this.kickDrain();
    } catch (err) {
      logger.debug(`Aircraft classification schedule failed for ${sourceId}:${nodeNum}: ${err}`);
    }
  }

  /**
   * Defers the actual `drainLoop()` start to a microtask rather than calling
   * it inline. Calling an async function runs it synchronously up to its
   * first internal `await`, so an inline call here would let the very first
   * `schedule()` in a synchronous burst (e.g. 150 positions in one packet
   * loop tick) snatch a size-1 batch before the rest of the burst ever
   * reaches `pending` — defeating the `MAX_BATCH` grouping the batching
   * exists for. Deferring to a microtask lets the whole synchronous burst
   * populate `pending` first.
   */
  private kickDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainPromise = this.drainLoop().finally(() => {
        this.drainPromise = null;
        this.drainScheduled = false;
      });
    });
  }

  /** Test hook: drains everything currently queued (starting a drain if none is running) and awaits it. */
  async drainForTest(): Promise<void> {
    this.kickDrain();
    // The microtask above may not have run yet — wait for it to assign
    // `drainPromise` before awaiting it.
    while (this.drainScheduled && !this.drainPromise) {
      await Promise.resolve();
    }
    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  /** Test hook: clears all in-memory state (queue, ground memo, backoff). */
  resetForTest(): void {
    this.pending.clear();
    this.drainPromise = null;
    this.drainScheduled = false;
    this.groundMemo = new LruCache<string, GroundMemoEntry>(GROUND_MEMO_MAX);
    this.backoffUntil = 0;
    this.lastDropLogAt = 0;
  }

  private async drainLoop(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = this.takeBatch();
      try {
        await this.processBatch(batch);
      } catch (err) {
        logger.debug(`Aircraft classification batch failed: ${err}`);
      }
    }
  }

  private takeBatch(): PendingJob[] {
    const out: PendingJob[] = [];
    for (const job of this.pending.values()) {
      if (out.length >= MAX_BATCH) break;
      out.push(job);
    }
    for (const job of out) {
      this.pending.delete(`${job.sourceId}:${job.nodeNum}`);
    }
    return out;
  }

  private async processBatch(batch: PendingJob[]): Promise<void> {
    const settingsCache = new Map<string, AircraftSettings>();
    const disabledClearedSources = new Set<string>();
    const contexts: JobContext[] = [];

    // Pass 1: load settings + node, skip disabled sources, resolve ground
    // from the memo where possible, and collect the rest for sampling.
    for (const job of batch) {
      try {
        let settings = settingsCache.get(job.sourceId);
        if (!settings) {
          const [enabled, agl, msl] = await Promise.all([
            this.deps.getSourceSetting(job.sourceId, 'aircraftDetectionEnabled'),
            this.deps.getSourceSetting(job.sourceId, 'aircraftAglThresholdMeters'),
            this.deps.getSourceSetting(job.sourceId, 'aircraftMslThresholdMeters'),
          ]);
          settings = parseAircraftSettings({ enabled, aglThresholdM: agl, mslThresholdM: msl });
          settingsCache.set(job.sourceId, settings);
        }

        if (!settings.enabled) {
          if (!disabledClearedSources.has(job.sourceId)) {
            disabledClearedSources.add(job.sourceId);
            await this.deps.clearClassification(job.sourceId);
          }
          continue;
        }

        const node = await this.deps.getNode(job.nodeNum, job.sourceId);
        if (!node) continue;

        const eff = getEffectiveDbNodePosition(node);
        const previous: AircraftPrevious = {
          likelyAircraft: normalizeLikelyAircraft(node.likelyAircraft),
          basis: (node.aircraftBasis as AircraftBasis | null | undefined) ?? null,
        };

        const ctx: JobContext = {
          job,
          node,
          eff,
          previous,
          settings,
          groundElevationM: null,
          needsSample: false,
        };

        if (!isFiniteNum(eff.altitude)) {
          // No altitude → no ground needed; classifyAircraft returns 'unknown'.
          contexts.push(ctx);
          continue;
        }

        const lat = eff.latitude;
        const lng = eff.longitude;
        if (lat == null || lng == null || isBogusPosition(lat, lng, node.positionPrecisionBits)) {
          ctx.groundElevationM = null;
          contexts.push(ctx);
          continue;
        }

        const latE4 = Math.round(lat * 1e4);
        const lonE4 = Math.round(lng * 1e4);
        const memoKey = `${job.sourceId}:${job.nodeNum}`;
        const memo = this.groundMemo.get(memoKey);
        if (memo && memo.latE4 === latE4 && memo.lonE4 === lonE4) {
          ctx.groundElevationM = memo.ground;
        } else {
          ctx.needsSample = true;
          ctx.latE4 = latE4;
          ctx.lonE4 = lonE4;
          ctx.lat = lat;
          ctx.lng = lng;
        }
        contexts.push(ctx);
      } catch (err) {
        logger.debug(`Aircraft classification: skipping ${job.sourceId}:${job.nodeNum}: ${err}`);
      }
    }

    const needsSample = contexts.filter((c) => c.needsSample);
    if (needsSample.length > 0) {
      await this.resolveGroundSamples(needsSample);
    }

    // Pass 2: classify + write + emit.
    for (const ctx of contexts) {
      try {
        await this.classifyAndWrite(ctx);
      } catch (err) {
        logger.debug(`Aircraft classification: write failed for ${ctx.job.sourceId}:${ctx.job.nodeNum}: ${err}`);
      }
    }
  }

  private async resolveGroundSamples(needsSample: JobContext[]): Promise<void> {
    const elevationEnabled = await this.deps.getGlobalSetting('elevationEnabled');
    if (elevationEnabled === 'false') {
      for (const ctx of needsSample) ctx.groundElevationM = null;
      return;
    }

    const now = this.deps.now();
    if (now < this.backoffUntil) {
      for (const ctx of needsSample) ctx.groundElevationM = null;
      return;
    }

    const sourceUrl = (await this.deps.getGlobalSetting('elevationSourceUrl')) ?? undefined;
    const provider = this.deps.resolveProvider(sourceUrl);
    const points: LatLng[] = needsSample.map((ctx) => ({ lat: ctx.lat as number, lng: ctx.lng as number }));

    try {
      const outcome = await this.sampleWithTimeout(provider, points);
      if (outcome === 'timeout') {
        this.enterBackoff('elevation sample timed out');
        for (const ctx of needsSample) ctx.groundElevationM = null;
        return;
      }
      const allNull = outcome.length > 0 && outcome.every((v) => v === null);
      if (allNull) {
        this.enterBackoff('elevation sample returned no data');
      }
      needsSample.forEach((ctx, i) => {
        const value = outcome[i] ?? null;
        ctx.groundElevationM = value;
        if (value !== null) {
          this.groundMemo.set(`${ctx.job.sourceId}:${ctx.job.nodeNum}`, {
            latE4: ctx.latE4 as number,
            lonE4: ctx.lonE4 as number,
            ground: value,
          });
        }
      });
    } catch (err) {
      this.enterBackoff(`elevation sample failed: ${err}`);
      for (const ctx of needsSample) ctx.groundElevationM = null;
    }
  }

  private enterBackoff(reason: string): void {
    const now = this.deps.now();
    const alreadyBackingOff = now < this.backoffUntil;
    this.backoffUntil = now + PROVIDER_BACKOFF_MS;
    if (!alreadyBackingOff) {
      logger.warn(`Aircraft classification: ${reason}; backing off elevation sampling for 10 minutes`);
    }
  }

  private sampleWithTimeout(
    provider: ElevationProvider,
    points: LatLng[],
  ): Promise<(number | null)[] | 'timeout'> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.deps.setTimer(() => {
        if (settled) return;
        settled = true;
        resolve('timeout');
      }, SAMPLE_TIMEOUT_MS);
      provider.sample(points).then(
        (result) => {
          if (settled) return;
          settled = true;
          this.deps.clearTimer(timer);
          resolve(result);
        },
        (err) => {
          if (settled) return;
          settled = true;
          this.deps.clearTimer(timer);
          reject(err);
        },
      );
    });
  }

  private async classifyAndWrite(ctx: JobContext): Promise<void> {
    const { job, node, eff, previous, settings } = ctx;
    const c = classifyAircraft({
      altitudeM: eff.altitude,
      groundElevationM: ctx.groundElevationM,
      settings,
      previous,
    });

    const prevBasis = (node.aircraftBasis as string | null | undefined) ?? null;
    const prevGround = node.groundElevation ?? null;
    const prevHag = node.heightAboveGround ?? null;
    const likelyChanged = previous.likelyAircraft !== c.likelyAircraft;
    const basisChanged = prevBasis !== c.basis;
    const groundChanged = prevGround !== c.groundElevation;
    const hagChanged =
      prevHag === null || c.heightAboveGround === null
        ? prevHag !== c.heightAboveGround
        : Math.abs(prevHag - c.heightAboveGround) >= 1;
    const neverClassified = node.aircraftClassifiedAt == null;

    if (likelyChanged || basisChanged || groundChanged || hagChanged || neverClassified) {
      const write: AircraftClassificationWrite = {
        likelyAircraft: c.likelyAircraft,
        aircraftBasis: c.basis,
        groundElevation: c.groundElevation,
        heightAboveGround: c.heightAboveGround,
        aircraftClassifiedAt: this.deps.now(),
      };
      await this.deps.writeClassification(job.nodeNum, job.sourceId, write);
    }

    if (job.reason === 'position' && isAircraftTransition(previous.likelyAircraft, c.likelyAircraft)) {
      this.deps.emitAircraft(
        {
          nodeNum: job.nodeNum,
          previous: previous.likelyAircraft,
          current: true,
          basis: c.basis as 'agl' | 'msl',
          altitude: eff.altitude as number,
          groundElevation: c.groundElevation,
          heightAboveGround: c.heightAboveGround,
          thresholdM: c.basis === 'agl' ? settings.aglThresholdM : settings.mslThresholdM,
          latitude: eff.latitude ?? null,
          longitude: eff.longitude ?? null,
        },
        job.sourceId,
      );
    }
  }

  /**
   * D6/D7: silent, no-network recompute from stored values, run right after
   * a settings save. Detection off → clears the source instead. Never emits
   * (D9) — only a live position job can fire `trigger.becameLikelyAircraft`.
   */
  async reclassifySource(sourceId: string): Promise<number> {
    try {
      const [enabled, agl, msl] = await Promise.all([
        this.deps.getSourceSetting(sourceId, 'aircraftDetectionEnabled'),
        this.deps.getSourceSetting(sourceId, 'aircraftAglThresholdMeters'),
        this.deps.getSourceSetting(sourceId, 'aircraftMslThresholdMeters'),
      ]);
      const settings = parseAircraftSettings({ enabled, aglThresholdM: agl, mslThresholdM: msl });

      if (!settings.enabled) {
        return this.deps.clearClassification(sourceId);
      }

      const rows = await this.deps.listForReclassify(sourceId);
      let written = 0;
      for (const row of rows) {
        try {
          const eff = getEffectiveDbNodePosition(row);
          const previous: AircraftPrevious = {
            likelyAircraft: normalizeLikelyAircraft(row.likelyAircraft),
            basis: (row.aircraftBasis as AircraftBasis | null | undefined) ?? null,
          };
          const c = classifyAircraft({
            altitudeM: eff.altitude,
            groundElevationM: row.groundElevation,
            settings,
            previous,
          });

          const prevGround = row.groundElevation ?? null;
          const prevHag = row.heightAboveGround ?? null;
          const likelyChanged = previous.likelyAircraft !== c.likelyAircraft;
          const basisChanged = (previous.basis ?? null) !== c.basis;
          const groundChanged = prevGround !== c.groundElevation;
          const hagChanged =
            prevHag === null || c.heightAboveGround === null
              ? prevHag !== c.heightAboveGround
              : Math.abs(prevHag - c.heightAboveGround) >= 1;

          if (likelyChanged || basisChanged || groundChanged || hagChanged) {
            await this.deps.writeClassification(row.nodeNum, sourceId, {
              likelyAircraft: c.likelyAircraft,
              aircraftBasis: c.basis,
              groundElevation: c.groundElevation,
              heightAboveGround: c.heightAboveGround,
              aircraftClassifiedAt: this.deps.now(),
            });
            written++;
          }
        } catch (err) {
          logger.debug(`Aircraft reclassify: row ${row.nodeNum}@${sourceId} failed: ${err}`);
        }
      }
      return written;
    } catch (err) {
      logger.debug(`Aircraft reclassify failed for source ${sourceId}: ${err}`);
      return 0;
    }
  }

  /**
   * D11: once, ~2 minutes after boot, enqueue every unclassified-with-altitude
   * node row on every non-MeshCore/Reticulum source that has detection
   * enabled. Silent — jobs run with `reason: 'backfill'`, so no automation
   * event fires and no ground fetch bursts happen beyond the normal batching
   * / backoff rules.
   */
  async backfillAll(): Promise<void> {
    let sources: Array<{ id: string; type: string }>;
    try {
      sources = await this.deps.listSources();
    } catch (err) {
      logger.debug(`Aircraft backfill: failed to list sources: ${err}`);
      return;
    }

    const eligible = sources.filter((s) => !AIRCRAFT_EXCLUDED_SOURCE_TYPES.has(s.type));
    for (const source of eligible) {
      try {
        const enabled = await this.deps.getSourceSetting(source.id, 'aircraftDetectionEnabled');
        if (enabled === 'false') continue;
        const nodeNums = await this.deps.listUnclassifiedWithAltitude(source.id);
        for (const nodeNum of nodeNums) {
          this.schedule(source.id, nodeNum, 'backfill');
        }
      } catch (err) {
        logger.debug(`Aircraft backfill: failed for source ${source.id}: ${err}`);
      }
    }
  }
}

export const aircraftClassificationService = new AircraftClassificationService();
