/**
 * ADS-B flight matching for likely aircraft (#5374, ADSB_MATCH_SPEC.md
 * "Service").
 *
 * When a node BECOMES a likely aircraft (the Phase 1 live `node:aircraft`
 * transition), ask the configured public ADS-B feed which aircraft is at that
 * spot. At most two lookups per flagging:
 *
 *  1. on the transition — a hit reads "Possible match";
 *  2. on the node's next live position 60 s – 30 min later — the same ICAO hex
 *     again upgrades it to "Matched".
 *
 * A match only confirms; no match never clears the likely-aircraft flag.
 *
 * Mesh impact: none. Outbound HTTPS only — no packets, no events, no
 * notifications. Rate limits:
 *  - the per-flagging lookup count lives in `aircraft_flight_matches`, so a
 *    restart or settings save cannot reset it (and a restart is not a
 *    transition, so it triggers nothing);
 *  - one global queue spaces requests ≥ 1.1 s apart (feeds cap at 1 req/s);
 *  - any 429 / 403 / 5xx / timeout / network failure starts a 10-minute global
 *    backoff; a failed lookup does not spend the node's allowance;
 *  - a node flagged on several sources at once shares one HTTP request via a
 *    60-second in-memory reuse cache.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter, type DataEvent, type NodeAircraftData } from './dataEventEmitter.js';
import { AIRCRAFT_EXCLUDED_SOURCE_TYPES } from './aircraftClassificationService.js';
import { fetchAircraftNear, AdsbFeedError } from './adsbFeedClient.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { matchAircraft, radiusToNm, searchRadiusKm, type AdsbAircraft } from '../../utils/adsbMatch.js';
import { resolveAdsbFeed, type AdsbFeedInfo } from '../../utils/adsbFeeds.js';
import type { DbNode } from '../../db/types.js';
import type {
  AircraftFlightMatchRow,
  FlightMatchLookupWrite,
  FlightMatchResultWrite,
} from '../../db/repositories/aircraftFlightMatches.js';

/** Minimum gap between two outbound requests, any feed, any node. */
export const LOOKUP_SPACING_MS = 1_100;
/** Global pause after a 429 / 403 / 5xx / timeout / network failure. */
export const FEED_BACKOFF_MS = 10 * 60_000;
/** Lookup 2 window, measured from lookup 1. */
export const SECOND_LOOKUP_MIN_MS = 60_000;
export const SECOND_LOOKUP_MAX_MS = 30 * 60_000;
/** Cross-source reuse window for one (node, spot, minute) response. */
export const REUSE_TTL_MS = 60_000;
/** A node that just failed a lookup waits this long before trying again. */
export const RETRY_FLOOR_MS = 60_000;
/** Backstop on queued requests; overflow is dropped (not counted). */
export const MAX_QUEUED = 100;

export const ADSB_SETTINGS = {
  enabled: 'adsbMatchEnabled',
  feed: 'adsbFeed',
  token: 'adsb_api_token',
} as const;

