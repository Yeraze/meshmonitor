/**
 * Repository for the Walkabout Coverage tables (epic #5891, Phase 1).
 * Spec: WALKABOUT_P1_SPEC.md §2.3.
 *
 * Every method takes `sourceId` and scopes with `withSourceScope`, except
 * `getOpenSessionsAllSources` (boot loader: cross-source by design).
 */
import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNotNull, isNull, lte, max, or, type SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { WALKABOUT_LIST_LIMIT, WALKABOUT_MAX_DURATION_MS, type WalkaboutEndReason } from '../../utils/walkabout.js';

export interface DbWalkaboutSession {
  id: string;
  sourceId: string;
  name: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: WalkaboutEndReason | null;
  /** users.id; never sent to the client. */
  startedBy: number | null;
  createdAt: number;
  updatedAt: number;
  /** Set when a walkabout import created the session (#6573); null/absent = recorded live. */
  importId?: string | null;
}

export interface DbWalkaboutSessionWithCounts extends DbWalkaboutSession {
  sampleCount: number;
  receptionCount: number;
  /** Distinct credited keys. */
  nodeCount: number;
  lastSampleAt: number | null;
}

export interface DbWalkaboutSample {
  id: number;
  sessionId: string;
  sourceId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** Phone clock; spacing only. */
  deviceFixAt: number;
  /** Server clock: receivedAt - ageMs; freshness only. */
  fixAt: number;
  receivedAt: number;
}

export type NewWalkaboutSample = Omit<DbWalkaboutSample, 'id'>;

export interface DbWalkaboutReception {
  id: number;
  sessionId: string;
  sourceId: string;
  protocol: 'meshtastic' | 'meshcore';
  creditedKey: string;
  creditedNodeNum: number | null;
  creditKind: 'direct' | 'relay';
  hopsAway: number | null;
  packetKey: string;
  snr: number | null;
  rssi: number | null;
  heardAt: number;
  sampleId: number | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** heardAt - sample.fixAt. */
  sampleAgeMs: number;
}

export type NewWalkaboutReception = Omit<DbWalkaboutReception, 'id'>;

export interface WalkaboutCounts {
  samples: number;
  receptions: number;
  nodes: number;
  lastSampleAt: number | null;
}

/** Raw driver row; bigint columns may arrive as strings on PG/MySQL. */
type Row = Record<string, unknown>;

function requireSource(sourceId: string, method: string): void {
  if (!sourceId) throw new Error(`CoverageWalkaboutRepository.${method} requires a sourceId`);
}

export interface WalkaboutReceptionPoint {
  sessionId: string;
  protocol: 'meshtastic' | 'meshcore';
  creditedKey: string;
  creditedNodeNum: number | null;
  snr: number | null;
  heardAt: number;
  latitude: number;
  longitude: number;
}

export interface WalkaboutSamplePoint {
  sessionId: string;
  fixAt: number;
  latitude: number;
  longitude: number;
}

export interface WalkaboutBBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

