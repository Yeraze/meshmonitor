/**
 * Coverage Report saved-survey API (#5277 Coverage Report epic, Phase 4b
 * WP2). Mounted by `coverageRoutes.ts` at `/surveys`
 * (`/api/analysis/coverage/surveys`), inheriting that router's
 * `router.use(optionalAuth())` — so `req.user` is always set (a real user,
 * or the seeded `anonymous` row — see `isAnonymousUser` below), and GET
 * needs no extra gate while every write route layers `requireAuth()` on
 * top.
 *
 * See `docs/internal/dev-notes/COVERAGE_P4_SPEC.md` §2b.5 for the route
 * table and §2b.1-§2b.4 for why the table is global and what it stores.
 *
 * Talks to `databaseService.coverageSurveys` (`CoverageSurveysRepository`,
 * `src/db/repositories/coverageSurveys.ts`, WP1). `DbCoverageSurvey` /
 * `CreateCoverageSurveyParams` / `UpdateCoverageSurveyPatch` are imported
 * from there rather than redeclared here.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds } from '../utils/permittedSources.js';
import {
  buildPositionFilter, loadNodesBySource,
  buildMeshCorePositionFilter, loadMeshCoreNodesBySource,
} from '../utils/positionVisibility.js';
import { parseGatewayNodeNum } from '../utils/okToMqtt.js';
import { parseSenderParam } from '../utils/coverageSenderParam.js';
import { isMeshCorePubKeyId } from '../../utils/coverage.js';
import {
  COVERAGE_SURVEY_LIVE_MAX_MS,
  COVERAGE_SURVEY_MAX_RANGE_MS,
  COVERAGE_SURVEY_MAX_PER_USER,
  COVERAGE_SURVEY_MAX_TOTAL,
  effectiveSurveyEndAt,
} from '../../utils/coverage.js';
import { parseReceiverFilter } from '../../utils/coverageReceiverFilter.js';
import type { CoverageSurveyDto, CreateCoverageSurveyBody, UpdateCoverageSurveyBody } from '../../types/coverage.js';
import type {
  DbCoverageSurvey,
  CreateCoverageSurveyParams,
  UpdateCoverageSurveyPatch,
} from '../../db/repositories/coverageSurveys.js';

const router = Router();

// ── Shared helpers ───────────────────────────────────────────────────────

/**
 * `optionalAuth()` always sets `req.user` (a real user, or the seeded
 * `anonymous` DB row — see `authMiddleware.ts`), so "not logged in" is never
 * `req.user === undefined` here. Mirrors the established
 * `!user || user.username === 'anonymous'` check used elsewhere
 * (`geojsonRoutes.ts`, `userPreferencesRoutes.ts`).
 */
function isAnonymousUser(user: Request['user']): boolean {
  return !user || user.username === 'anonymous';
}

/**
 * "Live" for the one-live-survey-per-sender gate and the stop route: `endAt`
 * still null AND the 24 h auto-end cap (read-time, no timer — spec §2b.8)
 * hasn't passed. A survey whose `endAt` is null but whose cap already
 * elapsed is no longer live (it just hasn't been explicitly stopped yet).
 */
function isSurveyLive(s: { startAt: number; endAt: number | null }, nowMs: number): boolean {
  return s.endAt === null && nowMs < s.startAt + COVERAGE_SURVEY_LIVE_MAX_MS;
}

/** DTO builder (spec §2b.5): adds `effectiveEndAt`/`isLive`/`canEdit`/`createdByMe`; `createdBy` itself is never exposed. */
function toSurveyDto(s: DbCoverageSurvey, user: Request['user'], nowMs: number): CoverageSurveyDto {
  const isAdmin = !!user?.isAdmin;
  const createdByMe = !isAnonymousUser(user) && s.createdBy === user!.id;
  return {
    id: s.id,
    name: s.name,
    senderId: s.senderId,
    startAt: s.startAt,
    endAt: s.endAt,
    receivers: s.receivers,
    intervalSec: s.intervalSec,
    notes: s.notes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    effectiveEndAt: effectiveSurveyEndAt(s, nowMs),
    isLive: isSurveyLive(s, nowMs),
    canEdit: isAdmin || createdByMe,
    createdByMe,
  };
}

