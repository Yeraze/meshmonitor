/**
 * Channel Database — shared request handlers
 *
 * Both `/api/v1/channel-database` (Bearer/token authed via requireAPIToken)
 * and `/api/channel-database` (browser-session authed via optionalAuth)
 * mount these handlers. They MUST stay in sync — the v1 and legacy routers
 * are thin wrappers that just call into this module.
 *
 * Auth contract: callers populate `req.user` before reaching these handlers.
 * Permission checks use the **inline** `databaseService.checkPermissionAsync`
 * pattern (matches `src/server/routes/v1/messages.ts`) — NOT the session-only
 * `requirePermission()` middleware (which would 401 every v1/Bearer caller).
 *
 * Permission model:
 * - `channel_database:read`  → list/get (PSK masked) + retroactive-decrypt progress
 * - `channel_database:write` → create/update/delete/reorder + ACL management
 *   + retroactive-decrypt trigger (which ALSO requires per-source `messages:read`
 *   on every sourceId touched by encrypted packet_log rows — see Step 4)
 */

import { Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { channelDecryptionService } from '../services/channelDecryptionService.js';
import { retroactiveDecryptionService } from '../services/retroactiveDecryptionService.js';
import { expandShorthandPsk } from '../constants/meshtastic.js';
import { logger } from '../../utils/logger.js';

/**
 * Transform a database channel row into the API response shape.
 * PSK is masked unless `includeFullPsk` is true. Callers gate the latter on
 * admin OR `channel_database:write`.
 */
export function transformChannelForResponse(channel: any, includeFullPsk: boolean = false) {
  return {
    id: channel.id,
    name: channel.name,
    pskLength: channel.pskLength,
    pskPreview: includeFullPsk
      ? channel.psk
      : channel.psk
        ? `${channel.psk.substring(0, 8)}...`
        : '(none)',
    psk: includeFullPsk ? channel.psk : undefined,
    description: channel.description,
    isEnabled: channel.isEnabled,
    enforceNameValidation: channel.enforceNameValidation ?? false,
    sortOrder: channel.sortOrder ?? 0,
    decryptedPacketCount: channel.decryptedPacketCount,
    lastDecryptedAt: channel.lastDecryptedAt,
    createdBy: channel.createdBy,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

/** Pull `req.user` and the precomputed `isAdmin` bit. */
function getCaller(req: Request): { user: any; userId: number | null; isAdmin: boolean } {
  const user = (req as any).user;
  return {
    user,
    userId: typeof user?.id === 'number' ? user.id : null,
    isAdmin: user?.isAdmin === true,
  };
}

/**
 * Resolve the caller's read/write scope for channel-database.
 *
 * - Admins: full read + full write.
 * - Non-admins: consult the global `channel_database` permission resource via
 *   `checkPermissionAsync`. Non-admins with `:write` also implicitly have
 *   `:read` (mirrors how RBAC grids generally treat write as a superset).
 *
 * Non-admins with `:read` but no `:write` see entries filtered by per-entry
 * `canRead` from `channel_database_permissions` (the same table consumed by
 * `unifiedRoutes.getUserReadableVirtualChannelIds` and the packet routes).
 */
async function resolveCallerScope(req: Request): Promise<{
  user: any;
  userId: number | null;
  isAdmin: boolean;
  hasRead: boolean;
  hasWrite: boolean;
}> {
  const { user, userId, isAdmin } = getCaller(req);
  if (isAdmin) {
    return { user, userId, isAdmin, hasRead: true, hasWrite: true };
  }
  if (userId === null) {
    return { user, userId, isAdmin, hasRead: false, hasWrite: false };
  }
  const hasWrite = await databaseService.checkPermissionAsync(userId, 'channel_database', 'write');
  const hasRead = hasWrite
    ? true
    : await databaseService.checkPermissionAsync(userId, 'channel_database', 'read');
  return { user, userId, isAdmin, hasRead, hasWrite };
}

/** 403 helper. */
function forbidden(res: Response, message: string) {
  return res.status(403).json({
    success: false,
    error: 'Forbidden',
    message,
  });
}

// ============================================================================
// READ HANDLERS
// ============================================================================

/**
 * GET /
 * Admins + `channel_database:write` callers: full list, full PSK.
 * `channel_database:read` callers: filtered to entries with per-entry
 *   canRead=true, PSK masked.
 * Anyone else: 403.
 */
export async function getAllChannelsHandler(req: Request, res: Response) {
  try {
    const scope = await resolveCallerScope(req);
    if (!scope.hasRead) {
      return forbidden(res, 'channel_database:read permission required');
    }

    const allChannels = await databaseService.channelDatabase.getAllAsync();
    const includeFullPsk = scope.isAdmin || scope.hasWrite;

    let visible = allChannels;
    if (!includeFullPsk) {
      // Filter by per-entry canRead via channel_database_permissions
      const perms = scope.userId !== null
        ? await databaseService.channelDatabase.getPermissionsForUserAsync(scope.userId)
        : [];
      const readable = new Set(
        perms.filter((p: any) => p.canRead === true).map((p: any) => p.channelDatabaseId)
      );
      visible = allChannels.filter((ch: any) => readable.has(ch.id));
    }

    res.json({
      success: true,
      count: visible.length,
      data: visible.map((ch: any) => transformChannelForResponse(ch, includeFullPsk)),
    });
  } catch (error) {
    logger.error('Error getting channel database entries:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel database entries',
    });
  }
}

/** GET /retroactive-decrypt/progress — channel_database:read */
export async function getRetroactiveDecryptProgressHandler(req: Request, res: Response) {
  try {
    const scope = await resolveCallerScope(req);
    if (!scope.hasRead) {
      return forbidden(res, 'channel_database:read permission required');
    }

    res.json({
      success: true,
      isRunning: retroactiveDecryptionService.isRunning(),
      progress: retroactiveDecryptionService.getProgress(),
    });
  } catch (error) {
    logger.error('Error getting retroactive decryption progress:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to get retroactive decryption progress',
    });
  }
}

/** GET /:id — channel_database:read + per-entry canRead for non-writers */
export async function getChannelByIdHandler(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasRead) {
      return forbidden(res, 'channel_database:read permission required');
    }

    const channel = await databaseService.channelDatabase.getByIdAsync(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`,
      });
    }

    const includeFullPsk = scope.isAdmin || scope.hasWrite;

    if (!includeFullPsk) {
      // Non-writers need per-entry canRead=true on this specific channel
      const perm = scope.userId !== null
        ? await databaseService.channelDatabase.getPermissionAsync(scope.userId, id)
        : null;
      if (!perm || perm.canRead !== true) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Channel database entry ${id} not found`,
        });
      }
    }

    res.json({
      success: true,
      data: transformChannelForResponse(channel, includeFullPsk),
    });
  } catch (error) {
    logger.error('Error getting channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel database entry',
    });
  }
}

