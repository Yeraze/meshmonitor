/**
 * Message Forwarding routes (#5446) — per-source rules, both protocols.
 *
 * Mounted at `/api/sources/:id/forwarding`. Rules persist as a JSON array in
 * the per-source `forwardingRules` setting; the Meshtastic and MeshCore
 * managers re-read it on every incoming message, so a save takes effect on
 * the next packet. A save never touches the forwarding rate limiter, so
 * editing rules cannot re-open a spent 5-per-minute window.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { validateAutoAckRegex } from '../utils/autoAckRegex.js';
import {
  FORWARDING_SETTING_KEY,
  FORWARDING_MAX_PER_WINDOW,
  FORWARDING_WINDOW_MS,
  FORWARDING_MAX_TEXT_CHARS,
  validateForwardingRules,
} from '../../types/forwarding.js';
import { parseStoredForwardingRules } from '../utils/forwardingEngine.js';

const router = Router({ mergeParams: true });

const limits = {
  maxPerWindow: FORWARDING_MAX_PER_WINDOW,
  windowSeconds: FORWARDING_WINDOW_MS / 1000,
  maxTextChars: FORWARDING_MAX_TEXT_CHARS,
};

router.get(
  '/',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const raw = await databaseService.settings.getSettingForSource(sourceId, FORWARDING_SETTING_KEY);
      return ok(res, { rules: parseStoredForwardingRules(raw), limits });
    } catch (error) {
      logger.error('[API] Error reading forwarding rules:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read forwarding rules');
    }
  },
);

router.post(
  '/',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const v = validateForwardingRules((req.body as { rules?: unknown } | undefined)?.rules);
      if (!v.ok) return fail(res, 400, 'INVALID_FORWARDING_RULES', v.error);
      for (const rule of v.rules) {
        if (!rule.match.textRegex) continue;
        const r = validateAutoAckRegex(rule.match.textRegex);
        if (!r.ok) {
          return fail(res, 400, 'INVALID_FORWARDING_RULES', `rule "${rule.name}": invalid text pattern: ${r.error}`);
        }
      }
      await databaseService.settings.setSourceSetting(sourceId, FORWARDING_SETTING_KEY, JSON.stringify(v.rules));
      return ok(res, { rules: v.rules, limits });
    } catch (error) {
      logger.error('[API] Error saving forwarding rules:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to save forwarding rules');
    }
  },
);

export default router;
