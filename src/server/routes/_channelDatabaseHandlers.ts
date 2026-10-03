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
import { ok, fail } from '../utils/apiResponse.js';
import { meshcoreSecretHex } from '../../db/repositories/channelDatabase.js';
import { deriveHashtagSecretHex, isHashtagChannelName } from '../../utils/meshcoreHelpers.js';
import type { ChannelDatabaseProtocol } from '../../db/types.js';

/** MeshCore channel secrets are AES-128: 16 bytes. */
const MESHCORE_SECRET_BYTES = 16;

/**
 * Resolve the secret for a MeshCore virtual channel (#5552). Meshtastic PSK
 * rules (1-byte shorthand, name hashing) do NOT apply here.
 *
 * - `psk` given: 32 hex chars or base64 of exactly 16 bytes.
 * - `psk` absent and the name starts with `#`: the hashtag-room derivation,
 *   SHA-256(name)[0..16], as the MeshCore apps do.
 *
 * Returns the secret as lowercase hex, or an error message.
 */
async function resolveMeshcoreSecret(
  name: string,
  psk: unknown,
): Promise<{ secretHex: string } | { error: string }> {
  if (psk === undefined || psk === null || psk === '') {
    if (!isHashtagChannelName(name)) {
      return { error: 'A MeshCore channel needs a 16-byte secret, unless its name starts with # (a hashtag channel derives it from the name)' };
    }
    return { secretHex: await deriveHashtagSecretHex(name) };
  }
  if (typeof psk !== 'string') return { error: 'psk must be a string' };
  const trimmed = psk.trim();
  const secretHex = /^[0-9a-fA-F]+$/.test(trimmed)
    ? (trimmed.length === MESHCORE_SECRET_BYTES * 2 ? trimmed.toLowerCase() : null)
    : (() => {
        try {
          const buf = Buffer.from(trimmed, 'base64');
          // Reject strings base64 would silently truncate or pad.
          return buf.length === MESHCORE_SECRET_BYTES && buf.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')
            ? buf.toString('hex')
            : null;
        } catch {
          return null;
        }
      })();
  if (!secretHex) {
    return { error: 'A MeshCore channel secret must be 16 bytes: 32 hex characters or Base64' };
  }
  if (/^0+$/.test(secretHex)) return { error: 'A MeshCore channel secret cannot be all zeros' };
  return { secretHex };
}

const secretHexToBase64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

function parseProtocolFilter(raw: unknown): ChannelDatabaseProtocol | 'all' | null {
  if (raw === undefined || raw === '') return 'meshtastic';
  return raw === 'meshtastic' || raw === 'meshcore' || raw === 'all' ? raw : null;
}

/**
 * Transform a database channel row into the API response shape.
 * PSK is masked unless `includeFullPsk` is true. Callers gate the latter on
 * admin OR `channel_database:write`.
 */
