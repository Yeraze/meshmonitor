/**
 * Coverage import service (#5891 Phase 3, WP3). Spec: WALKABOUT_P3_SPEC.md §3.9.
 *
 * Parses a Coverage Report export (CSV / GeoJSON), checks it against the target
 * source, enforces the per-source caps, and writes the rows as one import batch.
 * Sends nothing: no packets, events or timers.
 */
import crypto from 'node:crypto';
import databaseService from '../../services/database.js';
import { CoverageImportDuplicateError, type DbCoverageImport } from '../../db/repositories/coverageImports.js';
import {
  COVERAGE_IMPORT_MAX_PER_SOURCE,
  COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE,
  coverageImportProtocolFor,
  parseCoverageImport,
} from '../../utils/coverageImport.js';
import type { CoverageImportDto, CoverageImportResult } from '../../types/coverageImport.js';
import { logger } from '../../utils/logger.js';

export class CoverageImportError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CoverageImportError';
  }
}

export function toCoverageImportDto(row: DbCoverageImport, userId: number | null): CoverageImportDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    kind: row.kind,
    format: row.format,
    filename: row.filename,
    status: row.status,
    importedAt: row.importedAt,
    importedByMe: userId !== null && row.importedBy === userId,
    rowCount: row.rowCount,
    insertedCount: row.insertedCount,
    duplicateCount: row.duplicateCount,
    skippedCount: row.skippedCount,
    firstReceivedAt: row.firstReceivedAt,
    lastReceivedAt: row.lastReceivedAt,
    sourceTruncated: row.sourceTruncated,
  };
}

// Serialise imports per source so two uploads cannot both pass the cap checks.
const sourceLocks = new Map<string, Promise<unknown>>();

export async function withSourceLock<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sourceLocks.get(sourceId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  sourceLocks.set(sourceId, tail);
  try {
    return await run;
  } finally {
    if (sourceLocks.get(sourceId) === tail) sourceLocks.delete(sourceId);
  }
}

function duplicateError(existing: DbCoverageImport): CoverageImportError {
  return new CoverageImportError(
    'IMPORT_DUPLICATE_FILE',
    `This file was already imported as "${existing.filename}"`,
    409,
    { importId: existing.id, filename: existing.filename },
  );
}

async function duplicateFor(sourceId: string, sha: string): Promise<CoverageImportError> {
  const existing = await databaseService.coverageImports.findByHash(sourceId, sha);
  return existing
    ? duplicateError(existing)
    : new CoverageImportError('IMPORT_DUPLICATE_FILE', 'This file was already imported', 409);
}

export async function importCoverageFile(p: {
  sourceId: string;
  userId: number | null;
  filename: string;
  body: Buffer;
  nowMs?: number;
}): Promise<CoverageImportResult> {
  return withSourceLock(p.sourceId, () => runImport(p));
}

