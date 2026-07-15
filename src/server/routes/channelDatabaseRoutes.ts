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
 * Auth: read endpoints (`GET /`, `GET /:id`) use `optionalAuth()` so an
 * anonymous — but real, permissioned — account can list/read the virtual
 * channels it holds per-entry `canRead` on (the handlers enforce that access
 * and mask PSKs). Mutations and the admin-only retroactive-decrypt progress
 * require a real authenticated session via `requireAuth()`. Per-endpoint
 * permission checks happen inline inside each handler.
 *
 * NOTE: do NOT delete this file or its mount in `server.ts`. The UI is
 * session-authed; v1 is Bearer-only. Both mounts must remain reachable
 * until the UI is migrated to v1 + Bearer tokens (deferred to a future PR).
 */

import express from 'express';
import { requireAuth, optionalAuth } from '../auth/authMiddleware.js';
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

// IMPORTANT: order matters — /retroactive-decrypt/progress and /reorder must
// be defined before the `:id` and `:id/...` matches to avoid being shadowed.
//
// Read routes use optionalAuth (anonymous may hold per-entry canRead grants);
// every mutating/admin route requires a real authenticated session.
router.get('/', optionalAuth(), getAllChannelsHandler);
router.get('/retroactive-decrypt/progress', requireAuth(), getRetroactiveDecryptProgressHandler);
router.get('/:id', optionalAuth(), getChannelByIdHandler);
router.post('/', requireAuth(), createChannelHandler);
router.put('/reorder', requireAuth(), reorderChannelsHandler);
router.put('/:id', requireAuth(), updateChannelHandler);
router.delete('/:id', requireAuth(), deleteChannelHandler);
router.post('/:id/retroactive-decrypt', requireAuth(), triggerRetroactiveDecryptHandler);

// Permission-management endpoints (channel_database:write)
router.get('/:id/permissions', requireAuth(), getChannelPermissionsHandler);
router.put('/:id/permissions/:userId', requireAuth(), setChannelPermissionHandler);
router.delete('/:id/permissions/:userId', requireAuth(), deleteChannelPermissionHandler);

export default router;