interface SenderVisibilityCheckers {
  isVisible(senderId: string): boolean;
}

/**
 * The same "/senders visibility" gate as spec §2b.5 requires: Meshtastic via
 * `buildPositionFilter` keyed on `(sourceId, nodeNum)` over nodes that exist
 * on that source, MeshCore via `buildMeshCorePositionFilter` keyed on
 * `(sourceId, publicKey)` — never a `source.type` string gate (branches on
 * the sender id's own shape via `isMeshCorePubKeyId`, matching
 * `coverageRoutes.ts`'s convention). "Visible" means visible on AT LEAST ONE
 * of `permittedSourceIds`.
 */
async function buildSenderVisibilityCheckers(
  req: Request,
  permittedSourceIds: string[],
): Promise<SenderVisibilityCheckers> {
  const [nodesBySource, mcNodesBySource] = await Promise.all([
    loadNodesBySource(permittedSourceIds),
    loadMeshCoreNodesBySource(permittedSourceIds),
  ]);
  const [posFilter, mcFilter] = await Promise.all([
    buildPositionFilter(req.user, permittedSourceIds, nodesBySource),
    buildMeshCorePositionFilter(req.user, permittedSourceIds, mcNodesBySource),
  ]);
  return {
    isVisible(senderId: string): boolean {
      if (isMeshCorePubKeyId(senderId)) {
        return permittedSourceIds.some((sourceId) => mcFilter({ sourceId, publicKey: senderId }));
      }
      const nodeNum = parseGatewayNodeNum(senderId);
      if (nodeNum === null) return false;
      return permittedSourceIds.some((sourceId) => posFilter({ sourceId, nodeNum }));
    },
  };
}

function auditIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ── GET / (list) ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    if (isAnonymousUser(req.user)) {
      return ok(res, [] as CoverageSurveyDto[]);
    }

    const nowMs = Date.now();
    const surveys: DbCoverageSurvey[] = await databaseService.coverageSurveys.listSurveys();

    let visible: DbCoverageSurvey[];
    if (req.user!.isAdmin) {
      visible = surveys;
    } else {
      const permittedSourceIds = await resolvePermittedSourceIds(req);
      const checkers = await buildSenderVisibilityCheckers(req, permittedSourceIds);
      visible = surveys.filter((s) => s.createdBy === req.user!.id || checkers.isVisible(s.senderId));
    }

    ok(res, visible.map((s) => toSurveyDto(s, req.user, nowMs)));
  } catch (error) {
    logger.error('Error in GET /api/analysis/coverage/surveys:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch coverage surveys');
  }
});

// ── POST / (create) ─────────────────────────────────────────────────────

