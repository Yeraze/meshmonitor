/**
 * MeshCore API Routes — messaging group
 *
 * Message history (list/channel/counts/delete variants), send, and room
 * server login/post/sync-config. Extracted verbatim from the former
 * monolithic `meshcoreRoutes.ts` (epic #3962 Task 4.3).
 *
 * Within-group source order is load-bearing: `/messages/:messageId` stays
 * AFTER `/messages/channel/*` and `/messages/conversation/*` so the more
 * specific two-segment paths win the route match first.
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter, messageLimiter } from '../middleware/rateLimiters.js';
import { getMeshCoreCredentialStore } from '../services/meshcoreCredentialStore.js';
import { managerFor, VALIDATION, isValidPublicKey, isValidMessage, auditMeshcoreEvent } from './meshcoreRouteShared.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/meshcore/messages
 * Get recent messages. Optional ?since=<ms-timestamp> returns only messages newer than that time.
 */
router.get('/messages', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    let limit = parseInt(req.query.limit as string || '50', 10);
    // Validate and clamp limit to reasonable bounds
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    } else if (limit > VALIDATION.MAX_MESSAGE_LIMIT) {
      limit = VALIDATION.MAX_MESSAGE_LIMIT;
    }
    const sinceRaw = req.query.since as string | undefined;
    const since = sinceRaw ? parseInt(sinceRaw, 10) : undefined;
    let messages = managerFor(req, res).getRecentMessages(limit);
    if (since !== undefined && !isNaN(since)) {
      messages = messages.filter(m => m.timestamp > since);
    }
    res.json({
      success: true,
      data: messages,
      count: messages.length,
    });
  } catch (error) {
    logger.error('[API] Error getting messages:', error);
    res.status(500).json({ success: false, error: 'Failed to get messages' });
  }
});

/**
 * GET /api/meshcore/messages/channel/:idx
 * Per-channel message backlog. Unlike /messages (a global recent-tail shared by
 * every channel and DM), this returns just channel :idx's history — so a busy
 * channel can't push another channel's messages out of the visible window.
 */
router.get('/messages/channel/:idx', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ success: false, error: 'idx must be a non-negative integer' });
    }
    let limit = parseInt(req.query.limit as string || '100', 10);
    if (isNaN(limit) || limit < 1) {
      limit = 100;
    } else if (limit > VALIDATION.MAX_MESSAGE_LIMIT) {
      limit = VALIDATION.MAX_MESSAGE_LIMIT;
    }
    const messages = await managerFor(req, res).getChannelMessages(idx, limit);
    res.json({
      success: true,
      data: messages,
      count: messages.length,
    });
  } catch (error) {
    logger.error('[API] Error getting channel messages:', error);
    res.status(500).json({ success: false, error: 'Failed to get channel messages' });
  }
});

/**
 * GET /api/meshcore/messages/channel-counts?channels=0,1,2
 * Total persisted message count per channel index, for the channel-list badges.
 * Accurate per channel (not the capped in-memory pool). Also returns the latest
 * message timestamp per channel (`latestTimestamps`) for the unread indicator
 * (#3703) — channels with no messages are omitted from that map.
 */
router.get('/messages/channel-counts', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const raw = (req.query.channels as string | undefined) ?? '';
    const indices = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0);
    // De-dupe and cap to a sane number of channels per request.
    const unique = Array.from(new Set(indices)).slice(0, 64);
    const manager = managerFor(req, res);
    const [counts, latestTimestamps] = unique.length > 0
      ? await Promise.all([
          manager.getChannelMessageCounts(unique),
          manager.getChannelLatestTimestamps(unique),
        ])
      : [{}, {}];
    res.json({ success: true, counts, latestTimestamps });
  } catch (error) {
    logger.error('[API] Error getting channel message counts:', error);
    res.status(500).json({ success: false, error: 'Failed to get channel message counts' });
  }
});

/**
 * DELETE /api/sources/:id/meshcore/messages
 * Purge EVERY MeshCore message (channel + DM) for this source (#3981). The
 * MeshCore analogue of the Meshtastic "purge all messages" admin action.
 * Scoped to `:id` via requirePermission — never touches other sources.
 */