async function runImport(p: {
  sourceId: string;
  userId: number | null;
  filename: string;
  body: Buffer;
  nowMs?: number;
}): Promise<CoverageImportResult> {
  const imports = databaseService.coverageImports;
  const coverageReceptions = databaseService.coverageReceptions;

  const source = await databaseService.sources.getSource(p.sourceId);
  if (!source) throw new CoverageImportError('SOURCE_NOT_FOUND', 'Source not found', 404);

  const protocol = coverageImportProtocolFor(source.type);
  if (!protocol) {
    throw new CoverageImportError(
      'IMPORT_SOURCE_UNSUPPORTED',
      'This source type cannot hold imported coverage data',
      400,
    );
  }

  if ((await imports.countImports(p.sourceId)) >= COVERAGE_IMPORT_MAX_PER_SOURCE) {
    throw new CoverageImportError(
      'IMPORT_LIMIT_REACHED',
      `This source already holds ${COVERAGE_IMPORT_MAX_PER_SOURCE} imports; delete one first`,
      409,
    );
  }

  const sha = crypto.createHash('sha256').update(p.body).digest('hex');
  const existing = await imports.findByHash(p.sourceId, sha);
  if (existing) throw duplicateError(existing);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(p.body);
  } catch {
    throw new CoverageImportError('IMPORT_UNSUPPORTED_FILE', 'The file is not valid UTF-8 text', 400);
  }

  const parsed = parseCoverageImport(p.filename, text, p.nowMs);
  if (!parsed.ok) {
    throw new CoverageImportError(parsed.code, parsed.message, 400, {
      errors: parsed.errors,
      errorCount: parsed.errors.length,
    });
  }

  const rows = parsed.rows.filter((r) => r.protocol === protocol);
  const protocolMismatch = parsed.rows.length - rows.length;
  if (rows.length === 0) {
    throw new CoverageImportError(
      'IMPORT_NO_MATCHING_ROWS',
      `The file has no ${protocol} rows to import into this source`,
      400,
    );
  }

  const existingRows = await coverageReceptions.countImportedRows(p.sourceId);
  if (existingRows + rows.length > COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE) {
    throw new CoverageImportError(
      'IMPORT_LIMIT_REACHED',
      `This source can hold ${COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE} imported rows; it has ${existingRows}`,
      409,
    );
  }

  const importId = crypto.randomUUID();
  try {
    await imports.createImport({
      id: importId,
      sourceId: p.sourceId,
      kind: 'coverage_report',
      format: parsed.format,
      filename: p.filename,
      fileSha256: sha,
      importedBy: p.userId,
      importedAt: Date.now(),
      rowCount: rows.length,
    });
  } catch (err) {
    if (err instanceof CoverageImportDuplicateError) throw await duplicateFor(p.sourceId, sha);
    throw err;
  }

  try {
    const inserted = await coverageReceptions.insertImportedRows(p.sourceId, importId, rows);
    let first: number | null = null;
    let last: number | null = null;
    for (const r of rows) {
      if (first === null || r.receivedAt < first) first = r.receivedAt;
      if (last === null || r.receivedAt > last) last = r.receivedAt;
    }
    const bogus = parsed.skippedBogusPositions ?? 0;
    await imports.completeImport(p.sourceId, importId, {
      insertedCount: inserted,
      duplicateCount: rows.length - inserted,
      skippedCount: protocolMismatch + parsed.gapFeatures + bogus,
      firstReceivedAt: first,
      lastReceivedAt: last,
      sourceTruncated: parsed.sourceTruncated,
    });
    const done = await imports.getImport(p.sourceId, importId);
    if (!done) throw new Error('Import batch vanished after completion');
    return {
      import: toCoverageImportDto(done, p.userId),
      skipped: { protocolMismatch, gapFeatures: parsed.gapFeatures, bogusPositions: bogus },
    };
  } catch (err) {
    try {
      // Rows first, unguarded: the batch row may already be gone.
      await coverageReceptions.deleteImportRows(p.sourceId, importId);
      await imports.deleteImport(p.sourceId, importId);
    } catch (cleanupErr) {
      logger.error(`[CoverageImport] cleanup of partial import ${importId} failed:`, cleanupErr);
    }
    throw err;
  }
}

/** Delete one import under the source lock; refuses a batch that is still importing. */
export async function deleteCoverageImport(sourceId: string, importId: string): Promise<void> {
  return withSourceLock(sourceId, async () => {
    const existing = await databaseService.coverageImports.getImport(sourceId, importId);
    if (!existing) throw new CoverageImportError('IMPORT_NOT_FOUND', 'Import not found', 404);
    if (existing.status === 'importing') {
      throw new CoverageImportError('IMPORT_IN_PROGRESS', 'This import is still running', 409);
    }
    await databaseService.coverageImports.deleteImport(sourceId, importId);
  });
}

/** Source-delete cleanup, serialised with imports into that source. */
export async function deleteCoverageImportsForSource(sourceId: string): Promise<void> {
  return withSourceLock(sourceId, () => databaseService.coverageImports.deleteForSource(sourceId));
}

/**
 * Startup sweep: a crash mid-import leaves an `importing` batch and partial rows
 * whose hash would block a retry. Nothing is running at boot, so delete them.
 */
export async function sweepIncompleteCoverageImports(): Promise<number> {
  const stale = await databaseService.coverageImports.listIncomplete();
  for (const b of stale) {
    await withSourceLock(b.sourceId, async () => {
      await databaseService.coverageReceptions.deleteImportRows(b.sourceId, b.id);
      await databaseService.coverageImports.deleteImport(b.sourceId, b.id);
    });
  }
  if (stale.length > 0) logger.warn(`[CoverageImport] removed ${stale.length} incomplete import(s) left by a restart`);
  return stale.length;
}
