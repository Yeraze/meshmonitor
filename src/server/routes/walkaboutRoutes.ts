/**
 * Walkabout Coverage routes (#5891, Phase 1). Spec: WALKABOUT_P1_SPEC.md §2.8.
 *
 * Mounted at `/api/sources/:id/walkabout` (`mergeParams`). A walkabout is a
 * person's GPS trail, so every route needs a login and a per-source grant.
 * Every session lookup is by `(params.id, sessionId)`: a session on another
 * source is a 404. P1 returns counts only, never coordinates or node lists.
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  walkaboutService,
  WalkaboutError,
  toWalkaboutSessionDto,
} from '../services/walkaboutService.js';
import {
  WALKABOUT_READ_GRANT,
  WALKABOUT_WRITE_GRANT,
  WALKABOUT_MAX_SAMPLES_PER_POST,
  WALKABOUT_NAME_MAX,
  WALKABOUT_LIST_LIMIT,
  WALKABOUT_MAP_WINDOWS_MS,
  WALKABOUT_MAX_RANGE_MS,
  isWalkaboutLive,
} from '../../utils/walkabout.js';
import type {
  WalkaboutH3Res,
  WalkaboutMapQuery,
  WalkaboutMapWindow,
  WalkaboutSampleInput,
} from '../../types/walkabout.js';
import { parseSenderParam } from '../utils/coverageSenderParam.js';
import { parseWalkaboutCell } from '../utils/walkaboutH3.js';
import { getWalkaboutCellNodes, getWalkaboutCells, getWalkaboutTrack } from '../services/walkaboutCells.js';

const router = Router({ mergeParams: true });

const sourceOpts = { sourceIdFrom: 'params.id', requireSourceId: true } as const;
const canRead = [
  requireAuth(),
  requirePermission(WALKABOUT_READ_GRANT.resource, WALKABOUT_READ_GRANT.action, sourceOpts),
];
const canWrite = [
  requireAuth(),
  requirePermission(WALKABOUT_WRITE_GRANT.resource, WALKABOUT_WRITE_GRANT.action, sourceOpts),
];

const sourceOf = (req: Request): string => String(req.params.id);
const userIdOf = (req: Request): number | null => req.user?.id ?? null;
const sessionOf = (req: Request): string => String(req.params.sessionId);

function notFound(res: Response): Response {
  return fail(res, 404, 'WALKABOUT_NOT_FOUND', 'Walkabout session not found');
}

const STATUS: Record<string, number> = {
  WALKABOUT_ALREADY_LIVE: 409,
  WALKABOUT_NOT_LIVE: 409,
  WALKABOUT_NOT_OWNER: 403,
  WALKABOUT_SOURCE_UNSUPPORTED: 400,
  WALKABOUT_NOT_FOUND: 404,
};

/** Map a service error to the envelope; anything else is a 500. */
function handleError(res: Response, err: unknown, what: string): Response {
  if (err instanceof WalkaboutError) {
    return fail(res, STATUS[err.code] ?? 400, err.code, err.message, err.extra);
  }
  logger.error(`[Walkabout] ${what} failed:`, err);
  return fail(res, 500, 'INTERNAL_ERROR', `Failed to ${what}`);
}