export function transformChannelForResponse(channel: any, includeFullPsk: boolean = false) {
  return {
    id: channel.id,
    name: channel.name,
    // 'meshtastic' or 'meshcore' (#5552).
    protocol: channel.protocol === 'meshcore' ? 'meshcore' : 'meshtastic',
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
    const includeFullPsk = scope.isAdmin || scope.hasWrite;
    // #5552: Meshtastic rows only unless the caller asks. Every existing
    // consumer of this list treats an entry as a Meshtastic virtual channel
    // (CHANNEL_DB_OFFSET + id), so MeshCore rows are opt-in.
    const protocol = parseProtocolFilter(req.query.protocol);
    if (protocol === null) {
      return fail(res, 400, 'INVALID_PROTOCOL', 'protocol must be meshtastic, meshcore or all');
    }
    const allChannels = await databaseService.channelDatabase.getAllAsync(protocol);

    let visible = allChannels;
    if (!includeFullPsk) {
      // Filter by per-entry canRead via channel_database_permissions.
      const perms = scope.userId !== null
        ? await databaseService.channelDatabase.getPermissionsForUserAsync(scope.userId, protocol)
        : [];
      const readable = new Set(
        perms.filter((p: any) => p.canRead === true).map((p: any) => p.channelDatabaseId)
      );
      // A per-entry `canRead` grant is sufficient on its own to list the
      // (PSK-masked) entry. The "Virtual Channel Permissions" UI writes only
      // these per-entry grants, and MQTT channel access is defined entirely by
      // them, so requiring the separate resource-level `channel_database:read`
      // here would silently turn every such grant into a no-op. Only 403 when
      // the caller has neither the resource read nor any per-entry grant.
      if (!scope.hasRead && readable.size === 0) {
        return forbidden(res, 'channel_database:read permission required');
      }
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
    // No resource-level `channel_database:read` gate here: consistent with the
    // list endpoint, a per-entry `canRead` grant on this specific entry is
    // sufficient to read it (the "Virtual Channel Permissions" UI writes only
    // those per-entry grants). Non-writers without a canRead row fall through to
    // the 404 below, which also masks the entry's existence.

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

    const { name, psk, pskLength, description, isEnabled, enforceNameValidation, protocol } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'name is required and must be a string',
      });
    }

    if (protocol !== undefined && protocol !== 'meshtastic' && protocol !== 'meshcore') {
      return fail(res, 400, 'INVALID_PROTOCOL', 'protocol must be meshtastic or meshcore');
    }

    if (protocol === 'meshcore') {
      // MeshCore virtual channel (#5552). None of the Meshtastic PSK / name
      // hash rules below apply, and there is no packet_log to re-decrypt.
      const trimmedName = name.trim();
      if (!trimmedName) return fail(res, 400, 'INVALID_NAME', 'name is required');
      const resolved = await resolveMeshcoreSecret(trimmedName, psk);
      if ('error' in resolved) return fail(res, 400, 'INVALID_SECRET', resolved.error);
      // One row per secret: MeshCore identifies a channel by its key.
      const duplicate = await databaseService.channelDatabase.getMeshcoreBySecretAsync(resolved.secretHex);
      if (duplicate) {
        return fail(res, 409, 'DUPLICATE_SECRET', `This secret is already stored as "${duplicate.name}"`, {
          existingId: duplicate.id,
        });
      }
      const id = await databaseService.channelDatabase.createAsync({
        name: trimmedName,
        psk: secretHexToBase64(resolved.secretHex),
        pskLength: MESHCORE_SECRET_BYTES,
        protocol: 'meshcore',
        description: description ?? null,
        isEnabled: isEnabled ?? true,
        enforceNameValidation: false,
        createdBy: scope.user?.id ?? null,
      });
      const created = await databaseService.channelDatabase.getByIdAsync(id);
      logger.debug(`MeshCore virtual channel created (id=${id}) by user ${scope.user?.username ?? 'unknown'}`);
      return res.status(201).json({
        success: true,
        data: created ? transformChannelForResponse(created, true) : null,
        message: 'Channel database entry created successfully',
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

    const isMeshcore = existing.protocol === 'meshcore';
    if (isMeshcore && psk !== undefined) {
      // MeshCore secret rules, and still one row per secret (#5552).
      const resolved = await resolveMeshcoreSecret(typeof name === 'string' ? name.trim() : existing.name, psk);
      if ('error' in resolved) return fail(res, 400, 'INVALID_SECRET', resolved.error);
      const duplicate = await databaseService.channelDatabase.getMeshcoreBySecretAsync(resolved.secretHex);
      if (duplicate && duplicate.id !== id) {
        return fail(res, 409, 'DUPLICATE_SECRET', `This secret is already stored as "${duplicate.name}"`, {
          existingId: duplicate.id,
        });
      }
      updates.psk = secretHexToBase64(resolved.secretHex);
      updates.pskLength = MESHCORE_SECRET_BYTES;
    } else if (psk !== undefined) {
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
    // Name validation is a Meshtastic channel-hash check; it has no meaning
    // for a MeshCore row.
    if (enforceNameValidation !== undefined && !isMeshcore) updates.enforceNameValidation = Boolean(enforceNameValidation);

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

    if (!isMeshcore && psk !== undefined && (isEnabled ?? existing.isEnabled)) {
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

/**
 * POST /import-meshcore — channel_database:write (#5552)
 *
 * Copy the channels of ONE MeshCore source into channel_database as MeshCore
 * virtual channels. Opt-in and one-shot: nothing mirrors a device on its own,
 * and a later change or delete on the device never touches these rows.
 *
 * A channel whose secret is already stored is skipped (one row per secret). New
 * rows get no user grants, so only admins can read their traffic until someone
 * assigns access. Secrets stay server-side: the response carries counts and
 * names only.
 */
export async function importMeshcoreChannelsHandler(req: Request, res: Response) {
  try {
    const scope = await resolveCallerScope(req);
    if (!scope.hasWrite) {
      return forbidden(res, 'channel_database:write permission required to import channels');
    }
    const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId : '';
    if (!sourceId) return fail(res, 400, 'SOURCE_ID_REQUIRED', 'sourceId is required');
    const source = await databaseService.sources.getSource(sourceId);
    if (!source) return fail(res, 404, 'SOURCE_NOT_FOUND', 'Source not found');
    if (source.type !== 'meshcore') {
      return fail(res, 400, 'NOT_MESHCORE_SOURCE', 'Channels can only be imported from a MeshCore device source');
    }

    const deviceChannels = await databaseService.channels.getAllChannels(sourceId);
    const imported: Array<{ id: number; name: string }> = [];
    const skipped: Array<{ name: string; reason: 'duplicate' | 'no_secret' }> = [];
    for (const ch of deviceChannels) {
      const name = (ch.name ?? '').trim() || `Channel ${ch.id}`;
      const secretHex = meshcoreSecretHex(ch.psk);
      if (!secretHex || secretHex.length !== MESHCORE_SECRET_BYTES * 2 || /^0+$/.test(secretHex)) {
        skipped.push({ name, reason: 'no_secret' });
        continue;
      }
      if (await databaseService.channelDatabase.getMeshcoreBySecretAsync(secretHex)) {
        skipped.push({ name, reason: 'duplicate' });
        continue;
      }
      const id = await databaseService.channelDatabase.createAsync({
        name,
        psk: secretHexToBase64(secretHex),
        pskLength: MESHCORE_SECRET_BYTES,
        protocol: 'meshcore',
        description: `Imported from ${source.name}`,
        isEnabled: true,
        enforceNameValidation: false,
        createdBy: scope.user?.id ?? null,
      });
      imported.push({ id, name });
    }

    logger.debug(`MeshCore channel import from ${sourceId}: ${imported.length} imported, ${skipped.length} skipped`);
    return ok(res, { imported, skipped });
  } catch (error) {
    logger.error('Error importing MeshCore channels:', error);
    return fail(res, 500, 'IMPORT_FAILED', 'Failed to import channels');
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

    if (existing.protocol === 'meshcore') {
      // It re-decrypts the Meshtastic packet_log; a MeshCore key cannot.
      return fail(res, 400, 'NOT_MESHTASTIC', 'Retroactive decryption is only available for Meshtastic entries');
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