// ============================================================================
// WRITE HANDLERS
// ============================================================================

/** POST / — channel_database:write */
export async function createChannelHandler(req: Request, res: Response) {
  try {
    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to create channel database entries');
    }

    const { name, psk, pskLength, description, isEnabled, enforceNameValidation } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'name is required and must be a string',
      });
    }

    if (!psk || typeof psk !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'psk is required and must be a Base64-encoded string',
      });
    }

    let finalPskLength: number;
    try {
      const pskBuffer = Buffer.from(psk, 'base64');

      if (pskBuffer.length !== 1 && pskBuffer.length !== 16 && pskBuffer.length !== 32) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'PSK must be 1 byte (shorthand), 16 bytes (AES-128), or 32 bytes (AES-256) when decoded',
        });
      }

      if (!expandShorthandPsk(pskBuffer)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'PSK value 0 means no encryption, which is not supported for channel database',
        });
      }

      finalPskLength = pskBuffer.length;

      if (pskLength !== undefined && pskLength !== finalPskLength) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `pskLength (${pskLength}) does not match actual PSK length (${finalPskLength})`,
        });
      }
    } catch (_err) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'psk must be a valid Base64-encoded string',
      });
    }

    const newChannelId = await databaseService.channelDatabase.createAsync({
      name,
      psk,
      pskLength: finalPskLength,
      description: description ?? null,
      isEnabled: isEnabled ?? true,
      enforceNameValidation: enforceNameValidation ?? false,
      createdBy: scope.user?.id ?? null,
    });

    const newChannel = await databaseService.channelDatabase.getByIdAsync(newChannelId);
    channelDecryptionService.invalidateCache();

    if (newChannelId && (isEnabled ?? true)) {
      retroactiveDecryptionService.processForChannel(newChannelId).catch((err) => {
        logger.warn(`Background retroactive decryption failed for channel ${newChannelId}:`, err);
      });
    }

    logger.debug(`Channel database entry created: "${name}" (id=${newChannelId}) by user ${scope.user?.username ?? 'unknown'}`);

    res.status(201).json({
      success: true,
      data: newChannel ? transformChannelForResponse(newChannel, true) : null,
      message: 'Channel database entry created successfully',
    });
  } catch (error) {
    logger.error('Error creating channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to create channel database entry',
    });
  }
}