// Sanity bounds only; the service drops stale and inaccurate fixes with its own tighter limits.
const MAX_ACCURACY_BOUND_M = 100_000;
const MAX_AGE_BOUND_MS = 3_600_000;
const MAX_FIX_SKEW_MS = 24 * 3_600_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Shape + range check for a post body; returns null when valid. */
function validateSamples(body: unknown, now: number = Date.now()): string | null {
  const samples = (body as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > WALKABOUT_MAX_SAMPLES_PER_POST) {
    return `samples must hold 1 to ${WALKABOUT_MAX_SAMPLES_PER_POST} entries`;
  }
  for (const s of samples as Array<Partial<WalkaboutSampleInput> | null>) {
    if (!s || typeof s !== 'object') return 'each sample must be an object';
    if (!isNum(s.latitude) || s.latitude < -90 || s.latitude > 90) return 'latitude out of range';
    if (!isNum(s.longitude) || s.longitude < -180 || s.longitude > 180) return 'longitude out of range';
    if (!isNum(s.accuracyM) || s.accuracyM < 0 || s.accuracyM > MAX_ACCURACY_BOUND_M) {
      return 'accuracyM must be a number from 0 to 100000';
    }
    if (!isNum(s.deviceFixAt) || s.deviceFixAt <= 0 || Math.abs(s.deviceFixAt - now) > MAX_FIX_SKEW_MS) {
      return 'deviceFixAt must be a timestamp within a day of now';
    }
    if (!isNum(s.ageMs) || s.ageMs < 0 || s.ageMs > MAX_AGE_BOUND_MS) {
      return 'ageMs must be a number from 0 to one hour';
    }
  }
  return null;
}

router.get('/sessions', ...canRead, async (req: Request, res: Response) => {
  try {
    const rows = await databaseService.coverageWalkabout.listSessions(sourceOf(req), WALKABOUT_LIST_LIMIT);
    const now = Date.now();
    const uid = userIdOf(req);
    const sessions = rows.map((r) =>
      toWalkaboutSessionDto(
        r,
        { samples: r.sampleCount, receptions: r.receptionCount, nodes: r.nodeCount, lastSampleAt: r.lastSampleAt },
        uid,
        now,
      ),
    );
    return ok(res, { sessions });
  } catch (err) {
    return handleError(res, err, 'list walkabout sessions');
  }
});

// Declared before `/:sessionId` so "live" is not read as an id.
router.get('/sessions/live', ...canRead, async (req: Request, res: Response) => {
  try {
    const sourceId = sourceOf(req);
    const repo = databaseService.coverageWalkabout;
    // ensureLoaded adopts a DB-open session the live map missed and ends one past its cap.
    const open = await walkaboutService.ensureLoaded(sourceId);
    const now = Date.now();
    if (!open || !isWalkaboutLive(open, now)) return ok(res, { session: null, skipped: null });
    const counts = await repo.getCounts(sourceId, open.id);
    return ok(res, {
      session: toWalkaboutSessionDto(open, counts, userIdOf(req), now),
      skipped: walkaboutService.getSkipped(sourceId, open.id),
    });
  } catch (err) {
    return handleError(res, err, 'read the live walkabout');
  }
});

router.get('/sessions/:sessionId', ...canRead, async (req: Request, res: Response) => {
  try {
    const sourceId = sourceOf(req);
    const repo = databaseService.coverageWalkabout;
    const row = await repo.getSession(sourceId, sessionOf(req));
    if (!row) return notFound(res);
    const now = Date.now();
    const counts = await repo.getCounts(sourceId, row.id);
    const live = isWalkaboutLive(row, now);
    return ok(res, {
      session: toWalkaboutSessionDto(row, counts, userIdOf(req), now),
      skipped: live ? walkaboutService.getSkipped(sourceId, row.id) : null,
    });
  } catch (err) {
    return handleError(res, err, 'read the walkabout session');
  }
});

router.post('/sessions', ...canWrite, async (req: Request, res: Response) => {
  try {
    const rawName = (req.body as { name?: unknown } | undefined)?.name;
    if (rawName !== undefined && rawName !== null) {
      if (typeof rawName !== 'string' || rawName.trim().length > WALKABOUT_NAME_MAX) {
        return fail(res, 400, 'INVALID_WALKABOUT', `name must be text of at most ${WALKABOUT_NAME_MAX} characters`);
      }
    }
    const sourceId = sourceOf(req);
    const uid = userIdOf(req);
    const row = await walkaboutService.startSession(sourceId, uid, typeof rawName === 'string' ? rawName : null);
    logger.info(`[Walkabout] user ${uid} started session ${row.id} on source ${sourceId}`);
    const counts = await databaseService.coverageWalkabout.getCounts(sourceId, row.id);
    return ok(res, { session: toWalkaboutSessionDto(row, counts, uid) });
  } catch (err) {
    return handleError(res, err, 'start a walkabout');
  }
});

