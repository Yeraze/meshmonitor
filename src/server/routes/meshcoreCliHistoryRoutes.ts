/**
 * MeshCore CLI command history (#5892).
 *
 *   GET /api/sources/:id/meshcore/cli-history   one source
 *   GET /api/meshcore/cli-history               every source the caller may read
 *
 * Query: limit, before (ms cursor, exclusive), target ('local' | 64-hex
 * public key), user (exact username), from / to (ms, inclusive), and for the
 * unified route `source`.
 *
 * Who sees what, per source, mirrors who may use each console there:
 *   - remote rows (Remote / Companion console, time-sync button, VN relay):
 *     `remote_admin:read`
 *   - local rows (Local Console): `configuration:read`
 * Admins see everything. A caller with neither grant on a source sees nothing
 * from it, and the unified route never names a source the caller cannot read.
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { loadSourcePermissions, type SourcePermissions } from '../utils/sourcePermissions.js';
import {
  CLI_HISTORY_DEFAULT_LIMIT,
  CLI_HISTORY_MAX_LIMIT,
  type MeshCoreCliHistoryQuery,
  type MeshCoreCliHistoryScope,
  type MeshCoreCliTargetKind,
} from '../../db/repositories/meshcoreCliHistory.js';

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;

/** Target kinds a caller may read on one source. */
export function readableCliKinds(perms: SourcePermissions, sourceId: string): MeshCoreCliTargetKind[] {
  const kinds: MeshCoreCliTargetKind[] = [];
  if (perms.can('remote_admin', 'read', sourceId)) kinds.push('remote');
  if (perms.can('configuration', 'read', sourceId)) kinds.push('local');
  return kinds;
}

type ParsedFilters = Omit<MeshCoreCliHistoryQuery, 'scopes' | 'sourceIds'>;

function parseMs(raw: unknown, name: string, res: Response): number | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(n) || n < 0) {
    fail(res, 400, 'INVALID_QUERY', `${name} must be a timestamp in milliseconds`);
    return null;
  }
  return n;
}

/** Read the shared filters. Sends the 400 and returns null on bad input. */
function parseFilters(req: Request, res: Response): ParsedFilters | null {
  const q = req.query;
  const filters: ParsedFilters = {};

  if (q.limit !== undefined) {
    const limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > CLI_HISTORY_MAX_LIMIT) {
      fail(res, 400, 'INVALID_QUERY', `limit must be a whole number between 1 and ${CLI_HISTORY_MAX_LIMIT}`);
      return null;
    }
    filters.limit = limit;
  } else {
    filters.limit = CLI_HISTORY_DEFAULT_LIMIT;
  }

  for (const key of ['before', 'from', 'to'] as const) {
    const v = parseMs(q[key], key, res);
    if (v === null) return null;
    if (v !== undefined) filters[key] = v;
  }

  if (q.target !== undefined && q.target !== '') {
    if (q.target === 'local' || q.target === 'remote') {
      filters.targetKind = q.target;
    } else if (typeof q.target === 'string' && PUBLIC_KEY_RE.test(q.target)) {
      filters.targetKind = 'remote';
      filters.targetPublicKey = q.target.toLowerCase();
    } else {
      fail(res, 400, 'INVALID_QUERY', "target must be 'local', 'remote' or a 64-character public key");
      return null;
    }
  }

  if (q.user !== undefined && q.user !== '') {
    if (typeof q.user !== 'string' || q.user.length > 255) {
      fail(res, 400, 'INVALID_QUERY', 'user must be a username');
      return null;
    }
    filters.username = q.user;
  }
  return filters;
}

/** The cursor for the next page: the oldest timestamp on a full page. */
function nextCursor(rows: Array<{ timestamp: number }>, limit: number): number | null {
  return rows.length === limit ? rows[rows.length - 1].timestamp : null;
}

// ---------------------------------------------------------------------------
// Per-source: mounted under /api/sources/:id/meshcore (data routes).
// ---------------------------------------------------------------------------

export const perSourceCliHistoryRouter = Router({ mergeParams: true });

perSourceCliHistoryRouter.get('/cli-history', requireAuth(), async (req: Request, res: Response) => {
  try {
    const sourceId = String((req.params as { id?: string }).id ?? '');
    const perms = await loadSourcePermissions(req.user);
    const kinds = perms.isAdmin ? (['local', 'remote'] as MeshCoreCliTargetKind[]) : readableCliKinds(perms, sourceId);
    if (kinds.length === 0) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }
    const filters = parseFilters(req, res);
    if (!filters) return;
    const rows = await databaseService.meshcoreCliHistory.list({
      ...filters,
      scopes: [{ sourceId, kinds }],
    });
    return ok(res, { entries: rows, nextBefore: nextCursor(rows, filters.limit!) });
  } catch (error) {
    logger.error('[API] Error reading MeshCore CLI history:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read CLI history');
  }
});

// ---------------------------------------------------------------------------
// Unified: mounted at /api/meshcore/cli-history.
// ---------------------------------------------------------------------------

export const unifiedCliHistoryRouter = Router();

unifiedCliHistoryRouter.get('/', requireAuth(), async (req: Request, res: Response) => {
  try {
    const perms = await loadSourcePermissions(req.user);
    const sources = await databaseService.sources.getAllSources();
    const scopes: MeshCoreCliHistoryScope[] = perms.isAdmin
      ? []
      : sources
        .map(s => ({ sourceId: s.id, kinds: readableCliKinds(perms, s.id) }))
        .filter(s => s.kinds.length > 0);
    if (!perms.isAdmin && scopes.length === 0) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const filters = parseFilters(req, res);
    if (!filters) return;

    let sourceIds: string[] | undefined;
    const rawSource = req.query.source;
    if (rawSource !== undefined && rawSource !== '') {
      if (typeof rawSource !== 'string') {
        return fail(res, 400, 'INVALID_QUERY', 'source must be a source id');
      }
      // A source the caller cannot read yields no rows, the same as an
      // unknown id: the answer never reveals which ids exist.
      sourceIds = [rawSource];
    }

    const rows = await databaseService.meshcoreCliHistory.list({
      ...filters,
      scopes: perms.isAdmin ? 'all' : scopes,
      sourceIds,
    });

    // Name the sources the caller may read, for the filter and the table.
    const visible = perms.isAdmin ? sources : sources.filter(s => scopes.some(sc => sc.sourceId === s.id));
    const meshcoreSources = visible
      .filter(s => s.type === 'meshcore')
      .map(s => ({ id: s.id, name: s.name }));
    return ok(res, {
      entries: rows,
      nextBefore: nextCursor(rows, filters.limit!),
      sources: meshcoreSources,
    });
  } catch (error) {
    logger.error('[API] Error reading unified MeshCore CLI history:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read CLI history');
  }
});
