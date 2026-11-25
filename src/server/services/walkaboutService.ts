/**
 * Walkabout Coverage service (#5891 Phase 1). Spec §2.5.
 * Owns the live per-source GPS fix map and the session lifecycle.
 *
 * Mesh impact: none. Receive-only bookkeeping; sends nothing, emits nothing
 * on `dataEventEmitter`, runs no timer (the 2 h cap is computed from the
 * stored `startedAt` on every entry point, so a restart or a save never
 * re-arms it).
 */
import { randomUUID } from 'node:crypto';
import { Ed25519SignatureVerifier } from '@michaelhart/meshcore-decoder';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import type { DbWalkaboutSession, NewWalkaboutReception } from '../../db/repositories/coverageWalkabout.js';
import type { DecodedAdvert } from '../../utils/meshcorePacketDecode.js';
import type { LastHopCandidate } from '../utils/lastHop.js';
import { evaluateWalkaboutMeshtastic, evaluateWalkaboutMeshCore, type WalkaboutSkip, type WalkaboutCredit } from '../utils/walkaboutCredit.js';
import { isMeshCoreManager, isMeshtasticManager } from '../sourceManagerTypes.js';
import {
  WALKABOUT_CLOCK_RESET_MS,
  WALKABOUT_MAX_ACCURACY_M,
  WALKABOUT_MAX_DURATION_MS,
  WALKABOUT_MAX_SAMPLE_AGE_MS,
  WALKABOUT_MIN_SAMPLE_SPACING_MS,
  WALKABOUT_NAME_MAX,
  WALKABOUT_SAMPLE_FRESH_MS,
  isWalkaboutLive,
  walkaboutEndsAt,
} from '../../utils/walkabout.js';
import type { WalkaboutSessionDto } from '../../types/walkabout.js';
import type { MeshtasticDirectRfPacket } from './directRfContactRecorder.js';
import type {
  WalkaboutSampleInput,
  WalkaboutSampleResult,
  WalkaboutSkipCounts,
} from '../../types/walkabout.js';

export interface WalkaboutMeshtasticInput {
  sourceId: string;
  localNodeNum: number | null;
  packet: MeshtasticDirectRfPacket & { relayNode?: number | null };
  /** Store & Forward replay or virtual-node-originated packet. */
  replayed: boolean;
}

export interface WalkaboutMeshCoreInput {
  sourceId: string;
  localPubKey: string | null;
  event: { raw_hex?: string | null; snr?: number | null; rssi?: number | null };
}

export type WalkaboutErrorCode =
  | 'WALKABOUT_ALREADY_LIVE'
  | 'WALKABOUT_NOT_LIVE'
  | 'WALKABOUT_NOT_OWNER'
  | 'WALKABOUT_SOURCE_UNSUPPORTED'
  | 'WALKABOUT_NOT_FOUND';

export class WalkaboutError extends Error {
  code: WalkaboutErrorCode;
  extra?: Record<string, unknown>;
  constructor(code: WalkaboutErrorCode, message?: string, extra?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'WalkaboutError';
    this.code = code;
    this.extra = extra;
  }
}


const CANDIDATE_TTL_MS = 60_000;
const MESHTASTIC_CANDIDATE_WINDOW_SEC = 24 * 3600;
const MESHCORE_ADV_REPEATER = 2;
const MESHCORE_ADV_ROOM = 3;

interface LiveSession {
  /** Empty while a start is claiming the source (before the DB insert returns). */
  id: string;
  pending: boolean;
  /** A stop or delete is in flight: capture and posts stop, the entry leaves the map on success. */
  closing?: boolean;
  sourceId: string;
  startedAt: number;
  startedBy: number | null;
  latest: { id: number; latitude: number; longitude: number; accuracyM: number; fixAt: number } | null;
  lastDeviceFixAt: number | null;
  skipped: WalkaboutSkipCounts;
}

interface CandidateCache {
  at: number;
  mtNodes: LastHopCandidate[];
  mcKnown: string[];
  mcRelay: string[];
}

const emptySkips = (): WalkaboutSkipCounts => ({ noFix: 0, relayAmbiguous: 0, relayUnknown: 0, noSender: 0 });

