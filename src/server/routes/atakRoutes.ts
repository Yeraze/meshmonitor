/**
 * ATAK Contacts API Routes (ATAK/CoT Phase 2, issue #3691)
 *
 * Mounted under `/api/sources/:id/atak` (`Router({ mergeParams: true })` so
 * `req.params.id` is always present). Serves the per-source `atak_contacts`
 * table populated by the PLI branch of `meshtasticManager.processTakPacket`.
 *
 * Deliberately does NOT check the source's type/liveness (mirrors
 * `mqttPacketRoutes.ts`): a non-Meshtastic or disconnected source simply has
 * no rows. Permission reuses the existing per-source `nodes:read` grant
 * rather than a new resource — ATAK contacts are node-like map entities
 * shown alongside nodes and gated by the same map-data read grant (see
 * docs/internal/dev-notes/ATAK_COT_PHASE2_SPEC.md §1 "Permission").
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { ATAK_CONTACT_STALE_MS } from '../services/atakContactService.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/sources/:id/atak/contacts
 *
 * All ATAK contacts for this source, newest-`lastSeen`-first, decorated with
 * a `stale` flag (no fresh PLI within `ATAK_CONTACT_STALE_MS`).
 */
router.get(
  '/contacts',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const rows = await databaseService.atakContacts.getContacts(sourceId);
      const now = Date.now();
      const contacts = rows.map((row) => ({
        ...row,
        stale: now - row.lastSeen > ATAK_CONTACT_STALE_MS,
      }));
      ok(res, contacts);
    } catch (error) {
      logger.error('[API] Error fetching ATAK contacts:', error);
      fail(res, 500, 'ATAK_CONTACTS_FETCH_FAILED', 'Failed to fetch ATAK contacts');
    }
  },
);

export default router;