router.delete('/messages', requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const deletedCount = await managerFor(req, res).purgeAllMessages();
    auditMeshcoreEvent(req, 'meshcore_messages_purged', 'messages', {
      sourceId: req.params.id,
      deletedCount,
    });
    res.json({ success: true, message: 'All MeshCore messages purged', deletedCount });
  } catch (error) {
    logger.error('[API] Error purging MeshCore messages:', error);
    res.status(500).json({ success: false, error: 'Failed to purge messages' });
  }
});

/**
 * DELETE /api/sources/:id/meshcore/messages/channel/:idx
 * Clear every message on a channel index for this source (#3981). Registered
 * before /messages/:id so the two-segment path wins the route match.
 */
router.delete('/messages/channel/:idx', requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ success: false, error: 'idx must be a non-negative integer' });
    }
    const deletedCount = await managerFor(req, res).purgeChannelMessages(idx);
    auditMeshcoreEvent(req, 'meshcore_channel_messages_cleared', 'messages', {
      sourceId: req.params.id,
      channelIdx: idx,
      deletedCount,
    });
    res.json({ success: true, message: 'Channel messages cleared', channelIdx: idx, deletedCount });
  } catch (error) {
    logger.error('[API] Error clearing MeshCore channel messages:', error);
    res.status(500).json({ success: false, error: 'Failed to clear channel messages' });
  }
});

/**
 * DELETE /api/sources/:id/meshcore/messages/conversation/:publicKey
 * Clear a whole DM conversation for this source (#3981). `publicKey` may be a
 * pubkey prefix or full 64-hex key; the manager resolves the id set with the
 * same prefix match the UI uses. Registered before /messages/:id.
 */
router.delete('/messages/conversation/:publicKey', requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const publicKey = String(req.params.publicKey || '').toLowerCase();
    if (!/^[0-9a-f]{2,64}$/.test(publicKey)) {
      return res.status(400).json({ success: false, error: 'publicKey must be a hex string' });
    }
    const deletedCount = await managerFor(req, res).purgeConversation(publicKey);
    auditMeshcoreEvent(req, 'meshcore_dm_conversation_cleared', 'messages', {
      sourceId: req.params.id,
      publicKey,
      deletedCount,
    });
    res.json({ success: true, message: 'Conversation cleared', publicKey, deletedCount });
  } catch (error) {
    logger.error('[API] Error clearing MeshCore conversation:', error);
    res.status(500).json({ success: false, error: 'Failed to clear conversation' });
  }
});

/**
 * DELETE /api/sources/:id/meshcore/messages/:messageId
 * Delete a single MeshCore message by id, scoped to this source (#3981).
 * NB: the path param is `:messageId`, NOT `:id` — the router is mounted under
 * `/api/sources/:id/meshcore`, so a `:id` here would shadow the source id in
 * `req.params.id` (breaking manager lookup and permission scoping).
 */