/** PUT /reorder — channel_database:write */
export async function reorderChannelsHandler(req: Request, res: Response) {
  try {
    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to reorder channel database entries');
    }

    const { channels } = req.body;

    if (!Array.isArray(channels)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'channels must be an array',
      });
    }

    const updates: { id: number; sortOrder: number }[] = [];
    for (const entry of channels) {
      if (typeof entry.id !== 'number' || !Number.isInteger(entry.id)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Each channel entry must have a numeric id',
        });
      }
      if (typeof entry.sortOrder !== 'number' || !Number.isInteger(entry.sortOrder)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Each channel entry must have a numeric sortOrder',
        });
      }
      updates.push({ id: entry.id, sortOrder: entry.sortOrder });
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'At least one channel entry is required',
      });
    }

    await databaseService.channelDatabase.reorderAsync(updates);
    channelDecryptionService.invalidateCache();

    logger.debug(`Channel database reordered (${updates.length} entries) by user ${scope.user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      message: `Channel database order updated for ${updates.length} entries`,
    });
  } catch (error) {
    logger.error('Error reordering channel database entries:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to reorder channel database entries',
    });
  }
}

/** PUT /:id — channel_database:write */
export async function updateChannelHandler(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to update channel database entries');
    }

    const existing = await databaseService.channelDatabase.getByIdAsync(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`,
      });
    }

    const { name, psk, pskLength, description, isEnabled, enforceNameValidation, sortOrder } = req.body;
    const updates: any = {};

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'name must be a string',
        });
      }
      updates.name = name;
    }

    if (psk !== undefined) {
      if (typeof psk !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'psk must be a Base64-encoded string',
        });
      }
      try {
        const pskBuffer = Buffer.from(psk, 'base64');
        if (pskBuffer.length !== 1 && pskBuffer.length !== 16 && pskBuffer.length !== 32) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'PSK must be 1 byte (shorthand), 16 bytes (AES-128), or 32 bytes (AES-256) when decoded',
          });
        }
        if (!expandShorthandPsk(pskBuffer)) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'PSK value 0 means no encryption, which is not supported for channel database',
          });
        }
        updates.psk = psk;
        updates.pskLength = pskBuffer.length;
      } catch (_err) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'psk must be a valid Base64-encoded string',
        });
      }
    }

    if (pskLength !== undefined && !psk) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'pskLength cannot be changed without also providing psk',
      });
    }

    if (description !== undefined) updates.description = description;
    if (isEnabled !== undefined) updates.isEnabled = Boolean(isEnabled);
    if (enforceNameValidation !== undefined) updates.enforceNameValidation = Boolean(enforceNameValidation);

    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'sortOrder must be an integer',
        });
      }
      updates.sortOrder = sortOrder;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'No valid update fields provided',
      });
    }

    await databaseService.channelDatabase.updateAsync(id, updates);
    channelDecryptionService.invalidateCache();

    if (psk !== undefined && (isEnabled ?? existing.isEnabled)) {
      retroactiveDecryptionService.processForChannel(id).catch((err) => {
        logger.warn(`Background retroactive decryption failed for channel ${id}:`, err);
      });
    }

    const updatedChannel = await databaseService.channelDatabase.getByIdAsync(id);
    logger.debug(`Channel database entry ${id} updated by user ${scope.user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      data: updatedChannel ? transformChannelForResponse(updatedChannel, true) : null,
      message: 'Channel database entry updated successfully',
    });
  } catch (error) {
    logger.error('Error updating channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to update channel database entry',
    });
  }
}

/** DELETE /:id — channel_database:write */
export async function deleteChannelHandler(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to delete channel database entries');
    }

    const existing = await databaseService.channelDatabase.getByIdAsync(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`,
      });
    }

    await databaseService.channelDatabase.deleteAsync(id);
    channelDecryptionService.invalidateCache();

    logger.debug(`Channel database entry ${id} ("${existing.name}") deleted by user ${scope.user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      message: `Channel database entry ${id} deleted successfully`,
    });
  } catch (error) {
    logger.error('Error deleting channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to delete channel database entry',
    });
  }
}

// ============================================================================
// RETROACTIVE DECRYPT (P0 SECURITY GATE)
// ============================================================================

/**
 * POST /:id/retroactive-decrypt
 *
 * Two-stage permission gate:
 * 1. Caller must hold `channel_database:write` (admin OR explicit grant).
 * 2. Caller must hold `messages:read` on EVERY sourceId that has at least
 *    one encrypted, undecrypted packet in `packet_log`.
 *
 * The second check is intentionally conservative — the candidate set
 * includes sources whose packets this channel's PSK would NOT decrypt;
 * we accept false-positive denials to avoid leaking decrypted payloads
 * cross-source. retroactiveDecryptionService.processForChannel() writes
 * decrypted payloads back into packet_log (destructive), so a missed
 * permission check would persistently expose data to any user with
 * packetmonitor:read on the affected source.
 *
 * On denial: returns 403 with `{ deniedSourceIds }` and DOES NOT invoke
 * processForChannel().
 */
export async function triggerRetroactiveDecryptHandler(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to trigger retroactive decryption');
    }

    const existing = await databaseService.channelDatabase.getByIdAsync(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`,
      });
    }

    if (!existing.isEnabled) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Cannot run retroactive decryption for disabled channel',
      });
    }

    // Per-source ACL pre-flight. Admins shortcut through checkPermissionAsync
    // internally so this loop is effectively no-op for them — but we still
    // run it to keep the code path consistent.
    if (!scope.isAdmin && scope.userId !== null) {
      const candidateSourceIds = await databaseService.getDistinctEncryptedPacketSourceIdsAsync();
      const deniedSourceIds: string[] = [];
      for (const sid of candidateSourceIds) {
        const ok = await databaseService.checkPermissionAsync(
          scope.userId,
          'messages',
          'read',
          sid ?? undefined
        );
        if (!ok) {
          deniedSourceIds.push(sid ?? '(legacy-default)');
        }
      }
      if (deniedSourceIds.length > 0) {
        logger.warn(
          `Retroactive decrypt denied for user ${scope.user?.username ?? scope.userId}: ` +
          `lacks messages:read on sources [${deniedSourceIds.join(', ')}]`
        );
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          code: 'FORBIDDEN_SOURCE_SCOPE',
          message: 'You lack messages:read on some sources containing encrypted packets',
          deniedSourceIds,
        });
      }
    }

    // Check if already processing
    if (retroactiveDecryptionService.isRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Retroactive decryption already in progress',
        progress: retroactiveDecryptionService.getProgress(),
      });
    }

    // Start retroactive decryption (don't await - run in background)
    retroactiveDecryptionService.processForChannel(id).catch((err) => {
      logger.error(`Retroactive decryption failed for channel ${id}:`, err);
    });

    res.json({
      success: true,
      message: `Retroactive decryption started for channel ${id}`,
      progress: retroactiveDecryptionService.getProgress(),
    });
  } catch (error) {
    logger.error('Error triggering retroactive decryption:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to trigger retroactive decryption',
    });
  }
}

