/**
 * Channel Database Routes (Session-based)
 *
 * Provides CRUD operations for the server-side channel database.
 * Used by the browser UI via `src/services/api.ts:1367-1457`.
 *
 * This file is a THIN router — all handler logic lives in
 * `_channelDatabaseHandlers.ts` so the v1 (Bearer-token) and legacy
 * (browser-session) mounts stay in sync.
 *
 * Auth: `requireAuth()` (browser session) is applied below; per-endpoint
 * permission checks happen inline inside each handler.
 *
 * NOTE: do NOT delete this file or its mount in `server.ts`. The UI is
 * session-authed; v1 is Bearer-only. Both mounts must remain reachable
 * until the UI is migrated to v1 + Bearer tokens (deferred to a future PR).
 */

import express from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  getAllChannelsHandler,
  getRetroactiveDecryptProgressHandler,
  getChannelByIdHandler,
  createChannelHandler,
  reorderChannelsHandler,
  updateChannelHandler,
  deleteChannelHandler,
  triggerRetroactiveDecryptHandler,
  getChannelPermissionsHandler,
  setChannelPermissionHandler,
  deleteChannelPermissionHandler,
} from './_channelDatabaseHandlers.js';

const router = express.Router();

// All routes require authentication
router.use(requireAuth());

// IMPORTANT: order matters — /retroactive-decrypt/progress and /reorder must
// be defined before the `:id` and `:id/...` matches to avoid being shadowed.
router.get('/', getAllChannelsHandler);
router.get('/retroactive-decrypt/progress', getRetroactiveDecryptProgressHandler);
router.get('/:id', getChannelByIdHandler);
router.post('/', createChannelHandler);
router.put('/reorder', reorderChannelsHandler);
router.put('/:id', updateChannelHandler);
router.delete('/:id', deleteChannelHandler);
router.post('/:id/retroactive-decrypt', triggerRetroactiveDecryptHandler);

// Permission-management endpoints (channel_database:write)
router.get('/:id/permissions', getChannelPermissionsHandler);
router.put('/:id/permissions/:userId', setChannelPermissionHandler);
router.delete('/:id/permissions/:userId', deleteChannelPermissionHandler);

export default router;