router.delete('/messages/:messageId', requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId || '');
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'message id is required' });
    }
    const deleted = await managerFor(req, res).deleteStoredMessage(messageId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    auditMeshcoreEvent(req, 'meshcore_message_deleted', 'messages', {
      sourceId: req.params.id,
      messageId,
    });
    res.json({ success: true, message: 'Message deleted', id: messageId });
  } catch (error) {
    logger.error('[API] Error deleting MeshCore message:', error);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

/**
 * POST /api/meshcore/messages/send
 * Send a message
 * Requires authentication - sends data over mesh network
 */
router.post('/messages/send', messageLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { text, toPublicKey, channelIdx, scope } = req.body;

    // Determine per-context byte limit before validating the message.
    // DM (toPublicKey present) → 150 bytes.
    // Channel with scope → 120 bytes. Channel without scope → 130 bytes.
    let msgMaxBytes: number;
    if (toPublicKey !== undefined && toPublicKey !== null && toPublicKey !== '') {
      msgMaxBytes = VALIDATION.MAX_MESSAGE_BYTES_DM;
    } else {
      const hasScope = typeof scope === 'string' && scope.trim().length > 0;
      msgMaxBytes = hasScope
        ? VALIDATION.MAX_MESSAGE_BYTES_CHANNEL_SCOPED
        : VALIDATION.MAX_MESSAGE_BYTES_CHANNEL;
    }

    // Validate message text using the context-appropriate byte limit.
    const textValidation = isValidMessage(text, msgMaxBytes);
    if (!textValidation.valid) {
      return res.status(400).json({ success: false, error: textValidation.error });
    }

    // Validate public key if provided (for direct messages)
    if (toPublicKey !== undefined && toPublicKey !== null && toPublicKey !== '') {
      if (!isValidPublicKey(toPublicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
      }
    }

    // Validate optional channelIdx (broadcast on a specific channel).
    let parsedChannelIdx: number | undefined;
    if (channelIdx !== undefined && channelIdx !== null) {
      const n = Number(channelIdx);
      if (!Number.isInteger(n) || n < 0 || n > 255) {
        return res.status(400).json({ success: false, error: 'channelIdx must be an integer between 0 and 255' });
      }
      parsedChannelIdx = n;
    }

    // Optional per-message scope/region override (#3701). Contract (#3704
    // review — kept unambiguous and matching normalizeScopeOverride):
    //   - key ABSENT (`undefined`) OR JSON `null` ⇒ NO override; the manager
    //     resolves the channel/default scope as usual. We collapse both to
    //     `undefined` here so "no override" has a single representation.
    //   - `''` (or whitespace/punctuation-only) ⇒ explicit UNSCOPED for this
    //     one send only.
    //   - a non-empty string ⇒ a one-off region override for this send only.
    // The override is NEVER persisted to the channel; the next normal send
    // re-asserts the channel/default scope. The manager normalises the value
    // leniently (strip '#', keep letters/digits/hyphens, warn on stripped
    // chars). Here we only reject wrong types / over-length up front so a
    // malformed body can't silently change scoping.
    let scopeOverride: string | undefined;
    if (scope !== undefined && scope !== null) {
      if (typeof scope !== 'string') {
        return res.status(400).json({ success: false, error: 'scope must be a string' });
      }
      if (scope.length > 63) {
        return res.status(400).json({ success: false, error: 'scope must be 63 characters or fewer' });
      }
      scopeOverride = scope;
    }

    const success = await managerFor(req, res).sendMessage(text, toPublicKey, parsedChannelIdx, scopeOverride);

    if (success) {
      res.json({ success: true, message: 'Message sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send message' });
    }
  } catch (error) {
    logger.error('[API] Error sending message:', error);
    res.status(500).json({ success: false, error: 'Send error' });
  }
});

// ============ Room Server Endpoints ============

/**
 * GET /api/meshcore/rooms/servers
 * List discovered room servers (advType=3) with login state.
 */
router.get('/rooms/servers', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req, res);
    const rooms = manager.getRoomServers();
    const result = rooms.map(r => ({
      publicKey: r.publicKey,
      advName: r.advName,
      name: r.name,
      lastSeen: r.lastSeen,
      rssi: r.rssi,
      snr: r.snr,
      loggedIn: manager.isRoomLoggedIn(r.publicKey),
    }));
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[API] Error listing room servers:', error);
    res.status(500).json({ success: false, error: 'Failed to list room servers' });
  }
});

/**
 * POST /api/meshcore/rooms/login
 * Login to a room server to receive posts and (if permitted) submit new ones.
 * Body: { publicKey: string, password: string, rememberPassword?: boolean }
 *   - `password` may be empty for guest/read-only access.
 *   - `rememberPassword: true` persists the password (AES-256-GCM via credential store).
 */
router.post('/rooms/login', meshcoreDeviceLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, password, rememberPassword } = req.body as {
      publicKey?: string;
      password?: string;
      rememberPassword?: boolean;
    };

    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    if (typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'password (string) required; may be empty for guest login' });
    }

    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();

    if (rememberPassword && !store.capability.canRemember) {
      return res.status(400).json({
        success: false,
        error: 'Saving credentials is disabled',
        reason: store.capability.reason,
        code: 'CREDENTIAL_PERSISTENCE_DISABLED',
      });
    }

    const success = await managerFor(req, res).loginToRoom(publicKey, password);
    if (!success) {
      return res.status(401).json({ success: false, error: 'Room login failed' });
    }

    if (rememberPassword) {
      try {
        await store.storeRoom(sourceId, publicKey, password);
      } catch (err) {
        logger.warn('[API] Room login succeeded but credential persistence failed:', err);
        return res.json({ success: true, message: 'Room login successful, but saving the password failed', persisted: false });
      }
      return res.json({ success: true, message: 'Room login successful', persisted: true });
    }

    res.json({ success: true, message: 'Room login successful', persisted: false });
  } catch (error) {
    logger.error('[API] Error logging into room:', error);
    res.status(500).json({ success: false, error: 'Room login error' });
  }
});