router.post('/sessions/:sessionId/samples', ...canWrite, async (req: Request, res: Response) => {
  try {
    const uid = userIdOf(req);
    if (uid == null) return fail(res, 403, 'WALKABOUT_NOT_OWNER', 'Only the user who started a walkabout can post samples');
    const bad = validateSamples(req.body);
    if (bad) return fail(res, 400, 'INVALID_WALKABOUT', bad);
    const sourceId = sourceOf(req);
    const sessionId = sessionOf(req);
    const row = await databaseService.coverageWalkabout.getSession(sourceId, sessionId);
    if (!row) return notFound(res);
    if (!isWalkaboutLive(row, Date.now())) {
      return fail(res, 409, 'WALKABOUT_NOT_LIVE', 'This walkabout has ended', {
        endedAt: row.endedAt,
        endReason: row.endReason,
      });
    }
    const result = await walkaboutService.addSamples(
      sourceId,
      sessionId,
      uid,
      (req.body as { samples: WalkaboutSampleInput[] }).samples,
    );
    return ok(res, result);
  } catch (err) {
    if (err instanceof WalkaboutError && err.code === 'WALKABOUT_NOT_LIVE') {
      const row = await databaseService.coverageWalkabout
        .getSession(sourceOf(req), sessionOf(req))
        .catch(() => null);
      return fail(res, 409, err.code, err.message, { endedAt: row?.endedAt ?? null, endReason: row?.endReason ?? null });
    }
    return handleError(res, err, 'record walkabout samples');
  }
});

router.post('/sessions/:sessionId/stop', ...canWrite, async (req: Request, res: Response) => {
  try {
    const sourceId = sourceOf(req);
    const sessionId = sessionOf(req);
    const before = await databaseService.coverageWalkabout.getSession(sourceId, sessionId);
    if (!before) return notFound(res);
    const wasLive = isWalkaboutLive(before, Date.now());
    const row = await walkaboutService.stopSession(sourceId, sessionId);
    if (!row) return notFound(res);
    if (!wasLive) {
      return fail(res, 409, 'WALKABOUT_NOT_LIVE', 'This walkabout has already ended', {
        endedAt: row.endedAt,
        endReason: row.endReason,
      });
    }
    logger.info(`[Walkabout] user ${userIdOf(req)} stopped session ${sessionId} on source ${sourceId}`);
    const counts = await databaseService.coverageWalkabout.getCounts(sourceId, sessionId);
    return ok(res, { session: toWalkaboutSessionDto(row, counts, userIdOf(req)) });
  } catch (err) {
    return handleError(res, err, 'stop the walkabout');
  }
});

router.delete('/sessions/:sessionId', ...canWrite, async (req: Request, res: Response) => {
  try {
    const sourceId = sourceOf(req);
    const sessionId = sessionOf(req);
    const row = await databaseService.coverageWalkabout.getSession(sourceId, sessionId);
    if (!row) return notFound(res);
    if (isWalkaboutLive(row, Date.now())) {
      return fail(res, 409, 'WALKABOUT_LIVE_SESSION', 'Stop this walkabout before deleting it');
    }
    // Open but past its cap: close it as 'cap' first, then delete.
    if (row.endedAt == null) await walkaboutService.stopSession(sourceId, sessionId);
    const removed = await walkaboutService.deleteSession(sourceId, sessionId);
    if (!removed) return notFound(res);
    logger.info(`[Walkabout] user ${userIdOf(req)} deleted session ${sessionId} on source ${sourceId}`);
    return ok(res);
  } catch (err) {
    return handleError(res, err, 'delete the walkabout');
  }
});

