/**
 * Coverage import routes (#5891 Phase 3, WP3). Spec: WALKABOUT_P3_SPEC.md §3.8.
 *
 * Mounted at `/api/sources/:id/coverage/imports` (`mergeParams`). Every lookup
 * is by `(params.id, importId)`: an import on another source is a 404. A grant
 * on one source never opens another (`sourceIdFrom: 'params.id'`).
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';
import {
  CoverageImportError,
  importCoverageFile,
  toCoverageImportDto,
} from '../services/coverageImportService.js';
import {
  COVERAGE_IMPORT_LIST_LIMIT,
  COVERAGE_IMPORT_MAX_BYTES,
  COVERAGE_IMPORT_READ_GRANT,
  COVERAGE_IMPORT_WRITE_GRANT,
  sanitizeImportFilename,
} from '../../utils/coverageImport.js';

const router = Router({ mergeParams: true });

/** Test seam: lets a test lower the byte cap without sending 32 MB. */
export const coverageImportLimits = { maxBytes: COVERAGE_IMPORT_MAX_BYTES };

const sourceOpts = { sourceIdFrom: 'params.id', requireSourceId: true } as const;
const canRead = [
  requireAuth(),
  requirePermission(COVERAGE_IMPORT_READ_GRANT.resource, COVERAGE_IMPORT_READ_GRANT.action, sourceOpts),
];
const canWrite = [
  requireAuth(),
  requirePermission(COVERAGE_IMPORT_WRITE_GRANT.resource, COVERAGE_IMPORT_WRITE_GRANT.action, sourceOpts),
];

const sourceOf = (req: Request): string => String(req.params.id);
const userIdOf = (req: Request): number | null => req.user?.id ?? null;

router.get('/', ...canRead, async (req: Request, res: Response) => {
  try {
    const rows = await databaseService.coverageImports.listImports(sourceOf(req), COVERAGE_IMPORT_LIST_LIMIT);
    ok(res, { imports: rows.map((r) => toCoverageImportDto(r, userIdOf(req))) });
  } catch (error) {
    logger.error('Error in GET coverage imports:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to list coverage imports');
  }
});

function requireOctetStream(req: Request, res: Response, next: NextFunction): void {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') {
    fail(res, 415, 'IMPORT_BAD_CONTENT_TYPE', 'Send the file as application/octet-stream');
    return;
  }
  next();
}

const rawBody = (req: Request, res: Response, next: NextFunction): void => {
  express.raw({ type: 'application/octet-stream', limit: coverageImportLimits.maxBytes })(req, res, next);
};

router.post(
  '/',
  ...canWrite,
  extendRequestTimeout(120_000),
  requireOctetStream,
  rawBody,
  async (req: Request, res: Response) => {
    try {
      const rawName = req.headers['x-filename'];
      let decoded: string;
      try {
        decoded = decodeURIComponent(typeof rawName === 'string' ? rawName : '');
      } catch {
        return fail(res, 400, 'IMPORT_BAD_FILENAME', 'X-Filename is not valid URI-encoded text');
      }
      const filename = sanitizeImportFilename(decoded);
      if (!filename) {
        return fail(res, 400, 'IMPORT_BAD_FILENAME', 'The file needs a .csv, .geojson or .json name (200 characters at most)');
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return fail(res, 400, 'IMPORT_EMPTY', 'The file is empty');
      }
      const result = await importCoverageFile({
        sourceId: sourceOf(req),
        userId: userIdOf(req),
        filename,
        body: req.body,
      });
      logger.info(
        `[CoverageImport] user ${userIdOf(req)} imported "${filename}" into source ${sourceOf(req)}: ` +
        `${result.import.insertedCount} new, ${result.import.duplicateCount} duplicate`,
      );
      res.status(201);
      ok(res, result);
    } catch (error) {
      if (error instanceof CoverageImportError) {
        return fail(res, error.status, error.code, error.message, error.extra);
      }
      logger.error('Error in POST coverage import:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Failed to import coverage file');
    }
  },
);

// express.raw rejects a body over the limit with an `entity.too.large` error.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const e = err as { type?: string } | null;
  if (e?.type === 'entity.too.large') {
    fail(res, 413, 'IMPORT_TOO_LARGE', 'The file is too large to import');
    return;
  }
  next(err);
});

router.delete('/:importId', ...canWrite, async (req: Request, res: Response) => {
  try {
    const sourceId = sourceOf(req);
    const importId = String(req.params.importId);
    const existing = await databaseService.coverageImports.getImport(sourceId, importId);
    if (!existing) return fail(res, 404, 'IMPORT_NOT_FOUND', 'Import not found');
    await databaseService.coverageImports.deleteImport(sourceId, importId);
    logger.info(`[CoverageImport] user ${userIdOf(req)} deleted import ${importId} from source ${sourceId}`);
    ok(res);
  } catch (error) {
    logger.error('Error in DELETE coverage import:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to delete coverage import');
  }
});

export default router;
