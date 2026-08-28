/**
 * Repository for `mesh_issues` — passively-detected mesh health findings
 * (Mesh Issues Analysis epic #4964, Phase 1 WP1).
 *
 * GLOBAL by design (no `sourceId` column) — see the header comment on
 * `src/db/schema/meshIssues.ts` for the identity model
 * (`(issueType, subjectKey)`) and why `subjectKey` rather than a nullable
 * `nodeNum` is the UNIQUE key.
 *
 * `upsertFinding` uses select-then-insert-or-update (the pattern
 * `MeshtasticHeardRepeatersRepository.recordHeardRepeater` uses) — portable
 * across all three dialects with no `ON CONFLICT` branching.
 */
import { and, eq, desc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import type {
  MeshIssueFinding,
  MeshIssueSeverity,
  MeshIssueConfidence,
  MeshIssueStatus,
} from '../../server/services/meshIssues/types.js';

export interface DbMeshIssue {
  id: number;
  issueType: string;
  subjectKey: string;
  nodeNum: number | null;
  severity: MeshIssueSeverity;
  confidence: MeshIssueConfidence;
  /** JSON text as stored — includes `recommendation`. Callers parse it. */
  evidence: string;
  /** JSON text as stored — array of contributing source ids. */
  sourceIds: string;
  firstDetected: number;
  lastDetected: number;
  cleanRuns: number;
  status: MeshIssueStatus;
  closedAt: number | null;
  dismissed: boolean;
  dismissedAt: number | null;
  dismissedBy: number | null;
  createdAt: number;
  updatedAt: number;
}

export type UpsertOutcome = 'created' | 'updated' | 'reopened';

export interface GetIssuesOptions {
  /** Default false — closed findings are excluded. */
  includeClosed?: boolean;
  /** Default false — dismissed findings are excluded. */
  includeDismissed?: boolean;
}

export class MeshIssuesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert or refresh one finding, keyed by (issueType, subjectKey).
   *
   * | Existing row    | Action                                                                          | outcome    |
   * |-----------------|----------------------------------------------------------------------------------|------------|
   * | none            | insert; firstDetected = lastDetected = createdAt = updatedAt = nowMs, cleanRuns=0 | 'created'  |
   * | status='open'   | update severity/confidence/evidence/sourceIds/lastDetected/updatedAt/cleanRuns=0 | 'updated'  |
   * | status='closed' | same as above, plus status='open', closedAt=null                                | 'reopened' |
   *
   * `firstDetected` and `dismissed` are never touched by an update — the
   * original first-sighting timestamp is the useful fact, and clearing
   * `dismissed` on a re-detection would fight the Phase 3 dismiss UI.
   */
  async upsertFinding(
    finding: MeshIssueFinding,
    nowMs: number,
  ): Promise<{ issue: DbMeshIssue; outcome: UpsertOutcome }> {
    const { meshIssues } = this.tables;
    const evidenceJson = JSON.stringify({ ...finding.evidence, recommendation: finding.recommendation });
    const sourceIdsJson = JSON.stringify([...finding.sourceIds].sort());

    const existing = await this.getByTypeAndSubject(finding.issueType, finding.subjectKey);

    if (!existing) {
      await this.db.insert(meshIssues).values({
        issueType: finding.issueType,
        subjectKey: finding.subjectKey,
        nodeNum: finding.nodeNum,
        severity: finding.severity,
        confidence: finding.confidence,
        evidence: evidenceJson,
        sourceIds: sourceIdsJson,
        firstDetected: nowMs,
        lastDetected: nowMs,
        cleanRuns: 0,
        status: 'open',
        closedAt: null,
        dismissed: false,
        dismissedAt: null,
        dismissedBy: null,
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      const created = await this.getByTypeAndSubject(finding.issueType, finding.subjectKey);
      if (!created) {
        throw new Error('MeshIssuesRepository.upsertFinding: insert did not round-trip');
      }
      return { issue: created, outcome: 'created' };
    }

    const wasClosed = existing.status === 'closed';
    const updateSet: Record<string, unknown> = {
      severity: finding.severity,
      confidence: finding.confidence,
      evidence: evidenceJson,
      sourceIds: sourceIdsJson,
      lastDetected: nowMs,
      updatedAt: nowMs,
      cleanRuns: 0,
    };
    if (wasClosed) {
      updateSet.status = 'open';
      updateSet.closedAt = null;
    }

    await this.db
      .update(meshIssues)
      .set(updateSet)
      .where(and(eq(meshIssues.issueType, finding.issueType), eq(meshIssues.subjectKey, finding.subjectKey)));

    const updated = await this.getByTypeAndSubject(finding.issueType, finding.subjectKey);
    if (!updated) {
      throw new Error('MeshIssuesRepository.upsertFinding: update did not round-trip');
    }
    return { issue: updated, outcome: wasClosed ? 'reopened' : 'updated' };
  }

  /** Findings, newest-detected first. Default excludes closed and dismissed. */
  async getIssues(opts: GetIssuesOptions = {}): Promise<DbMeshIssue[]> {
    const { meshIssues } = this.tables;
    const conditions = [];
    if (!opts.includeClosed) conditions.push(eq(meshIssues.status, 'open'));
    if (!opts.includeDismissed) conditions.push(eq(meshIssues.dismissed, false));

    const query = conditions.length > 0
      ? this.db.select().from(meshIssues).where(and(...conditions))
      : this.db.select().from(meshIssues);

    const rows = await query.orderBy(desc(meshIssues.lastDetected));
    return (rows as unknown[]).map((r) => this.normalizeRow(r));
  }

  async getIssueById(id: number): Promise<DbMeshIssue | null> {
    const { meshIssues } = this.tables;
    const rows = await this.db.select().from(meshIssues).where(eq(meshIssues.id, id)).limit(1);
    if (rows.length === 0) return null;
    return this.normalizeRow(rows[0]);
  }

  /**
   * Record one run in which this finding was NOT re-detected. Increments
   * `cleanRuns`; when it reaches `autoCloseAfter`, sets status='closed' and
   * closedAt=nowMs. Returns whether it closed. A no-op re: dismissed — a
   * dismissed finding still accumulates clean runs so it eventually closes.
   */
  async bumpCleanRun(
    id: number,
    autoCloseAfter: number,
    nowMs: number,
  ): Promise<{ cleanRuns: number; closed: boolean }> {
    const { meshIssues } = this.tables;
    const existing = await this.getIssueById(id);
    if (!existing) {
      throw new Error(`MeshIssuesRepository.bumpCleanRun: no issue with id ${id}`);
    }
    const cleanRuns = existing.cleanRuns + 1;
    const closes = existing.status !== 'closed' && cleanRuns >= autoCloseAfter;
    const updateSet: Record<string, unknown> = { cleanRuns, updatedAt: nowMs };
    if (closes) {
      updateSet.status = 'closed';
      updateSet.closedAt = nowMs;
    }
    await this.db.update(meshIssues).set(updateSet).where(eq(meshIssues.id, id));
    return { cleanRuns, closed: closes };
  }

  /** Phase 3 UI; implemented and tested now so no follow-up migration is needed. */
  async setDismissed(id: number, dismissed: boolean, userId: number | null, nowMs: number): Promise<void> {
    const { meshIssues } = this.tables;
    await this.db
      .update(meshIssues)
      .set({
        dismissed,
        dismissedAt: dismissed ? nowMs : null,
        dismissedBy: dismissed ? userId : null,
        updatedAt: nowMs,
      })
      .where(eq(meshIssues.id, id));
  }

  async deleteAll(): Promise<number> {
    const { meshIssues } = this.tables;
    const result = await this.db.delete(meshIssues);
    return this.getAffectedRows(result);
  }

  private async getByTypeAndSubject(issueType: string, subjectKey: string): Promise<DbMeshIssue | null> {
    const { meshIssues } = this.tables;
    const rows = await this.db
      .select()
      .from(meshIssues)
      .where(and(eq(meshIssues.issueType, issueType), eq(meshIssues.subjectKey, subjectKey)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.normalizeRow(rows[0]);
  }

  /** Normalizes BigInts (PG/MySQL) and coerces nodeNum / dismissed types. */
  private normalizeRow(row: unknown): DbMeshIssue {
    const normalized = this.normalizeBigInts(row) as Record<string, unknown>;
    return {
      ...normalized,
      nodeNum: normalized.nodeNum == null ? null : Number(normalized.nodeNum),
      dismissed: Boolean(normalized.dismissed),
    } as DbMeshIssue;
  }
}