// ============================================================================
// PERMISSION-MANAGEMENT HANDLERS (ACL editing — channel_database:write)
// ============================================================================

/** GET /:id/permissions — channel_database:write (managing ACL == write) */
export async function getChannelPermissionsHandler(req: Request, res: Response) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to view channel permissions');
    }

    const channel = await databaseService.channelDatabase.getByIdAsync(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`,
      });
    }

    const permissions = await databaseService.channelDatabase.getPermissionsForChannelAsync(id);

    res.json({
      success: true,
      channelId: id,
      channelName: channel.name,
      count: permissions.length,
      data: permissions.map((p: any) => ({
        userId: p.userId,
        canViewOnMap: p.canViewOnMap,
        canRead: p.canRead,
        grantedBy: p.grantedBy,
        grantedAt: p.grantedAt,
      })),
    });
  } catch (error) {
    logger.error('Error getting channel database permissions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel database permissions',
    });
  }
}

/** PUT /:id/permissions/:userId — channel_database:write */
export async function setChannelPermissionHandler(req: Request, res: Response) {
  try {
    const channelId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);

    if (isNaN(channelId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }
    if (isNaN(targetUserId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid user ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to modify channel permissions');
    }

    const channel = await databaseService.channelDatabase.getByIdAsync(channelId);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${channelId} not found`,
      });
    }

    const targetUser = await databaseService.findUserByIdAsync(targetUserId);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `User ${targetUserId} not found`,
      });
    }

    const { canViewOnMap, canRead } = req.body;
    if (typeof canViewOnMap !== 'boolean' || typeof canRead !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'canViewOnMap and canRead are required and must be boolean values',
      });
    }

    await databaseService.channelDatabase.setPermissionAsync({
      userId: targetUserId,
      channelDatabaseId: channelId,
      canViewOnMap,
      canRead,
      grantedBy: scope.user?.id ?? null,
    });

    logger.debug(
      `Channel database permission set: user ${targetUserId} on channel ${channelId} ` +
      `(viewOnMap=${canViewOnMap}, read=${canRead}) by ${scope.user?.username ?? 'unknown'}`
    );

    res.json({
      success: true,
      message: `Permission updated for user ${targetUserId} on channel ${channelId}`,
      data: {
        userId: targetUserId,
        channelDatabaseId: channelId,
        canViewOnMap,
        canRead,
      },
    });
  } catch (error) {
    logger.error('Error setting channel database permission:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to set channel database permission',
    });
  }
}

/** DELETE /:id/permissions/:userId — channel_database:write */
export async function deleteChannelPermissionHandler(req: Request, res: Response) {
  try {
    const channelId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);

    if (isNaN(channelId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID',
      });
    }
    if (isNaN(targetUserId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid user ID',
      });
    }

    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to modify channel permissions');
    }

    const channel = await databaseService.channelDatabase.getByIdAsync(channelId);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${channelId} not found`,
      });
    }

    await databaseService.channelDatabase.deletePermissionAsync(targetUserId, channelId);

    logger.debug(
      `Channel database permission deleted: user ${targetUserId} on channel ${channelId} by ${scope.user?.username ?? 'unknown'}`
    );

    res.json({
      success: true,
      message: `Permission removed for user ${targetUserId} on channel ${channelId}`,
    });
  } catch (error) {
    logger.error('Error deleting channel database permission:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to delete channel database permission',
    });
  }
}