/** DTO for a session row plus counts. `startedByMe` never exposes the user id. */
export function toWalkaboutSessionDto(
  row: DbWalkaboutSession,
  counts: { samples: number; receptions: number; nodes: number; lastSampleAt: number | null },
  userId: number | null,
  nowMs: number = Date.now(),
): WalkaboutSessionDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    name: row.name,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endsAt: walkaboutEndsAt(row),
    isLive: isWalkaboutLive(row, nowMs),
    endReason: row.endReason,
    startedByMe: userId != null && row.startedBy === userId,
    sampleCount: counts.samples,
    receptionCount: counts.receptions,
    nodeCount: counts.nodes,
    lastSampleAt: counts.lastSampleAt,
  };
}

export class WalkaboutService {
  private live = new Map<string, LiveSession>(); // key: sourceId (one open session per source)
  private candidates = new Map<string, CandidateCache>();
  private candidateLoads = new Map<string, Promise<CandidateCache | null>>();
  private resolveReady!: () => void;
  private ready: Promise<void> = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  private get repo() {
    return databaseService.coverageWalkabout;
  }

  /** Resolves `ready`, success or failure. Safe to call twice. */
  async init(nowMs: number = Date.now()): Promise<void> {
    try {
      const open = await this.repo.getOpenSessionsAllSources();
      for (const row of open) {
        // One bad row must not leave the later sessions unloaded.
        try {
          if (!isWalkaboutLive(row, nowMs)) {
            // End at startedAt + cap, never "now": a restart is not a trigger.
            await this.repo.endSession(row.sourceId, row.id, row.startedAt + WALKABOUT_MAX_DURATION_MS, 'cap');
            continue;
          }
          await this.adopt(row);
        } catch (err) {
          logger.error(`[Walkabout] init could not load session ${row.id} (retried lazily on first use):`, err);
        }
      }
    } catch (err) {
      logger.error('[Walkabout] init failed (lifecycle continues with an empty live map):', err);
    } finally {
      this.resolveReady();
    }
  }

  /** Put a DB-open, in-cap session into the map (once). Returns the map entry. */
  private async adopt(row: DbWalkaboutSession): Promise<LiveSession | null> {
    const existing = this.live.get(row.sourceId);
    if (existing) return existing.id === row.id && !existing.pending ? existing : null;
    const latest = await this.repo.getLatestSample(row.sourceId, row.id);
    const again = this.live.get(row.sourceId);
    if (again) return again.id === row.id && !again.pending ? again : null;
    const entry: LiveSession = {
      id: row.id, pending: false, sourceId: row.sourceId, startedAt: row.startedAt, startedBy: row.startedBy,
      latest: latest
        ? { id: latest.id, latitude: latest.latitude, longitude: latest.longitude, accuracyM: latest.accuracyM, fixAt: latest.fixAt }
        : null,
      lastDeviceFixAt: latest ? latest.deviceFixAt : null,
      skipped: emptySkips(),
    };
    this.live.set(row.sourceId, entry);
    return entry;
  }

  /**
   * Make sure a DB-open session of this source is in the live map (a failed or partial
   * `init()` can leave it out). Ends one past its cap. Returns the open row, if any.
   */
  async ensureLoaded(sourceId: string, nowMs: number = Date.now()): Promise<DbWalkaboutSession | null> {
    await this.ready;
    const cur = this.live.get(sourceId);
    if (cur && !cur.pending) return this.repo.getSession(sourceId, cur.id);
    if (cur) return null;
    const open = await this.repo.getOpenSession(sourceId);
    if (!open) return null;
    if (!isWalkaboutLive(open, nowMs)) {
      await this.endForCap(open);
      return null;
    }
    await this.adopt(open);
    return open;
  }

  /** End a session past its cap at startedAt + cap; drops it from the map. Never throws. */
  private endForCap(s: { sourceId: string; id: string; startedAt: number }): Promise<void> {
    const cur = this.live.get(s.sourceId);
    if (cur && cur.id === s.id) this.live.delete(s.sourceId);
    return Promise.resolve()
      .then(() => this.repo.endSession(s.sourceId, s.id, s.startedAt + WALKABOUT_MAX_DURATION_MS, 'cap'))
      .then(() => undefined)
      .catch((err) => logger.debug('[Walkabout] ending a capped session failed:', err));
  }

