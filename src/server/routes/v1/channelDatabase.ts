/**
 * v1 API - Channel Database Endpoint
 *
 * Provides CRUD operations for the server-side channel database.
 * This enables MeshMonitor to store channel configurations beyond the device's 8 slots
 * and decrypt packets server-side using stored keys.
 *
 * This file is a THIN router — all handler logic lives in
 * `src/server/routes/_channelDatabaseHandlers.ts` so the v1 (Bearer-token)
 * and legacy (browser-session) mounts stay in sync.
 *
 * Auth: `requireAPIToken()` (Bearer-only) is applied upstream in
 * `src/server/routes/v1/index.ts`. Per-endpoint permission checks happen
 * inline inside each handler — using `checkPermissionAsync` rather than
 * the session-only `requirePermission()` middleware so that token-only
 * callers (which never have `req.session.userId`) are honored.
 */

import express from 'express';
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
} from '../_channelDatabaseHandlers.js';

const router = express.Router();

// IMPORTANT: order matters for /retroactive-decrypt/progress, /reorder — both
// must be defined before the `:id` and `:id/...` matches to avoid being shadowed.
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
