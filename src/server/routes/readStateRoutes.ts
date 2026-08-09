/**
 * Conversation read-state routes (issue #4607).
 *
 * The durable, per-user last-read watermark that the MeshCore unread divider
 * and the jump-to-first-unread entry scroll anchor on. MeshCore messages are
 * not covered by Meshtastic's per-message `read_messages` table, so before
 * this the markers lived in browser localStorage — per-browser, not per-user,
 * which is the wrong shape for an app with real multi-user auth.
 *
 * Mounted at `/api/read-state`. Deliberately NOT under the MeshCore router:
 * the table is conversation-kind-tagged rather than protocol-specific, so a
 * future surface can reuse it without moving the endpoint.
 *
 * Permission: `messages:read` on the source. Writing your own read marker is
 * private bookkeeping, not a mutation of anyone else's data, so the write
 * endpoint carries the same read-level gate rather than `messages:write` —
 * a read-only viewer must still be able to dismiss what they have read.
 */
import express from 'express';
import databaseService from '../../services/database.js';
import { isConversationKind } from '../../db/repositories/conversationReadState.js';
import { optionalAuth, hasPermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/** Resolve the `sourceId` query/body value, or null when absent/malformed. */
function readSourceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `messages:read` on this source. `optionalAuth()` attaches the real
 * `anonymous` DB user when there is no session, so an anonymous-readable
 * deployment resolves through the normal permission path and gets its own
 * (shared) watermark row — the same treatment `read_messages` gives it.
 */
async function canReadSource(req: express.Request, sourceId: string): Promise<boolean> {
  if (req.user?.isAdmin === true) return true;
  if (!req.user) return false;
  return hasPermission(req.user, 'messages', 'read', sourceId);
}

/**
 * GET /api/read-state?sourceId=...
 * All of this user's watermarks on one source, grouped by conversation kind.
 */
router.get('/', optionalAuth(), async (req, res) => {
  const sourceId = readSourceId(req.query.sourceId);
  if (!sourceId) return fail(res, 400, 'SOURCE_ID_REQUIRED', 'sourceId is required');

  try {
    if (!(await canReadSource(req, sourceId))) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }
    const state = await databaseService.getConversationReadStateAsync(req.user?.id ?? null, sourceId);
    return ok(res, state);
  } catch (error) {
    logger.error('Error reading conversation read state:', error);
    return fail(res, 500, 'READ_STATE_FAILED', 'Failed to read conversation read state');
  }
});

/**
 * POST /api/read-state
 * Body: `{ sourceId, kind, conversationKey, lastReadAt }`
 *
 * Moves one conversation's watermark forward. Monotonic on the server, so a
 * late-landing write from a stale tab cannot resurrect dismissed messages.
 * Responds with the effective watermark so the client can reconcile.
 */
router.post('/', optionalAuth(), async (req, res) => {
  const sourceId = readSourceId(req.body?.sourceId);
  if (!sourceId) return fail(res, 400, 'SOURCE_ID_REQUIRED', 'sourceId is required');

  const { kind, conversationKey, lastReadAt } = req.body ?? {};
  if (!isConversationKind(kind)) {
    return fail(res, 400, 'INVALID_CONVERSATION_KIND', 'Unknown conversation kind');
  }
  if (typeof conversationKey !== 'string' || conversationKey.length === 0) {
    return fail(res, 400, 'CONVERSATION_KEY_REQUIRED', 'conversationKey is required');
  }
  if (typeof lastReadAt !== 'number' || !Number.isFinite(lastReadAt) || lastReadAt < 0) {
    return fail(res, 400, 'INVALID_LAST_READ_AT', 'lastReadAt must be a non-negative number');
  }

  try {
    if (!(await canReadSource(req, sourceId))) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }
    const effective = await databaseService.setConversationReadStateAsync(
      req.user?.id ?? null,
      sourceId,
      kind,
      conversationKey,
      lastReadAt
    );
    return ok(res, { lastReadAt: effective });
  } catch (error) {
    logger.error('Error writing conversation read state:', error);
    return fail(res, 500, 'READ_STATE_WRITE_FAILED', 'Failed to write conversation read state');
  }
});

export default router;