// --- Phase 2: map reads (WALKABOUT_P2_SPEC.md §2.8). Every route needs a login:
// a cell id is a position the public-instance redactor does not recognise.

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INT_RE = /^\d{1,16}$/;

function badWalkabout(res: Response, message: string): Response {
  return fail(res, 400, 'INVALID_WALKABOUT', message);
}

/** Exactly one mode: sessionId | window | since+until. `node` narrows to one credited node. */
function parseMapQuery(req: Request): { q: WalkaboutMapQuery } | { error: string } {
  const { sessionId, window, since, until, node } = req.query as Record<string, unknown>;
  const modes = [sessionId !== undefined, window !== undefined, since !== undefined || until !== undefined];
  if (modes.filter(Boolean).length !== 1) {
    return { error: 'Give exactly one of sessionId, window, or since and until' };
  }
  let nodeId: string | undefined;
  if (node !== undefined) {
    const parsed = parseSenderParam(node);
    if (!parsed) return { error: 'node must be a !hex id, a decimal node number or a 64-hex public key' };
    nodeId = parsed;
  }
  const withNode = nodeId !== undefined ? { node: nodeId } : {};
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { error: 'sessionId is not valid' };
    return { q: { kind: 'session', sessionId, ...withNode } };
  }
  if (window !== undefined) {
    if (typeof window !== 'string' || !Object.prototype.hasOwnProperty.call(WALKABOUT_MAP_WINDOWS_MS, window)) {
      return { error: 'window must be 24h, 7d, 14d or 30d' };
    }
    return { q: { kind: 'window', window: window as WalkaboutMapWindow, ...withNode } };
  }
  if (typeof since !== 'string' || typeof until !== 'string' || !INT_RE.test(since) || !INT_RE.test(until)) {
    return { error: 'since and until must both be integer milliseconds' };
  }
  const sinceMs = Number(since);
  const untilMs = Number(until);
  if (sinceMs > untilMs) return { error: 'since must not be after until' };
  if (untilMs - sinceMs > WALKABOUT_MAX_RANGE_MS) return { error: 'range is longer than 31 days' };
  return { q: { kind: 'range', sinceMs, untilMs, ...withNode } };
}

router.get('/cells', ...canRead, async (req: Request, res: Response) => {
  try {
    const parsed = parseMapQuery(req);
    if ('error' in parsed) return badWalkabout(res, parsed.error);
    const rawRes = req.query.res;
    let h3res: WalkaboutH3Res = 9;
    if (rawRes !== undefined) {
      if (rawRes !== '7' && rawRes !== '8' && rawRes !== '9') return badWalkabout(res, 'res must be 7, 8 or 9');
      h3res = Number(rawRes) as WalkaboutH3Res;
    }
    const data = await getWalkaboutCells(req.user, sourceOf(req), parsed.q, h3res);
    return data ? ok(res, data) : notFound(res);
  } catch (err) {
    return handleError(res, err, 'read walkabout cells');
  }
});

router.get('/cell-nodes', ...canRead, async (req: Request, res: Response) => {
  try {
    const parsed = parseMapQuery(req);
    if ('error' in parsed) return badWalkabout(res, parsed.error);
    const cell = parseWalkaboutCell(req.query.cell);
    if (!cell) return badWalkabout(res, 'cell must be an H3 index at resolution 7 to 9');
    const data = await getWalkaboutCellNodes(req.user, sourceOf(req), parsed.q, cell.cell, cell.res);
    return data ? ok(res, data) : notFound(res);
  } catch (err) {
    return handleError(res, err, 'read walkabout cell nodes');
  }
});

router.get('/sessions/:sessionId/track', ...canRead, async (req: Request, res: Response) => {
  try {
    const data = await getWalkaboutTrack(sourceOf(req), sessionOf(req));
    return data ? ok(res, data) : notFound(res);
  } catch (err) {
    return handleError(res, err, 'read the walkabout track');
  }
});

export default router;