router.post('/', requireAuth(), async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Partial<CreateCoverageSurveyBody>;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120) {
      return fail(res, 400, 'INVALID_SURVEY', 'name must be between 1 and 120 characters');
    }

    const senderId = parseSenderParam(body.senderId);
    if (senderId === null) {
      return fail(
        res, 400, 'INVALID_SURVEY',
        'senderId must be a !hex node id, a decimal node number, or a 64-hex MeshCore public key',
      );
    }

    const nowMs = Date.now();
    let startAt: number;
    let endAt: number | null;
    if (body.live) {
      startAt = nowMs;
      endAt = null;
    } else {
      if (
        typeof body.startAt !== 'number' || !Number.isFinite(body.startAt) ||
        typeof body.endAt !== 'number' || !Number.isFinite(body.endAt)
      ) {
        return fail(res, 400, 'INVALID_SURVEY', 'startAt and endAt are required unix-ms numbers unless live');
      }
      startAt = body.startAt;
      endAt = body.endAt;
      if (endAt < startAt) {
        return fail(res, 400, 'INVALID_SURVEY', 'endAt must not be before startAt');
      }
      if (endAt > nowMs + 60_000) {
        return fail(res, 400, 'INVALID_SURVEY', 'endAt must not be in the future');
      }
      if (endAt - startAt > COVERAGE_SURVEY_MAX_RANGE_MS) {
        return fail(res, 400, 'INVALID_SURVEY', `range must not exceed ${COVERAGE_SURVEY_MAX_RANGE_MS}ms`);
      }
    }

    let receivers: string | null = null;
    if (body.receivers != null) {
      if (typeof body.receivers !== 'string') {
        return fail(res, 400, 'INVALID_RECEIVERS', 'receivers must be a string');
      }
      if (body.receivers.trim() !== '') {
        if (parseReceiverFilter(body.receivers) === null) {
          return fail(res, 400, 'INVALID_RECEIVERS', 'receivers is malformed');
        }
        receivers = body.receivers;
      }
    }

    let intervalSec: number | null = null;
    if (body.intervalSec != null) {
      const n = Number(body.intervalSec);
      if (!Number.isInteger(n) || n < 15 || n > 3600) {
        return fail(res, 400, 'INVALID_SURVEY', 'intervalSec must be an integer between 15 and 3600');
      }
      intervalSec = n;
    }

    let notes: string | null = null;
    if (body.notes != null) {
      if (typeof body.notes !== 'string') {
        return fail(res, 400, 'INVALID_SURVEY', 'notes must be a string');
      }
      if (body.notes.length > 2000) {
        return fail(res, 400, 'INVALID_SURVEY', 'notes must be at most 2000 characters');
      }
      notes = body.notes;
    }

    // Sender visibility gate — non-admins only (spec §2b.5).
    if (!req.user!.isAdmin) {
      const permittedSourceIds = await resolvePermittedSourceIds(req);
      const checkers = await buildSenderVisibilityCheckers(req, permittedSourceIds);
      if (!checkers.isVisible(senderId)) {
        return fail(res, 403, 'SENDER_NOT_VISIBLE', 'Sender is not visible to you');
      }
    }

    // One live survey per sender. Application-level (check-then-insert), not
    // a DB constraint — a partial unique index (`WHERE endAt IS NULL`) isn't
    // portable to MySQL, which this project also supports. Two simultaneous
    // POSTs for the same sender can both pass this check and both insert, so
    // the invariant is best-effort, not guaranteed. Worst case is a duplicate
    // live survey for one sender (visible/stoppable/deletable like any
    // other); no data loss.
    if (endAt === null) {
      const liveExisting = await databaseService.coverageSurveys.getLiveSurveyForSender(senderId, nowMs);
      if (liveExisting) {
        return fail(res, 409, 'SURVEY_ALREADY_LIVE', 'A live survey already exists for this sender');
      }
    }

    // Caps (spec §2b.8 / U4).
    const [totalCount, userCount] = await Promise.all([
      databaseService.coverageSurveys.countSurveys(),
      databaseService.coverageSurveys.countSurveysByUser(req.user!.id),
    ]);
    if (totalCount >= COVERAGE_SURVEY_MAX_TOTAL) {
      return fail(res, 409, 'SURVEY_LIMIT_REACHED', `Total survey limit (${COVERAGE_SURVEY_MAX_TOTAL}) reached`);
    }
    if (userCount >= COVERAGE_SURVEY_MAX_PER_USER) {
      return fail(res, 409, 'SURVEY_LIMIT_REACHED', `Per-user survey limit (${COVERAGE_SURVEY_MAX_PER_USER}) reached`);
    }

    const created: DbCoverageSurvey = await databaseService.coverageSurveys.createSurvey({
      name, senderId, startAt, endAt, receivers, intervalSec, notes, createdBy: req.user!.id,
    } satisfies CreateCoverageSurveyParams);

    void databaseService.auditLogAsync(
      req.user!.id,
      'coverage_survey_created',
      'coverage_survey',
      JSON.stringify({ id: created.id, senderId, live: endAt === null }),
      auditIp(req),
    );

    ok(res, toSurveyDto(created, req.user, nowMs));
  } catch (error) {
    logger.error('Error in POST /api/analysis/coverage/surveys:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to create coverage survey');
  }
});

// ── PATCH /:id (edit) ────────────────────────────────────────────────────

