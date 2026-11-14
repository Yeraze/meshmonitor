/**
 * Network survey API (#4726)
 *
 * Mounted at `/api/sources/:id/survey` (`Router({ mergeParams: true })`).
 *
 * Read-only and passive: the survey is synthesized from records already on
 * disk and emits no radio traffic, so this is a plain `nodes:read` surface
 * with no TX guard — there is nothing here to guard. If an active-scan mode is
 * ever added it must be a SEPARATE endpoint with its own permission and
 * TX-disabled check, not a query parameter on this one, so that "survey the
 * mesh" can never silently start transmitting.
 */
import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { buildNetworkSurvey, clampWindowHours } from '../services/networkSurveyService.js';
import { loadMqttConsentHiddenSet } from '../utils/mqttConsentVisibility.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/sources/:id/survey?hours=24
 *
 * `hours` is clamped rather than rejected: this is a dashboard control, and a
 * silently sane window beats a 400 on a stray value.
 */
router.get(
  '/',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const windowHours = clampWindowHours(req.query.hours);
      const survey = await buildNetworkSurvey(sourceId, windowHours);
      // #5156: an anonymous caller loses consent-hidden nodes from the named
      // neighbour list. The node and hop totals are counts and stay as built.
      const hidden = await loadMqttConsentHiddenSet(req.user, [sourceId]);
      survey.directNeighbours = survey.directNeighbours.filter((n) => !hidden.hides(sourceId, n.nodeNum));
      ok(res, survey);
    } catch (error) {
      logger.error('[API] Error building network survey:', error);
      fail(res, 500, 'NETWORK_SURVEY_FAILED', 'Failed to build network survey');
    }
  },
);

export default router;