  async startSession(sourceId: string, userId: number | null, name: string | null, nowMs: number = Date.now()): Promise<DbWalkaboutSession> {
    await this.ready;
    const { sourceManagerRegistry } = await import('../sourceManagerRegistry.js');
    const mgr = sourceManagerRegistry.getManager(sourceId);
    if (!mgr || !(isMeshtasticManager(mgr) || isMeshCoreManager(mgr))) {
      throw new WalkaboutError('WALKABOUT_SOURCE_UNSUPPORTED', 'Walkabout needs a Meshtastic or MeshCore radio source');
    }
    const trimmed = name == null ? null : name.trim().slice(0, WALKABOUT_NAME_MAX);
    const cleanName = trimmed ? trimmed : null;

    // Cap check, then claim. No `await` between the map read and the claim.
    const cur = this.live.get(sourceId);
    let capEnd: Promise<void> | null = null;
    if (cur) {
      if (cur.pending || isWalkaboutLive({ startedAt: cur.startedAt, endedAt: null }, nowMs)) {
        throw new WalkaboutError('WALKABOUT_ALREADY_LIVE', undefined, cur.pending ? undefined : { sessionId: cur.id });
      }
      capEnd = this.endForCap(cur);
    }
    const claim: LiveSession = {
      id: '', pending: true, sourceId, startedAt: nowMs, startedBy: userId,
      latest: null, lastDeviceFixAt: null, skipped: emptySkips(),
    };
    this.live.set(sourceId, claim);
    const release = () => { if (this.live.get(sourceId) === claim) this.live.delete(sourceId); };
    try {
      if (capEnd) await capEnd;
      const open = await this.repo.getOpenSession(sourceId);
      if (open) {
        if (isWalkaboutLive(open, nowMs)) {
          release();
          await this.adopt(open).catch(() => null);
          throw new WalkaboutError('WALKABOUT_ALREADY_LIVE', undefined, { sessionId: open.id });
        }
        await this.endForCap(open);
      }
      const row = await this.repo.createSession({ id: randomUUID(), sourceId, name: cleanName, startedAt: nowMs, startedBy: userId });
      if (this.live.get(sourceId) !== claim) {
        // The source was forgotten while the insert was pending: leave nothing behind.
        await Promise.resolve(this.repo.deleteSession(sourceId, row.id)).catch(() => false);
        throw new WalkaboutError('WALKABOUT_SOURCE_UNSUPPORTED', 'The source was removed while the session started');
      }
      this.live.set(sourceId, {
        id: row.id, pending: false, sourceId, startedAt: row.startedAt, startedBy: row.startedBy,
        latest: null, lastDeviceFixAt: null, skipped: emptySkips(),
      });
      return row;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Idempotent: an already-ended session is returned as is. Null when it does not exist. */
  async stopSession(sourceId: string, sessionId: string, nowMs: number = Date.now()): Promise<DbWalkaboutSession | null> {
    await this.ready;
    const cur = this.live.get(sourceId);
    const mine = cur && !cur.pending && cur.id === sessionId ? cur : null;
    if (mine) mine.closing = true; // capture stops now; the entry leaves only once the row is ended
    try {
      const row = await this.repo.getSession(sourceId, sessionId);
      if (!row) {
        if (mine && this.live.get(sourceId) === mine) this.live.delete(sourceId);
        return null;
      }
      if (row.endedAt == null) {
        if (!isWalkaboutLive(row, nowMs)) {
          await this.repo.endSession(sourceId, sessionId, row.startedAt + WALKABOUT_MAX_DURATION_MS, 'cap');
        } else {
          await this.repo.endSession(sourceId, sessionId, nowMs, 'user');
        }
      }
      if (mine && this.live.get(sourceId) === mine) this.live.delete(sourceId);
      if (row.endedAt != null) return row;
      return (await this.repo.getSession(sourceId, sessionId)) ?? row;
    } catch (err) {
      if (mine) mine.closing = false;
      throw err;
    }
  }

  async addSamples(sourceId: string, sessionId: string, userId: number | null, samples: WalkaboutSampleInput[], nowMs: number = Date.now()): Promise<WalkaboutSampleResult> {
    await this.ready;
    let cur = this.live.get(sourceId);
    if (!cur) {
      // Not in the map: a DB-open session may have been missed by init(); load it lazily.
      const row = await this.repo.getSession(sourceId, sessionId);
      if (!row) throw new WalkaboutError('WALKABOUT_NOT_FOUND');
      if (row.endedAt != null) throw new WalkaboutError('WALKABOUT_NOT_LIVE');
      if (!isWalkaboutLive(row, nowMs)) {
        await this.endForCap(row);
        throw new WalkaboutError('WALKABOUT_NOT_LIVE');
      }
      cur = (await this.adopt(row)) ?? undefined;
    }
    if (!cur || cur.pending || cur.closing || cur.id !== sessionId) {
      const row = await this.repo.getSession(sourceId, sessionId);
      if (!row) throw new WalkaboutError('WALKABOUT_NOT_FOUND');
      throw new WalkaboutError('WALKABOUT_NOT_LIVE');
    }
    if (!isWalkaboutLive({ startedAt: cur.startedAt, endedAt: null }, nowMs)) {
      await this.endForCap(cur);
      throw new WalkaboutError('WALKABOUT_NOT_LIVE');
    }
    if (cur.startedBy == null || userId == null || cur.startedBy !== userId) throw new WalkaboutError('WALKABOUT_NOT_OWNER');

    const dropped = { accuracy: 0, spacing: 0, stale: 0, invalid: 0 };
    let accepted = 0;
    const ordered = [...samples].sort((a, b) => Number(a?.deviceFixAt) - Number(b?.deviceFixAt));
    for (const smp of ordered) {
      const lat = smp?.latitude, lon = smp?.longitude, acc = smp?.accuracyM;
      const dev = smp?.deviceFixAt, age = smp?.ageMs;
      if (
        !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lon) || lon < -180 || lon > 180 ||
        (lat === 0 && lon === 0) ||
        !Number.isFinite(acc) || acc < 0 ||
        !Number.isFinite(dev) || !Number.isFinite(age)
      ) { dropped.invalid++; continue; }
      if (acc > WALKABOUT_MAX_ACCURACY_M) { dropped.accuracy++; continue; }
      const ageMs = Math.max(0, age);
      if (ageMs > WALKABOUT_MAX_SAMPLE_AGE_MS) { dropped.stale++; continue; }
      const prevDev = cur.lastDeviceFixAt;
      if (prevDev != null) {
        const d = dev - prevDev;
        if (d >= 0 && d < WALKABOUT_MIN_SAMPLE_SPACING_MS) { dropped.spacing++; continue; }
        if (d < 0 && d > -WALKABOUT_CLOCK_RESET_MS) { dropped.spacing++; continue; }
        // d <= -60 s: the phone clock was reset; accept and rebase.
      }
      // A stop, delete or cap during an earlier insert ends this post. One row already
      // in flight when `closing` is set can still land just after endedAt. Accepted:
      // it is bounded to that one row, and P2 reads clip the track to [startedAt, endedAt].
      if (this.live.get(sourceId) !== cur || cur.closing) throw new WalkaboutError('WALKABOUT_NOT_LIVE');
      cur.lastDeviceFixAt = dev; // before the await, so a concurrent post sees it
      try {
        const row = await this.repo.insertSample({
          sessionId, sourceId, latitude: lat, longitude: lon, accuracyM: acc,
          deviceFixAt: dev, fixAt: nowMs - ageMs, receivedAt: nowMs,
        });
        if (!cur.latest || row.fixAt > cur.latest.fixAt) {
          cur.latest = { id: row.id, latitude: row.latitude, longitude: row.longitude, accuracyM: row.accuracyM, fixAt: row.fixAt };
        }
        accepted++;
      } catch (err) {
        cur.lastDeviceFixAt = prevDev;
        throw err;
      }
    }
    const [counts, row] = await Promise.all([this.repo.getCounts(sourceId, sessionId), this.repo.getSession(sourceId, sessionId)]);
    if (!row) throw new WalkaboutError('WALKABOUT_NOT_FOUND');
    return { accepted, dropped, session: toWalkaboutSessionDto(row, counts, userId, nowMs), skipped: { ...cur.skipped } };
  }

  async deleteSession(sourceId: string, sessionId: string): Promise<boolean> {
    await this.ready;
    const cur = this.live.get(sourceId);
    const mine = cur && !cur.pending && cur.id === sessionId ? cur : null;
    if (mine) mine.closing = true; // capture stops before the rows go
    try {
      const ok = await this.repo.deleteSession(sourceId, sessionId);
      if (mine && this.live.get(sourceId) === mine) this.live.delete(sourceId);
      return ok;
    } catch (err) {
      if (mine) mine.closing = false;
      throw err;
    }
  }

  forgetSource(sourceId: string): void {
    this.live.delete(sourceId);
    this.candidates.delete(sourceId);
    this.candidateLoads.delete(sourceId);
  }

  getSkipped(sourceId: string, sessionId: string): WalkaboutSkipCounts | null {
    const cur = this.live.get(sourceId);
    return cur && !cur.pending && cur.id === sessionId ? { ...cur.skipped } : null;
  }

  // -------------------------------------------------------------------------
  // Capture (RX path: synchronous, never throws, no await by the caller)
  // -------------------------------------------------------------------------

  /** Sync; never throws; never awaited on the RX path. */
  maybeCaptureMeshtastic(input: WalkaboutMeshtasticInput): void {
    const s = this.live.get(input.sourceId);
    if (!s || s.pending || s.closing) return;
    try {
      const now = Date.now();
      if (this.capped(s, now)) return;
      const cached = this.freshCandidates(input.sourceId, now);
      const run = (cands: LastHopCandidate[]) => evaluateWalkaboutMeshtastic({
        localNodeNum: input.localNodeNum, packet: input.packet, replayed: input.replayed, nowMs: now, candidates: cands,
      });
      const r = run(cached?.mtNodes ?? []);
      if (this.uncountable(r.skip) || !this.hasFreshFix(s, now)) return;
      if (r.skip === 'relay-unknown' && !cached) {
        // Candidates are loaded lazily by the first packet that needs them.
        void this.loadCandidates(input.sourceId, 'meshtastic', now)
          .then((c) => { if (c) this.finish(s, run(c.mtNodes), now); })
          .catch((err) => logger.debug('[Walkabout] candidate load failed:', err));
        return;
      }
      this.finish(s, r, now);
    } catch (err) {
      logger.debug('[Walkabout] Meshtastic capture failed (non-fatal):', err);
    }
  }

  /** Sync; never throws; never awaited on the RX path. */
  maybeCaptureMeshCore(input: WalkaboutMeshCoreInput): void {
    const s = this.live.get(input.sourceId);
    if (!s || s.pending || s.closing) return;
    try {
      const now = Date.now();
      if (this.capped(s, now)) return;
      const local = input.localPubKey ? input.localPubKey.toLowerCase() : null;
      const cached = this.freshCandidates(input.sourceId, now);
      const run = (c: CandidateCache | null) => evaluateWalkaboutMeshCore({
        localPubKey: local, event: input.event,
        knownKeys: (c?.mcKnown ?? []).filter((k) => k !== local),
        relayKeys: (c?.mcRelay ?? []).filter((k) => k !== local),
      });
      const r = run(cached);
      if (this.uncountable(r.skip) || !this.hasFreshFix(s, now)) return;
      if (r.skip === 'relay-unknown' && !cached) {
        void this.loadCandidates(input.sourceId, 'meshcore', now)
          .then((c) => { if (c) this.finish(s, run(c), now); })
          .catch((err) => logger.debug('[Walkabout] candidate load failed:', err));
        return;
      }
      this.finish(s, r, now);
    } catch (err) {
      logger.debug('[Walkabout] MeshCore capture failed (non-fatal):', err);
    }
  }

  /** Past the cap: end the session (fire-and-forget) and tell the caller to stop. */
  private capped(s: LiveSession, now: number): boolean {
    if (isWalkaboutLive({ startedAt: s.startedAt, endedAt: null }, now)) return false;
    void this.endForCap(s);
    return true;
  }

  /** Skips that no fix could change (own, MQTT, replay, non-RF, bad frame): not counted as "no fix". */
  private uncountable(skip: WalkaboutSkip | null): boolean {
    return skip === 'no-local-node' || skip === 'replayed' || skip === 'own-packet' || skip === 'via-mqtt'
      || skip === 'not-rf' || skip === 'no-packet-id' || skip === 'not-live' || skip === 'nodedb-replay'
      || skip === 'unknown-hops' || skip === 'decode-failed' || skip === 'own-advert';
  }

  /** A fix within the freshness bound; counts `noFix` otherwise. */
  private hasFreshFix(s: LiveSession, now: number): boolean {
    if (s.latest && now - s.latest.fixAt <= WALKABOUT_SAMPLE_FRESH_MS) return true;
    s.skipped.noFix++;
    return false;
  }

  private freshCandidates(sourceId: string, now: number): CandidateCache | null {
    const c = this.candidates.get(sourceId);
    return c && now - c.at < CANDIDATE_TTL_MS ? c : null;
  }

  private loadCandidates(sourceId: string, protocol: 'meshtastic' | 'meshcore', now: number): Promise<CandidateCache | null> {
    const inflight = this.candidateLoads.get(sourceId);
    if (inflight) return inflight;
    const p = (async (): Promise<CandidateCache | null> => {
      const prev = this.candidates.get(sourceId);
      const next: CandidateCache = { at: now, mtNodes: prev?.mtNodes ?? [], mcKnown: prev?.mcKnown ?? [], mcRelay: prev?.mcRelay ?? [] };
      if (protocol === 'meshtastic') {
        const nodes = await databaseService.nodes.getAllNodes(sourceId);
        const cutoff = now / 1000 - MESHTASTIC_CANDIDATE_WINDOW_SEC;
        next.mtNodes = nodes
          .filter((n) => n.lastHeard != null && Number(n.lastHeard) >= cutoff)
          .map((n) => ({ nodeNum: Number(n.nodeNum), shortName: n.shortName, role: n.role, hopsAway: n.hopsAway, lastHeard: n.lastHeard == null ? null : Number(n.lastHeard) }));
      } else {
        const nodes = await databaseService.meshcore.getNodesBySource(sourceId);
        next.mcKnown = nodes.map((n) => n.publicKey.toLowerCase());
        next.mcRelay = nodes.filter((n) => n.advType === MESHCORE_ADV_REPEATER || n.advType === MESHCORE_ADV_ROOM).map((n) => n.publicKey.toLowerCase());
      }
      if (this.live.has(sourceId)) this.candidates.set(sourceId, next);
      return next;
    })().finally(() => { this.candidateLoads.delete(sourceId); });
    this.candidateLoads.set(sourceId, p);
    return p;
  }

  private finish(
    s: LiveSession,
    r: { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit; verifyAdvert?: DecodedAdvert },
    now: number,
  ): void {
    if (r.skip !== null) {
      switch (r.skip) {
        case 'relay-ambiguous': case 'direct-route-ambiguous': s.skipped.relayAmbiguous++; break;
        case 'relay-unknown': case 'relay-none': s.skipped.relayUnknown++; break;
        case 'no-sender': s.skipped.noSender++; break;
        default: break;
      }
      return;
    }
    const sample = s.latest;
    if (!sample) return;
    const { credit } = r;
    const write = () => {
      if (this.live.get(s.sourceId) !== s) return; // ended or deleted meanwhile
      const row: NewWalkaboutReception = {
        sessionId: s.id, sourceId: s.sourceId, protocol: credit.protocol,
        creditedKey: credit.creditedKey, creditedNodeNum: credit.creditedNodeNum, creditKind: credit.creditKind,
        hopsAway: credit.hopsAway, packetKey: credit.packetKey, snr: credit.snr, rssi: credit.rssi,
        heardAt: now, sampleId: sample.id, latitude: sample.latitude, longitude: sample.longitude,
        accuracyM: sample.accuracyM, sampleAgeMs: now - sample.fixAt,
      };
      try {
        void this.repo.recordReception(row).catch((err) => logger.debug('[Walkabout] recordReception failed:', err));
      } catch (err) {
        logger.debug('[Walkabout] recordReception failed:', err);
      }
    };
    const advert = r.verifyAdvert;
    if (!advert) { write(); return; }
    void Promise.resolve()
      .then(() => Ed25519SignatureVerifier.verifyAdvertisementSignature(advert.publicKey, advert.signature, advert.timestamp, advert.appDataHex ?? ''))
      .catch(() => false)
      .then((ok) => { if (ok) write(); });
  }
}

export const walkaboutService = new WalkaboutService();
