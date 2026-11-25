/**
 * Repository for `coverage_imports` (Walkabout Coverage epic #5891, Phase 3).
 * Spec: WALKABOUT_P3_SPEC.md §3.6.
 *
 * WP0 skeleton: final signatures, bodies land in WP2. Every method takes
 * `sourceId` and scopes with `withSourceScope`.
 */
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
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

  /** Throws CoverageImportDuplicateError on the (sourceId, fileSha256) unique violation. */
  async createImport(_p: CreateCoverageImportParams): Promise<DbCoverageImport> {
    throw new Error('not implemented');
  }

  async findByHash(_sourceId: string, _fileSha256: string): Promise<DbCoverageImport | null> {
    throw new Error('not implemented');
  }

  async getImport(_sourceId: string, _id: string): Promise<DbCoverageImport | null> {
    throw new Error('not implemented');
  }

  /** importedAt DESC. */
  async listImports(_sourceId: string, _limit: number = COVERAGE_IMPORT_LIST_LIMIT): Promise<DbCoverageImport[]> {
    throw new Error('not implemented');
  }

  async countImports(_sourceId: string): Promise<number> {
    throw new Error('not implemented');
  }

  async completeImport(_sourceId: string, _id: string, _p: CompleteCoverageImportParams): Promise<void> {
    throw new Error('not implemented');
  }

  /** Rows first (via coverageReceptions.deleteImportRows), then the batch. */
  async deleteImport(_sourceId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  /** Source delete: the source's `importId IS NOT NULL` reception rows, then every batch (§2.8 trap). */
  async deleteForSource(_sourceId: string): Promise<void> {
    throw new Error('not implemented');
  }
}
