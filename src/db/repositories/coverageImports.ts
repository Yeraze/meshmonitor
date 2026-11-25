/**
 * Repository for `coverage_imports` (Walkabout Coverage epic #5891, Phase 3).
 * Spec: WALKABOUT_P3_SPEC.md §3.6.
 *
 * Every method takes `sourceId` and scopes with `withSourceScope`. The
 * per-source caps (50 imports / 200k rows) are checked by the import service
 * via `countImports` / `CoverageReceptionsRepository.countImportedRows`.
 */
import { and, count, desc, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { CoverageReceptionsRepository } from './coverageReceptions.js';
import { COVERAGE_IMPORT_LIST_LIMIT } from '../../utils/coverageImport.js';
import type { CoverageImportFormat, CoverageImportKind } from '../../types/coverageImport.js';

export interface DbCoverageImport {
  id: string;
  sourceId: string;
  kind: CoverageImportKind;
  format: CoverageImportFormat;
  filename: string;
  fileSha256: string;
  status: 'importing' | 'complete';
  /** users.id; never sent to the client. */
  importedBy: number | null;
  importedAt: number;
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  skippedCount: number;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  sourceTruncated: boolean;
}

export interface CreateCoverageImportParams {
  id: string;
  sourceId: string;
  kind: CoverageImportKind;
  format: CoverageImportFormat;
  filename: string;
  fileSha256: string;
  importedBy: number | null;
  importedAt: number;
  rowCount: number;
}

export interface CompleteCoverageImportParams {
  insertedCount: number;
  duplicateCount: number;
  skippedCount: number;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  sourceTruncated: boolean;
}

/** Thrown by `createImport` on a `(sourceId, fileSha256)` unique violation. */
export class CoverageImportDuplicateError extends Error {
  constructor(public sourceId: string, public fileSha256: string) {
    super(`Coverage import already exists for source ${sourceId} (sha256 ${fileSha256})`);
    this.name = 'CoverageImportDuplicateError';
  }
}

export class CoverageImportsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private map(row: any): DbCoverageImport { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
    return {
      id: row.id,
      sourceId: row.sourceId,
      kind: row.kind,
      format: row.format,
      filename: row.filename,
      fileSha256: row.fileSha256,
      status: row.status,
      importedBy: row.importedBy == null ? null : Number(row.importedBy),
      importedAt: Number(row.importedAt),
      rowCount: Number(row.rowCount),
      insertedCount: Number(row.insertedCount),
      duplicateCount: Number(row.duplicateCount),
      skippedCount: Number(row.skippedCount),
      firstReceivedAt: row.firstReceivedAt == null ? null : Number(row.firstReceivedAt),
      lastReceivedAt: row.lastReceivedAt == null ? null : Number(row.lastReceivedAt),
      sourceTruncated: Boolean(row.sourceTruncated),
    };
  }

  private static isUniqueViolation(err: unknown): boolean {
    for (let e: any = err, depth = 0; e && depth < 4; e = e.cause, depth++) { // eslint-disable-line @typescript-eslint/no-explicit-any -- driver error shapes
      if (e.code === '23505' || e.code === 'ER_DUP_ENTRY' || e.errno === 1062) return true;
      if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true;
      if (typeof e.message === 'string' && /UNIQUE constraint failed|duplicate key value|Duplicate entry/i.test(e.message)) return true;
    }
    return false;
  }

  /** Throws CoverageImportDuplicateError on the (sourceId, fileSha256) unique violation. */
  async createImport(p: CreateCoverageImportParams): Promise<DbCoverageImport> {
    if (!p.sourceId) throw new Error('CoverageImportsRepository.createImport requires a sourceId');
    const { coverageImports } = this.tables;
    const row = {
      id: p.id,
      sourceId: p.sourceId,
      kind: p.kind,
      format: p.format,
      filename: p.filename,
      fileSha256: p.fileSha256,
      status: 'importing' as const,
      importedBy: p.importedBy,
      importedAt: p.importedAt,
      rowCount: p.rowCount,
      insertedCount: 0,
      duplicateCount: 0,
      skippedCount: 0,
      firstReceivedAt: null,
      lastReceivedAt: null,
      sourceTruncated: false,
    };
    try {
      await this.db.insert(coverageImports).values(row);
    } catch (err) {
      if (CoverageImportsRepository.isUniqueViolation(err) && (await this.findByHash(p.sourceId, p.fileSha256))) {
        throw new CoverageImportDuplicateError(p.sourceId, p.fileSha256);
      }
      throw err;
    }
    return this.map(row);
  }

  async findByHash(sourceId: string, fileSha256: string): Promise<DbCoverageImport | null> {
    const { coverageImports } = this.tables;
    const rows = await this.db
      .select()
      .from(coverageImports)
      .where(and(this.withSourceScope(coverageImports, sourceId), eq(coverageImports.fileSha256, fileSha256)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : null;
  }

  async getImport(sourceId: string, id: string): Promise<DbCoverageImport | null> {
    const { coverageImports } = this.tables;
    const rows = await this.db
      .select()
      .from(coverageImports)
      .where(and(this.withSourceScope(coverageImports, sourceId), eq(coverageImports.id, id)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : null;
  }

  /** importedAt DESC. */
  async listImports(sourceId: string, limit: number = COVERAGE_IMPORT_LIST_LIMIT): Promise<DbCoverageImport[]> {
    const { coverageImports } = this.tables;
    const rows = await this.db
      .select()
      .from(coverageImports)
      .where(this.withSourceScope(coverageImports, sourceId))
      .orderBy(desc(coverageImports.importedAt), desc(coverageImports.id))
      .limit(Math.max(1, Math.trunc(limit)));
    return (rows as any[]).map((r) => this.map(r)); // eslint-disable-line @typescript-eslint/no-explicit-any -- dialect-union rows
  }

  /** Every batch still `importing`, across sources (startup sweep of crashed imports). */
  async listIncomplete(): Promise<DbCoverageImport[]> {
    const { coverageImports } = this.tables;
    const rows = await this.db.select().from(coverageImports).where(eq(coverageImports.status, 'importing'));
    return (rows as any[]).map((r) => this.map(r)); // eslint-disable-line @typescript-eslint/no-explicit-any -- dialect-union rows
  }

  async countImports(sourceId: string): Promise<number> {
    const { coverageImports } = this.tables;
    const rows = await this.db
      .select({ n: count() })
      .from(coverageImports)
      .where(this.withSourceScope(coverageImports, sourceId));
    return Number((rows as any[])[0]?.n ?? 0); // eslint-disable-line @typescript-eslint/no-explicit-any -- dialect-union row
  }

  async completeImport(sourceId: string, id: string, p: CompleteCoverageImportParams): Promise<void> {
    const { coverageImports } = this.tables;
    await this.db
      .update(coverageImports)
      .set({
        status: 'complete',
        insertedCount: p.insertedCount,
        duplicateCount: p.duplicateCount,
        skippedCount: p.skippedCount,
        firstReceivedAt: p.firstReceivedAt,
        lastReceivedAt: p.lastReceivedAt,
        sourceTruncated: p.sourceTruncated,
      })
      .where(and(this.withSourceScope(coverageImports, sourceId), eq(coverageImports.id, id)));
  }

  /** Rows first (via coverageReceptions.deleteImportRows), then the batch. */
  async deleteImport(sourceId: string, id: string): Promise<boolean> {
    const { coverageImports } = this.tables;
    // Scope check first: never delete rows for an id this source does not own.
    if (!(await this.getImport(sourceId, id))) return false;
    await this.receptions().deleteImportRows(sourceId, id);
    const result = await this.db
      .delete(coverageImports)
      .where(and(this.withSourceScope(coverageImports, sourceId), eq(coverageImports.id, id)));
    return this.getAffectedRows(result) > 0;
  }

  /** Source delete: the source's `importId IS NOT NULL` reception rows, then every batch (§2.8 trap). */
  async deleteForSource(sourceId: string): Promise<void> {
    const { coverageImports } = this.tables;
    await this.receptions().deleteImportedForSource(sourceId);
    await this.db.delete(coverageImports).where(this.withSourceScope(coverageImports, sourceId));
  }

  private receptions(): CoverageReceptionsRepository {
    return new CoverageReceptionsRepository(this.db, this.dbType);
  }
}
