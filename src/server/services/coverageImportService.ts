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
import { isWalkaboutExportText, parseWalkaboutImport, type ParsedWalkaboutSession } from '../../utils/walkaboutImport.js';
import { WALKABOUT_SOURCE_TYPES } from '../../utils/walkabout.js';
import type { NewWalkaboutReception, NewWalkaboutSample } from '../../db/repositories/coverageWalkabout.js';

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

  // A walkabout session export (#6573) takes its own path into the walkabout tables.
  if (/\.json$/i.test(p.filename) && isWalkaboutExportText(text)) {
    return runWalkaboutImport({ ...p, sourceType: source.type, protocol, sha, text });
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

  const existingRows = await countAllImportedRows(p.sourceId);
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

/** Imported rows on one source across both kinds: the 200k per-source cap counts them together. */
export async function countAllImportedRows(sourceId: string): Promise<number> {
  const [coverage, walkabout] = await Promise.all([
    databaseService.coverageReceptions.countImportedRows(sourceId),
    databaseService.coverageWalkabout.countImportedRows(sourceId),
  ]);
  return coverage + walkabout;
}

/** Match each file sample to the id its row got, by content (ids are not echoed by a bulk insert). */
const sampleKey = (s: { deviceFixAt: number; fixAt: number; receivedAt: number; latitude: number; longitude: number }): string =>
  `${s.deviceFixAt}|${s.fixAt}|${s.receivedAt}|${s.latitude}|${s.longitude}`;

/**
 * Walkabout import (#6573). Each file session becomes a new, already-ended
 * session on the target source tagged with the batch id; its samples and
 * credited receptions are copied with sample links remapped. The file's
 * source and user are never trusted. Receptions of the other protocol are
 * skipped and counted, as for Coverage imports.
 */
async function runWalkaboutImport(p: {
  sourceId: string;
  sourceType: string;
  protocol: 'meshtastic' | 'meshcore';
  userId: number | null;
  filename: string;
  sha: string;
  text: string;
  nowMs?: number;
}): Promise<CoverageImportResult> {
  if (!WALKABOUT_SOURCE_TYPES.has(p.sourceType)) {
    throw new CoverageImportError(
      'IMPORT_SOURCE_UNSUPPORTED',
      'Walkabout sessions can be imported only into a Meshtastic TCP or MeshCore source',
      400,
    );
  }
  const parsed = parseWalkaboutImport(p.text, p.nowMs);
  if (!parsed.ok) {
    throw new CoverageImportError(parsed.code, parsed.message, 400, {
      errors: parsed.errors,
      errorCount: parsed.errorCount,
    });
  }

  let protocolMismatch = 0;
  let fileReceptions = 0;
  const sessions: ParsedWalkaboutSession[] = parsed.sessions.map((s) => {
    fileReceptions += s.receptions.length;
    const receptions = s.receptions.filter((r) => r.protocol === p.protocol);
    protocolMismatch += s.receptions.length - receptions.length;
    return { ...s, receptions };
  });
  if (fileReceptions > 0 && protocolMismatch === fileReceptions) {
    throw new CoverageImportError(
      'IMPORT_NO_MATCHING_ROWS',
      `The file has no ${p.protocol} receptions to import into this source`,
      400,
    );
  }
  const rowCount = sessions.reduce((n, s) => n + s.samples.length + s.receptions.length, 0);

  const existingRows = await countAllImportedRows(p.sourceId);
  if (existingRows + rowCount > COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE) {
    throw new CoverageImportError(
      'IMPORT_LIMIT_REACHED',
      `This source can hold ${COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE} imported rows; it has ${existingRows}`,
      409,
    );
  }

  const imports = databaseService.coverageImports;
  const walkabout = databaseService.coverageWalkabout;
  const importId = crypto.randomUUID();
  const importedAt = Date.now();
  try {
    await imports.createImport({
      id: importId,
      sourceId: p.sourceId,
      kind: 'walkabout',
      format: 'json',
      filename: p.filename,
      fileSha256: p.sha,
      importedBy: p.userId,
      importedAt,
      rowCount,
    });
  } catch (err) {
    if (err instanceof CoverageImportDuplicateError) throw await duplicateFor(p.sourceId, p.sha);
    throw err;
  }

  try {
    const sessionIds: string[] = [];
    let inserted = 0;
    let duplicates = 0;
    for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
      const sessionId = crypto.randomUUID();
      sessionIds.push(sessionId);
      await walkabout.createImportedSession({
        id: sessionId,
        sourceId: p.sourceId,
        name: s.name,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        endReason: s.endReason,
        importId,
        createdAt: importedAt,
      });
      const sampleRows: NewWalkaboutSample[] = s.samples.map((smp) => ({
        sessionId,
        sourceId: p.sourceId,
        latitude: smp.latitude,
        longitude: smp.longitude,
        accuracyM: smp.accuracyM,
        deviceFixAt: smp.deviceFixAt,
        fixAt: smp.fixAt,
        receivedAt: smp.receivedAt,
      }));
      await walkabout.insertSamplesBulk(sampleRows);
      const idsByKey = new Map<string, number[]>();
      for (const row of await walkabout.listSamples(p.sourceId, sessionId, sampleRows.length + 1)) {
        const k = sampleKey(row);
        const list = idsByKey.get(k);
        if (list) list.push(row.id);
        else idsByKey.set(k, [row.id]);
      }
      const newIdOf = new Map<number, number>();
      for (const smp of s.samples) {
        const id = idsByKey.get(sampleKey(smp))?.shift();
        if (id == null) throw new Error('Imported walkabout sample vanished before its receptions were linked');
        newIdOf.set(smp.fileId, id);
      }
      const rxRows: NewWalkaboutReception[] = s.receptions.map((r) => ({
        sessionId,
        sourceId: p.sourceId,
        protocol: r.protocol,
        creditedKey: r.creditedKey,
        creditedNodeNum: r.creditedNodeNum,
        creditKind: r.creditKind,
        hopsAway: r.hopsAway,
        packetKey: r.packetKey,
        snr: r.snr,
        rssi: r.rssi,
        heardAt: r.heardAt,
        sampleId: r.fileSampleId == null ? null : (newIdOf.get(r.fileSampleId) ?? null),
        latitude: r.latitude,
        longitude: r.longitude,
        accuracyM: r.accuracyM,
        sampleAgeMs: r.sampleAgeMs,
      }));
      const rxInserted = await walkabout.insertReceptionsBulk(rxRows);
      inserted += sampleRows.length + rxInserted;
      duplicates += rxRows.length - rxInserted;
    }
    await imports.completeImport(p.sourceId, importId, {
      insertedCount: inserted,
      duplicateCount: duplicates,
      skippedCount: protocolMismatch,
      firstReceivedAt: Math.min(...sessions.map((s) => s.startedAt)),
      lastReceivedAt: Math.max(...sessions.map((s) => s.endedAt)),
      sourceTruncated: parsed.sourceTruncated,
    });
    const done = await imports.getImport(p.sourceId, importId);
    if (!done) throw new Error('Import batch vanished after completion');
    return {
      import: toCoverageImportDto(done, p.userId),
      skipped: { protocolMismatch, gapFeatures: 0 },
      sessionIds,
    };
  } catch (err) {
    try {
      // Sessions first, unguarded: the batch row may already be gone.
      await walkabout.deleteImportSessions(p.sourceId, importId);
      await imports.deleteImport(p.sourceId, importId);
    } catch (cleanupErr) {
      logger.error(`[CoverageImport] cleanup of partial walkabout import ${importId} failed:`, cleanupErr);
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
      await databaseService.coverageWalkabout.deleteImportSessions(b.sourceId, b.id);
      await databaseService.coverageImports.deleteImport(b.sourceId, b.id);
    });
  }
  if (stale.length > 0) logger.warn(`[CoverageImport] removed ${stale.length} incomplete import(s) left by a restart`);
  return stale.length;
}