router.patch('/:id', requireAuth(), async (req: Request, res: Response) => {
  try {
    const survey: DbCoverageSurvey | null = await databaseService.coverageSurveys.getSurvey(req.params.id);
    if (!survey) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');
    if (!req.user!.isAdmin && survey.createdBy !== req.user!.id) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const body = (req.body ?? {}) as Partial<UpdateCoverageSurveyBody>;
    const patch: UpdateCoverageSurveyPatch = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < 1 || name.length > 120) {
        return fail(res, 400, 'INVALID_SURVEY', 'name must be between 1 and 120 characters');
      }
      patch.name = name;
    }

    if (body.notes !== undefined) {
      if (body.notes !== null) {
        if (typeof body.notes !== 'string') {
          return fail(res, 400, 'INVALID_SURVEY', 'notes must be a string or null');
        }
        if (body.notes.length > 2000) {
          return fail(res, 400, 'INVALID_SURVEY', 'notes must be at most 2000 characters');
        }
      }
      patch.notes = body.notes;
    }

    if (body.intervalSec !== undefined) {
      if (body.intervalSec !== null) {
        const n = Number(body.intervalSec);
        if (!Number.isInteger(n) || n < 15 || n > 3600) {
          return fail(res, 400, 'INVALID_SURVEY', 'intervalSec must be an integer between 15 and 3600');
        }
        patch.intervalSec = n;
      } else {
        patch.intervalSec = null;
      }
    }

    if (body.receivers !== undefined) {
      if (body.receivers !== null && body.receivers.trim() !== '') {
        if (typeof body.receivers !== 'string') {
          return fail(res, 400, 'INVALID_RECEIVERS', 'receivers must be a string or null');
        }
        if (parseReceiverFilter(body.receivers) === null) {
          return fail(res, 400, 'INVALID_RECEIVERS', 'receivers is malformed');
        }
        patch.receivers = body.receivers;
      } else {
        patch.receivers = null;
      }
    }

    const updated = await databaseService.coverageSurveys.updateSurvey(req.params.id, patch);
    if (!updated) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');

    const finalRow: DbCoverageSurvey | null = await databaseService.coverageSurveys.getSurvey(req.params.id);
    if (!finalRow) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');
    ok(res, toSurveyDto(finalRow, req.user, Date.now()));
  } catch (error) {
    logger.error('Error in PATCH /api/analysis/coverage/surveys/:id:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to update coverage survey');
  }
});

// ── POST /:id/stop ───────────────────────────────────────────────────────

router.post('/:id/stop', requireAuth(), async (req: Request, res: Response) => {
  try {
    const survey: DbCoverageSurvey | null = await databaseService.coverageSurveys.getSurvey(req.params.id);
    if (!survey) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');
    if (!req.user!.isAdmin && survey.createdBy !== req.user!.id) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const nowMs = Date.now();
    if (!isSurveyLive(survey, nowMs)) {
      return fail(res, 409, 'SURVEY_NOT_LIVE', 'Survey is not live');
    }

    const endAt = Math.min(nowMs, survey.startAt + COVERAGE_SURVEY_LIVE_MAX_MS);
    const updated = await databaseService.coverageSurveys.updateSurvey(req.params.id, { endAt });
    if (!updated) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');

    void databaseService.auditLogAsync(
      req.user!.id,
      'coverage_survey_stopped',
      'coverage_survey',
      JSON.stringify({ id: survey.id }),
      auditIp(req),
    );

    const finalRow: DbCoverageSurvey | null = await databaseService.coverageSurveys.getSurvey(req.params.id);
    if (!finalRow) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');
    ok(res, toSurveyDto(finalRow, req.user, nowMs));
  } catch (error) {
    logger.error('Error in POST /api/analysis/coverage/surveys/:id/stop:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to stop coverage survey');
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────

router.delete('/:id', requireAuth(), async (req: Request, res: Response) => {
  try {
    const survey: DbCoverageSurvey | null = await databaseService.coverageSurveys.getSurvey(req.params.id);
    if (!survey) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');
    if (!req.user!.isAdmin && survey.createdBy !== req.user!.id) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const deleted = await databaseService.coverageSurveys.deleteSurvey(req.params.id);
    if (!deleted) return fail(res, 404, 'SURVEY_NOT_FOUND', 'Survey not found');

    void databaseService.auditLogAsync(
      req.user!.id,
      'coverage_survey_deleted',
      'coverage_survey',
      JSON.stringify({ id: survey.id }),
      auditIp(req),
    );

    ok(res);
  } catch (error) {
    logger.error('Error in DELETE /api/analysis/coverage/surveys/:id:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to delete coverage survey');
  }
});

export default router;