export class CoverageWalkaboutRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Coerce bigint-capable columns (PG/MySQL may return strings) to numbers. */
  private toSession(r: Row): DbWalkaboutSession {
    return {
      id: r.id as string,
      sourceId: r.sourceId as string,
      name: (r.name as string | null) ?? null,
      startedAt: Number(r.startedAt),
      endedAt: r.endedAt == null ? null : Number(r.endedAt),
      endReason: (r.endReason ?? null) as WalkaboutEndReason | null,
      startedBy: (r.startedBy as number | null) ?? null,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
      importId: (r.importId as string | null | undefined) ?? null,
    };
  }

  private toSample(r: Row): DbWalkaboutSample {
    return {
      id: Number(r.id),
      sessionId: r.sessionId as string,
      sourceId: r.sourceId as string,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      accuracyM: Number(r.accuracyM),
      deviceFixAt: Number(r.deviceFixAt),
      fixAt: Number(r.fixAt),
      receivedAt: Number(r.receivedAt),
    };
  }

  async createSession(p: { id: string; sourceId: string; name: string | null; startedAt: number; startedBy: number | null }): Promise<DbWalkaboutSession> {
    requireSource(p.sourceId, 'createSession');
    const { coverageWalkaboutSessions: t } = this.tables;
    const row = {
      id: p.id,
      sourceId: p.sourceId,
      name: p.name,
      startedAt: p.startedAt,
      endedAt: null,
      endReason: null,
      startedBy: p.startedBy,
      createdAt: p.startedAt,
      updatedAt: p.startedAt,
      importId: null,
    };
    await this.db.insert(t).values(row);
    return this.toSession(row);
  }

  async getSession(sourceId: string, id: string): Promise<DbWalkaboutSession | null> {
    requireSource(sourceId, 'getSession');
    const { coverageWalkaboutSessions: t } = this.tables;
    const rows = await this.db.select().from(t).where(and(eq(t.id, id), this.withSourceScope(t, sourceId))).limit(1);
    return rows[0] ? this.toSession(rows[0]) : null;
  }

  /** endedAt IS NULL, newest. */
  async getOpenSession(sourceId: string): Promise<DbWalkaboutSession | null> {
    requireSource(sourceId, 'getOpenSession');
    const { coverageWalkaboutSessions: t } = this.tables;
    const rows = await this.db.select().from(t)
      .where(and(isNull(t.endedAt), this.withSourceScope(t, sourceId)))
      .orderBy(desc(t.startedAt))
      .limit(1);
    return rows[0] ? this.toSession(rows[0]) : null;
  }

  /** Newest first. */
  async listSessions(sourceId: string, limit: number = WALKABOUT_LIST_LIMIT): Promise<DbWalkaboutSessionWithCounts[]> {
    requireSource(sourceId, 'listSessions');
    const { coverageWalkaboutSessions: t, coverageWalkaboutSamples: smp, coverageWalkaboutReceptions: rx } = this.tables;
    const rows = await this.db.select().from(t)
      .where(this.withSourceScope(t, sourceId))
      .orderBy(desc(t.startedAt))
      .limit(limit);
    if (rows.length === 0) return [];
    const ids: string[] = rows.map((r: Row) => r.id as string);
    const sampleRows = await this.db
      .select({ sessionId: smp.sessionId, n: count(), last: max(smp.receivedAt) })
      .from(smp)
      .where(and(inArray(smp.sessionId, ids), this.withSourceScope(smp, sourceId)))
      .groupBy(smp.sessionId);
    const rxRows = await this.db
      .select({ sessionId: rx.sessionId, n: count(), nodes: countDistinct(rx.creditedKey) })
      .from(rx)
      .where(and(inArray(rx.sessionId, ids), this.withSourceScope(rx, sourceId)))
      .groupBy(rx.sessionId);
    const sMap = new Map<string, Row>(sampleRows.map((r: Row) => [r.sessionId as string, r]));
    const rMap = new Map<string, Row>(rxRows.map((r: Row) => [r.sessionId as string, r]));
    return rows.map((r: Row) => {
      const s = sMap.get(r.id as string);
      const x = rMap.get(r.id as string);
      return {
        ...this.toSession(r),
        sampleCount: s ? Number(s.n) : 0,
        receptionCount: x ? Number(x.n) : 0,
        nodeCount: x ? Number(x.nodes) : 0,
        lastSampleAt: s && s.last != null ? Number(s.last) : null,
      };
    });
  }

  /** Boot only. Cross-source by design (the service loads every open session at init). */
  async getOpenSessionsAllSources(): Promise<DbWalkaboutSession[]> {
    const { coverageWalkaboutSessions: t } = this.tables;
    const rows = await this.db.select().from(t).where(isNull(t.endedAt)).orderBy(desc(t.startedAt));
    return rows.map((r: Row) => this.toSession(r));
  }

  /** `WHERE endedAt IS NULL`; true when a row was ended. */
  async endSession(sourceId: string, id: string, endedAt: number, reason: WalkaboutEndReason): Promise<boolean> {
    requireSource(sourceId, 'endSession');
    const { coverageWalkaboutSessions: t } = this.tables;
    const result = await this.db.update(t)
      .set({ endedAt, endReason: reason, updatedAt: endedAt })
      .where(and(eq(t.id, id), isNull(t.endedAt), this.withSourceScope(t, sourceId)));
    return this.getAffectedRows(result) > 0;
  }

  /** Deletes receptions, samples, then the session. */
  async deleteSession(sourceId: string, id: string): Promise<boolean> {
    requireSource(sourceId, 'deleteSession');
    const { coverageWalkaboutSessions: t, coverageWalkaboutSamples: smp, coverageWalkaboutReceptions: rx } = this.tables;
    // Only touch children when the session belongs to this source.
    if (!(await this.getSession(sourceId, id))) return false;
    await this.db.delete(rx).where(and(eq(rx.sessionId, id), this.withSourceScope(rx, sourceId)));
    await this.db.delete(smp).where(and(eq(smp.sessionId, id), this.withSourceScope(smp, sourceId)));
    const result = await this.db.delete(t).where(and(eq(t.id, id), this.withSourceScope(t, sourceId)));
    return this.getAffectedRows(result) > 0;
  }

  async deleteForSource(sourceId: string): Promise<void> {
    requireSource(sourceId, 'deleteForSource');
    const { coverageWalkaboutSessions: t, coverageWalkaboutSamples: smp, coverageWalkaboutReceptions: rx } = this.tables;
    await this.db.delete(rx).where(this.withSourceScope(rx, sourceId));
    await this.db.delete(smp).where(this.withSourceScope(smp, sourceId));
    await this.db.delete(t).where(this.withSourceScope(t, sourceId));
  }

  /** Returns the row with its id (PG returning / MySQL insertId / SQLite lastInsertRowid). */
  async insertSample(row: NewWalkaboutSample): Promise<DbWalkaboutSample> {
    requireSource(row.sourceId, 'insertSample');
    const { coverageWalkaboutSamples: smp } = this.tables;
    let id: number;
    if (this.isMySQL()) {
      const res = await this.db.insert(smp).values(row);
      id = Number((Array.isArray(res) ? res[0] : res).insertId);
    } else {
      const res = await this.db.insert(smp).values(row).returning({ id: smp.id });
      id = Number(res[0].id);
    }
    return { ...row, id };
  }

  /** Newest by deviceFixAt. */
  async getLatestSample(sourceId: string, sessionId: string): Promise<DbWalkaboutSample | null> {
    requireSource(sourceId, 'getLatestSample');
    const { coverageWalkaboutSamples: smp } = this.tables;
    const rows = await this.db.select().from(smp)
      .where(and(eq(smp.sessionId, sessionId), this.withSourceScope(smp, sourceId)))
      .orderBy(desc(smp.deviceFixAt), desc(smp.id))
      .limit(1);
    return rows[0] ? this.toSample(rows[0]) : null;
  }

  /** insertIgnore + getAffectedRows > 0; false on a duplicate. */
  async recordReception(row: NewWalkaboutReception): Promise<boolean> {
    requireSource(row.sourceId, 'recordReception');
    const { coverageWalkaboutReceptions: rx } = this.tables;
    const result = await this.insertIgnore(rx, row);
    return this.getAffectedRows(result) > 0;
  }

  async getCounts(sourceId: string, sessionId: string): Promise<WalkaboutCounts> {
    requireSource(sourceId, 'getCounts');
    const { coverageWalkaboutSamples: smp, coverageWalkaboutReceptions: rx } = this.tables;
    const s = await this.db
      .select({ n: count(), last: max(smp.receivedAt) })
      .from(smp)
      .where(and(eq(smp.sessionId, sessionId), this.withSourceScope(smp, sourceId)));
    const x = await this.db
      .select({ n: count(), nodes: countDistinct(rx.creditedKey) })
      .from(rx)
      .where(and(eq(rx.sessionId, sessionId), this.withSourceScope(rx, sourceId)));
    return {
      samples: Number(s[0]?.n ?? 0),
      receptions: Number(x[0]?.n ?? 0),
      nodes: Number(x[0]?.nodes ?? 0),
      lastSampleAt: s[0]?.last != null ? Number(s[0].last) : null,
    };
  }

  /**
   * Sessions that may overlap [sinceMs, untilMs]: startedAt <= untilMs AND
   * startedAt >= sinceMs - WALKABOUT_MAX_DURATION_MS (no session outlives the
   * cap). The caller applies the exact overlap test with walkaboutEndsAt.
   * Newest first, `limit` rows.
   */
  async listSessionsInRange(
    sourceId: string,
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): Promise<DbWalkaboutSession[]> {
    requireSource(sourceId, 'listSessionsInRange');
    const { coverageWalkaboutSessions: t } = this.tables;
    const rows = await this.db.select().from(t)
      .where(and(
        lte(t.startedAt, untilMs),
        gte(t.startedAt, sinceMs - WALKABOUT_MAX_DURATION_MS),
        this.withSourceScope(t, sourceId),
      ))
      .orderBy(desc(t.startedAt))
      .limit(limit);
    return rows.map((r: Row) => this.toSession(r));
  }

  /**
   * Raw points; no clipping (the service clips per session). `limit` rows max,
   * ordered by heardAt DESC then id DESC (a cap drops old rows). Empty
   * `sessionIds` returns [] with no query.
   */
  async getReceptionPoints(
    sourceId: string,
    q: {
      sessionIds: string[];
      sinceMs: number;
      untilMs: number;
      creditedKey?: string;
      bbox?: WalkaboutBBox;
      limit: number;
    },
  ): Promise<WalkaboutReceptionPoint[]> {
    requireSource(sourceId, 'getReceptionPoints');
    if (q.sessionIds.length === 0) return [];
    const { coverageWalkaboutReceptions: rx } = this.tables;
    const conds = [
      inArray(rx.sessionId, q.sessionIds),
      gte(rx.heardAt, q.sinceMs),
      lte(rx.heardAt, q.untilMs),
      this.withSourceScope(rx, sourceId),
    ];
    if (q.creditedKey !== undefined) conds.push(eq(rx.creditedKey, q.creditedKey));
    if (q.bbox) conds.push(...this.bboxConds(rx, q.bbox));
    const rows = await this.db
      .select({
        sessionId: rx.sessionId,
        protocol: rx.protocol,
        creditedKey: rx.creditedKey,
        creditedNodeNum: rx.creditedNodeNum,
        snr: rx.snr,
        heardAt: rx.heardAt,
        latitude: rx.latitude,
        longitude: rx.longitude,
      })
      .from(rx)
      .where(and(...conds))
      .orderBy(desc(rx.heardAt), desc(rx.id))
      .limit(q.limit);
    return rows.map((r: Row): WalkaboutReceptionPoint => ({
      sessionId: r.sessionId as string,
      protocol: r.protocol as 'meshtastic' | 'meshcore',
      creditedKey: r.creditedKey as string,
      creditedNodeNum: r.creditedNodeNum == null ? null : Number(r.creditedNodeNum),
      snr: r.snr == null ? null : Number(r.snr),
      heardAt: Number(r.heardAt),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
    }));
  }

  /** Same shape for samples, on fixAt; ordered by fixAt DESC then id DESC. */
  async getSamplePoints(
    sourceId: string,
    q: { sessionIds: string[]; sinceMs: number; untilMs: number; bbox?: WalkaboutBBox; limit: number },
  ): Promise<WalkaboutSamplePoint[]> {
    requireSource(sourceId, 'getSamplePoints');
    if (q.sessionIds.length === 0) return [];
    const { coverageWalkaboutSamples: smp } = this.tables;
    const conds = [
      inArray(smp.sessionId, q.sessionIds),
      gte(smp.fixAt, q.sinceMs),
      lte(smp.fixAt, q.untilMs),
      this.withSourceScope(smp, sourceId),
    ];
    if (q.bbox) conds.push(...this.bboxConds(smp, q.bbox));
    const rows = await this.db
      .select({ sessionId: smp.sessionId, fixAt: smp.fixAt, latitude: smp.latitude, longitude: smp.longitude })
      .from(smp)
      .where(and(...conds))
      .orderBy(desc(smp.fixAt), desc(smp.id))
      .limit(q.limit);
    return rows.map((r: Row): WalkaboutSamplePoint => ({
      sessionId: r.sessionId as string,
      fixAt: Number(r.fixAt),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
    }));
  }

  // --- Export / import (#6573) ---

  /** An imported session: always ended (never live, never captured into). */
  async createImportedSession(p: {
    id: string;
    sourceId: string;
    name: string | null;
    startedAt: number;
    endedAt: number;
    endReason: WalkaboutEndReason;
    importId: string;
    createdAt: number;
  }): Promise<DbWalkaboutSession> {
    requireSource(p.sourceId, 'createImportedSession');
    const { coverageWalkaboutSessions: t } = this.tables;
    const row = {
      id: p.id,
      sourceId: p.sourceId,
      name: p.name,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      endReason: p.endReason,
      startedBy: null,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
      importId: p.importId,
    };
    await this.db.insert(t).values(row);
    return this.toSession(row);
  }

  /** Bulk insert, in chunks. The caller reads ids back with `listSamples`. */
  async insertSamplesBulk(rows: NewWalkaboutSample[], chunk = 500): Promise<void> {
    const { coverageWalkaboutSamples: smp } = this.tables;
    for (const r of rows) requireSource(r.sourceId, 'insertSamplesBulk');
    for (let i = 0; i < rows.length; i += chunk) {
      const values = rows.slice(i, i + chunk);
      if (values.length > 0) await this.db.insert(smp).values(values);
    }
  }

  /**
   * Bulk insert that skips rows hitting `cov_wk_rx_uniq`; a duplicate mid-chunk
   * never loses the rest (SQLite/PG ON CONFLICT DO NOTHING, MySQL INSERT IGNORE).
   * Returns the number inserted.
   */
  async insertReceptionsBulk(rows: NewWalkaboutReception[], chunk = 500): Promise<number> {
    const { coverageWalkaboutReceptions: rx } = this.tables;
    for (const r of rows) requireSource(r.sourceId, 'insertReceptionsBulk');
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const values = rows.slice(i, i + chunk);
      if (values.length === 0) continue;
      const result = this.isMySQL()
        ? await this.getMysqlDb().insert(rx as any).ignore().values(values) // eslint-disable-line @typescript-eslint/no-explicit-any -- dialect-union table
        : await (this.db as any).insert(rx).values(values).onConflictDoNothing(); // eslint-disable-line @typescript-eslint/no-explicit-any -- dialect-union builder
      inserted += this.getAffectedRows(result);
    }
    return inserted;
  }

  /** Every sample of one session, oldest fix first, at most `limit`. */
  async listSamples(sourceId: string, sessionId: string, limit: number): Promise<DbWalkaboutSample[]> {
    requireSource(sourceId, 'listSamples');
    const { coverageWalkaboutSamples: smp } = this.tables;
    const rows = await this.db.select().from(smp)
      .where(and(eq(smp.sessionId, sessionId), this.withSourceScope(smp, sourceId)))
      .orderBy(asc(smp.fixAt), asc(smp.id))
      .limit(limit);
    return rows.map((r: Row) => this.toSample(r));
  }

  /** Every reception of one session, oldest first, at most `limit`. */
  async listReceptions(sourceId: string, sessionId: string, limit: number): Promise<DbWalkaboutReception[]> {
    requireSource(sourceId, 'listReceptions');
    const { coverageWalkaboutReceptions: rx } = this.tables;
    const rows = await this.db.select().from(rx)
      .where(and(eq(rx.sessionId, sessionId), this.withSourceScope(rx, sourceId)))
      .orderBy(asc(rx.heardAt), asc(rx.id))
      .limit(limit);
    return rows.map((r: Row): DbWalkaboutReception => ({
      id: Number(r.id),
      sessionId: r.sessionId as string,
      sourceId: r.sourceId as string,
      protocol: r.protocol as 'meshtastic' | 'meshcore',
      creditedKey: r.creditedKey as string,
      creditedNodeNum: r.creditedNodeNum == null ? null : Number(r.creditedNodeNum),
      creditKind: r.creditKind as 'direct' | 'relay',
      hopsAway: r.hopsAway == null ? null : Number(r.hopsAway),
      packetKey: r.packetKey as string,
      snr: r.snr == null ? null : Number(r.snr),
      rssi: r.rssi == null ? null : Number(r.rssi),
      heardAt: Number(r.heardAt),
      sampleId: r.sampleId == null ? null : Number(r.sampleId),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      accuracyM: Number(r.accuracyM),
      sampleAgeMs: Number(r.sampleAgeMs),
    }));
  }

  /** Ids of the source's imported sessions; one import when `importId` is given. */
  private async importedSessionIds(sourceId: string, importId?: string): Promise<string[]> {
    const { coverageWalkaboutSessions: t } = this.tables;
    const rows = await this.db.select({ id: t.id }).from(t)
      .where(and(
        importId === undefined ? isNotNull(t.importId) : eq(t.importId, importId),
        this.withSourceScope(t, sourceId),
      ));
    return rows.map((r: Row) => r.id as string);
  }

  private async deleteSessionsById(sourceId: string, ids: string[]): Promise<number> {
    const { coverageWalkaboutSessions: t, coverageWalkaboutSamples: smp, coverageWalkaboutReceptions: rx } = this.tables;
    let removed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await this.db.delete(rx).where(and(inArray(rx.sessionId, part), this.withSourceScope(rx, sourceId)));
      await this.db.delete(smp).where(and(inArray(smp.sessionId, part), this.withSourceScope(smp, sourceId)));
      removed += this.getAffectedRows(
        await this.db.delete(t).where(and(inArray(t.id, part), this.withSourceScope(t, sourceId))),
      );
    }
    return removed;
  }

  /** Delete one import's sessions with their samples and receptions. Returns sessions removed. */
  async deleteImportSessions(sourceId: string, importId: string): Promise<number> {
    requireSource(sourceId, 'deleteImportSessions');
    if (!importId) throw new Error('CoverageWalkaboutRepository.deleteImportSessions requires an importId');
    return this.deleteSessionsById(sourceId, await this.importedSessionIds(sourceId, importId));
  }

  /** Delete every imported session of one source (source delete). */
  async deleteImportedForSource(sourceId: string): Promise<number> {
    requireSource(sourceId, 'deleteImportedForSource');
    return this.deleteSessionsById(sourceId, await this.importedSessionIds(sourceId));
  }

  /** Samples + receptions held by imported sessions on one source (per-source row cap). */
  async countImportedRows(sourceId: string): Promise<number> {
    requireSource(sourceId, 'countImportedRows');
    const ids = await this.importedSessionIds(sourceId);
    const { coverageWalkaboutSamples: smp, coverageWalkaboutReceptions: rx } = this.tables;
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const s = await this.db.select({ n: count() }).from(smp)
        .where(and(inArray(smp.sessionId, part), this.withSourceScope(smp, sourceId)));
      const x = await this.db.select({ n: count() }).from(rx)
        .where(and(inArray(rx.sessionId, part), this.withSourceScope(rx, sourceId)));
      n += Number(s[0]?.n ?? 0) + Number(x[0]?.n ?? 0);
    }
    return n;
  }

  /** Lat/lon prefilter. west > east means the box crosses the antimeridian. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5891 table type differs per backend
  private bboxConds(t: any, b: WalkaboutBBox): SQL[] {
    const conds: SQL[] = [gte(t.latitude, b.south), lte(t.latitude, b.north)];
    if (b.west <= b.east) {
      conds.push(gte(t.longitude, b.west), lte(t.longitude, b.east));
    } else {
      conds.push(or(gte(t.longitude, b.west), lte(t.longitude, b.east)) as SQL);
    }
    return conds;
  }
}