export interface AdsbMatchDeps {
  getGlobalSetting(key: string): Promise<string | null>;
  getSourceType(sourceId: string): Promise<string | null>;
  /** Fresh DB read. */
  getNode(nodeNum: number, sourceId: string): Promise<DbNode | null>;
  /** In-memory node cache — the cheap likelyAircraft pre-check. */
  getCachedNode(nodeNum: number, sourceId: string): DbNode | undefined;
  getMatch(sourceId: string, nodeNum: number): Promise<AircraftFlightMatchRow | null>;
  startEpisode(sourceId: string, nodeNum: number, episodeStartedAt: number): Promise<void>;
  recordLookup(sourceId: string, nodeNum: number, write: FlightMatchLookupWrite): Promise<boolean>;
  fetchAircraft(feed: AdsbFeedInfo, lat: number, lon: number, nm: number, token: string | null): Promise<AdsbAircraft[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

function defaultDeps(): AdsbMatchDeps {
  return {
    getGlobalSetting: (key) => databaseService.settings.getSetting(key),
    getSourceType: async (sourceId) => (await databaseService.sources.getSource(sourceId))?.type ?? null,
    getNode: (nodeNum, sourceId) => databaseService.nodes.getNode(nodeNum, sourceId),
    getCachedNode: (nodeNum, sourceId) => databaseService.nodeCache.get(nodeNum, sourceId),
    getMatch: (sourceId, nodeNum) => databaseService.getAircraftFlightMatchAsync(sourceId, nodeNum),
    startEpisode: (sourceId, nodeNum, at) => databaseService.startAircraftFlightMatchEpisodeAsync(sourceId, nodeNum, at),
    recordLookup: (sourceId, nodeNum, write) =>
      databaseService.recordAircraftFlightMatchLookupAsync(sourceId, nodeNum, write),
    fetchAircraft: (feed, lat, lon, nm, token) => fetchAircraftNear(feed, lat, lon, nm, { token }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

interface LookupJob {
  sourceId: string;
  nodeNum: number;
  episodeStartedAt: number;
  lookupsBefore: 0 | 1;
  /** Lookup 2 only: the hex lookup 1 found (null when it found nothing). */
  previousHex: string | null;
}

interface ReuseEntry {
  at: number;
  promise: Promise<AdsbAircraft[]>;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export class AdsbMatchService {
  private readonly deps: AdsbMatchDeps;
  private backoffUntil = 0;
  private lastRequestAt = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly inFlight = new Set<string>();
  private readonly lastFailureAt = new Map<string, number>();
  private readonly reuse = new Map<string, ReuseEntry>();
  private readonly running = new Set<Promise<void>>();

  constructor(deps?: Partial<AdsbMatchDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // ---------------------------------------------------------------- hooks

  /**
   * The Phase 1 live transition into likely-aircraft. Opens a new flagging
   * (unless this transition is already recorded) and runs lookup 1.
   * Fire-and-forget; never throws.
   */
  onAircraftTransition(sourceId: string | undefined, nodeNum: number, transitionAt: number): void {
    if (!sourceId) return;
    this.track(this.handleTransition(sourceId, nodeNum, transitionAt));
  }

  /**
   * A LIVE position (the caller has already applied `isLiveReception`). Runs
   * lookup 2 when the flagging is due for one. Fire-and-forget; never throws.
   */
  onLivePosition(sourceId: string, nodeNum: number): void {
    try {
      // Cheap in-memory gate: only flagged nodes ever reach the DB.
      if (this.deps.getCachedNode(nodeNum, sourceId)?.likelyAircraft !== true) return;
      if (this.inFlight.has(this.key(sourceId, nodeNum))) return;
    } catch {
      return;
    }
    this.track(this.handleLivePosition(sourceId, nodeNum));
  }

  // ------------------------------------------------------------ internals

  private key(sourceId: string, nodeNum: number): string {
    return `${sourceId}:${nodeNum}`;
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch((err) => logger.debug(`ADS-B match: ${err}`)).finally(() => this.running.delete(wrapped));
    this.running.add(wrapped);
  }

  private async isActive(sourceId: string): Promise<boolean> {
    if ((await this.deps.getGlobalSetting(ADSB_SETTINGS.enabled)) !== 'true') return false;
    const type = await this.deps.getSourceType(sourceId);
    return !(type && AIRCRAFT_EXCLUDED_SOURCE_TYPES.has(type));
  }

  private async handleTransition(sourceId: string, nodeNum: number, transitionAt: number): Promise<void> {
    if (!(await this.isActive(sourceId))) return;
    const row = await this.deps.getMatch(sourceId, nodeNum);
    if (row && row.episodeStartedAt >= transitionAt) {
      // This transition (or a newer one) is already recorded; lookup 1 ran or is running.
      if (row.lookups > 0) return;
    } else {
      await this.deps.startEpisode(sourceId, nodeNum, transitionAt);
    }
    await this.runLookup({ sourceId, nodeNum, episodeStartedAt: transitionAt, lookupsBefore: 0, previousHex: null });
  }

  private async handleLivePosition(sourceId: string, nodeNum: number): Promise<void> {
    if (!(await this.isActive(sourceId))) return;
    const row = await this.deps.getMatch(sourceId, nodeNum);
    if (!row || row.lookups !== 1 || row.status === 'matched' || row.firstLookupAt == null) return;
    const sinceFirst = this.deps.now() - row.firstLookupAt;
    if (sinceFirst < SECOND_LOOKUP_MIN_MS || sinceFirst > SECOND_LOOKUP_MAX_MS) return;
    await this.runLookup({
      sourceId,
      nodeNum,
      episodeStartedAt: row.episodeStartedAt,
      lookupsBefore: 1,
      previousHex: row.status === 'possible' ? row.hex : null,
    });
  }

  private async runLookup(job: LookupJob): Promise<void> {
    const key = this.key(job.sourceId, job.nodeNum);
    if (this.inFlight.has(key)) return;
    const lastFail = this.lastFailureAt.get(key);
    if (lastFail != null && this.deps.now() - lastFail < RETRY_FLOOR_MS) return;
    if (this.deps.now() < this.backoffUntil) return;

    this.inFlight.add(key);
    try {
      const node = await this.deps.getNode(job.nodeNum, job.sourceId);
      if (!node) return;
      const eff = getEffectiveDbNodePosition(node);
      const lat = eff.latitude;
      const lon = eff.longitude;
      const alt = eff.altitude;
      if (!finite(lat) || !finite(lon) || !finite(alt)) return;
      if (isBogusPosition(lat, lon, node.positionPrecisionBits)) return;

      const feedSetting = await this.deps.getGlobalSetting(ADSB_SETTINGS.feed);
      const feed = resolveAdsbFeed(feedSetting);
      const token = await this.deps.getGlobalSetting(ADSB_SETTINGS.token);
      const posTs = node.positionTimestamp ?? null;

      let aircraft: AdsbAircraft[];
      try {
        aircraft = await this.getAircraft(feed, job.nodeNum, lat, lon, posTs, token);
      } catch (err) {
        this.lastFailureAt.set(key, this.deps.now());
        if (err instanceof AdsbFeedError && err.backoff) this.enterBackoff(err.message);
        else logger.debug(`ADS-B lookup for ${key} failed: ${err instanceof Error ? err.message : err}`);
        return; // not counted
      }
      this.lastFailureAt.delete(key);

      const now = this.deps.now();
      const match = matchAircraft({ latitude: lat, longitude: lon, altitudeM: alt, positionTimestampMs: posTs, nowMs: now }, aircraft);

      const write: FlightMatchLookupWrite = {
        episodeStartedAt: job.episodeStartedAt,
        lookupsBefore: job.lookupsBefore,
      };
      if (job.lookupsBefore === 0) write.firstLookupAt = now;

      const fields = (status: FlightMatchResultWrite['status']): FlightMatchResultWrite => ({
        status,
        feed: feed.id,
        hex: match?.hex ?? null,
        callsign: match?.callsign ?? null,
        aircraftType: match?.type ?? null,
        registration: match?.registration ?? null,
        gsKt: match?.gsKt ?? null,
        trackDeg: match?.trackDeg ?? null,
        altM: match?.altM ?? null,
        distanceKm: match?.distanceKm ?? null,
        matchedAt: now,
      });

      if (job.lookupsBefore === 0) {
        write.result = fields(match ? 'possible' : 'none');
      } else if (match) {
        write.result = fields(match.hex === job.previousHex ? 'matched' : 'possible');
      }
      // Lookup 2 with no hit: spend it, keep the previous status and fields.

      const written = await this.deps.recordLookup(job.sourceId, job.nodeNum, write);
      if (written) {
        logger.debug(
          `ADS-B lookup ${job.lookupsBefore + 1} for ${key}: ${write.result?.status ?? 'no hit'}` +
            (match ? ` (${match.callsign ?? match.hex}, ${match.distanceKm.toFixed(1)} km)` : ''),
        );
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * The aircraft near a spot, shared across sources: the same node at the
   * same rounded spot in the same minute reuses one response for 60 s.
   */
  private getAircraft(
    feed: AdsbFeedInfo,
    nodeNum: number,
    lat: number,
    lon: number,
    positionTimestampMs: number | null,
    token: string | null,
  ): Promise<AdsbAircraft[]> {
    const now = this.deps.now();
    for (const [k, entry] of this.reuse) {
      if (now - entry.at > REUSE_TTL_MS) this.reuse.delete(k);
    }
    const reuseKey = `${feed.id}:${nodeNum}:${lat.toFixed(3)}:${lon.toFixed(3)}:${Math.floor(now / 60_000)}`;
    const cached = this.reuse.get(reuseKey);
    if (cached) return cached.promise;

    const nm = radiusToNm(searchRadiusKm(positionTimestampMs, now));
    const promise = this.enqueue(() => this.deps.fetchAircraft(feed, lat, lon, nm, token));
    this.reuse.set(reuseKey, { at: now, promise });
    // A failure must not be reused: the next attempt should really retry.
    promise.catch(() => {
      if (this.reuse.get(reuseKey)?.promise === promise) this.reuse.delete(reuseKey);
    });
    return promise;
  }

  /** Serialize requests globally, ≥ LOOKUP_SPACING_MS apart; re-check the backoff at the head of the queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= MAX_QUEUED) {
      return Promise.reject(new AdsbFeedError('ADS-B lookup queue full', 'network', null, false));
    }
    this.queued++;
    const run = this.queueTail.then(async () => {
      const wait = this.lastRequestAt + LOOKUP_SPACING_MS - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      if (this.deps.now() < this.backoffUntil) {
        throw new AdsbFeedError('ADS-B feed backoff active', 'network', null, false);
      }
      this.lastRequestAt = this.deps.now();
      return fn();
    });
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.queued--;
    });
    return run;
  }

  private enterBackoff(reason: string): void {
    const now = this.deps.now();
    const already = now < this.backoffUntil;
    this.backoffUntil = now + FEED_BACKOFF_MS;
    if (!already) logger.warn(`ADS-B flight matching: ${reason}; pausing lookups for 10 minutes`);
  }

  // ------------------------------------------------------------ test hooks

  /** Awaits every lookup started so far (including ones they start). */
  async idleForTest(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  isBackingOffForTest(): boolean {
    return this.deps.now() < this.backoffUntil;
  }
}

export const adsbMatchService = new AdsbMatchService();

let started = false;

/** Subscribe to the Phase 1 transition event. Idempotent. */
export function startAdsbFlightMatching(): void {
  if (started) return;
  started = true;
  dataEventEmitter.on('data', (event: DataEvent) => {
    if (event.type !== 'node:aircraft') return;
    const data = event.data as NodeAircraftData;
    adsbMatchService.onAircraftTransition(event.sourceId, data.nodeNum, event.timestamp);
  });
  logger.debug('[ADS-B] flight matching subscribed to likely-aircraft transitions');
}