/**
 * POST /api/meshcore/rooms/login-with-saved
 * Login to a room server using a previously saved credential.
 * Body: { publicKey: string }
 */
router.post('/rooms/login-with-saved', meshcoreDeviceLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.body as { publicKey?: string };
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format' });
    }

    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const result = await store.loadRoom(sourceId, publicKey);

    if (result.kind === 'none') {
      return res.status(404).json({ success: false, error: 'No saved room credential', code: 'NO_STORED_CREDENTIAL' });
    }
    if (result.kind === 'key_rotated') {
      return res.status(409).json({ success: false, error: 'Saved credential was encrypted with a different key', code: 'CREDENTIAL_KEY_ROTATED' });
    }

    const success = await managerFor(req, res).loginToRoom(publicKey, result.password);
    if (!success) {
      return res.status(401).json({ success: false, error: 'Saved credential rejected by room server', code: 'STORED_CREDENTIAL_REJECTED' });
    }
    res.json({ success: true, usedStored: true });
  } catch (error) {
    logger.error('[API] Error logging into room with saved credential:', error);
    res.status(500).json({ success: false, error: 'Room login error' });
  }
});

/**
 * GET /api/meshcore/rooms/credentials
 * List room servers with saved credentials for this source.
 */
router.get('/rooms/credentials', requireAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const stored = await store.listStoredRoom(sourceId);
    res.json({
      success: true,
      canRemember: store.capability.canRemember,
      reason: store.capability.reason,
      stored,
    });
  } catch (error) {
    logger.error('[API] Error listing room credentials:', error);
    res.status(500).json({ success: false, error: 'Failed to list room credentials' });
  }
});

/**
 * POST /api/meshcore/rooms/post
 * Send a text post to a room server.
 * Body: { roomPublicKey: string, text: string }
 */
router.post('/rooms/post', messageLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { roomPublicKey, text } = req.body as {
      roomPublicKey?: string;
      text?: string;
    };

    if (typeof roomPublicKey !== 'string' || !isValidPublicKey(roomPublicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid roomPublicKey format (expected 64-character hex string)' });
    }
    const textValidation = isValidMessage(text);
    if (!textValidation.valid) {
      return res.status(400).json({ success: false, error: textValidation.error });
    }

    const success = await managerFor(req, res).sendRoomPost(text!, roomPublicKey);
    if (success) {
      res.json({ success: true, message: 'Room post sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send room post' });
    }
  } catch (error) {
    logger.error('[API] Error sending room post:', error);
    res.status(500).json({ success: false, error: 'Room post error' });
  }
});

/**
 * GET /api/meshcore/rooms/sync-config?publicKey=...
 * Retrieve the current room sync configuration for a room server.
 */
router.get('/rooms/sync-config', requireAuth(), requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const publicKey = req.query.publicKey as string | undefined;
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format' });
    }
    const sourceId = req.params.id!;
    const config = await databaseService.meshcore.getRoomSyncConfig(sourceId, publicKey);
    if (!config) {
      return res.json({ success: true, enabled: false, intervalMinutes: 60 });
    }
    res.json({ success: true, enabled: config.enabled, intervalMinutes: config.intervalMinutes });
  } catch (error) {
    logger.error('[API] Error getting room sync config:', error);
    res.status(500).json({ success: false, error: 'Failed to get room sync config' });
  }
});

/**
 * PATCH /api/meshcore/rooms/sync-config
 * Configure periodic room sync for a room server.
 * Body: { publicKey: string, enabled: boolean, intervalMinutes?: number }
 *   - `intervalMinutes` must be >= 60. Defaults to 60.
 */
router.patch('/rooms/sync-config', requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, enabled, intervalMinutes } = req.body as {
      publicKey?: string;
      enabled?: boolean;
      intervalMinutes?: number;
    };
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled (boolean) required' });
    }
    const interval = intervalMinutes ?? 60;
    if (!Number.isInteger(interval) || interval < 60 || interval > 1440) {
      return res.status(400).json({ success: false, error: 'intervalMinutes must be 60-1440' });
    }

    const sourceId = req.params.id!;
    await databaseService.meshcore.setRoomSyncConfig(sourceId, publicKey, {
      roomSyncEnabled: enabled,
      roomSyncIntervalMinutes: interval,
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('[API] Error setting room sync config:', error);
    res.status(500).json({ success: false, error: 'Failed to set room sync config' });
  }
});

export default router;
