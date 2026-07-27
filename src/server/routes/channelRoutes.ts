/**
 * Channel Routes
 *
 * GET    /channels/all          — all channels (per-row filtered, for export/config)
 * GET    /channels              — configured channels for display
 * GET    /channels/:id/export   — export a single channel config as JSON
 * PUT    /channels/:id          — update a channel (Meshtastic + MeshCore)
 * DELETE /channels/:id          — delete a channel + its messages
 * POST   /channels/:slotId/import — import a channel config into a slot
 * POST   /channels/reorder      — reorder device channel slots
 * POST   /channels/decode-url   — decode a Meshtastic channel URL for preview
 * POST   /channels/encode-url   — encode current config to a Meshtastic URL
 * POST   /channels/import-config — import config (channels + LoRa) from a URL
 * POST   /channels/refresh      — manual channel-database refresh
 *
 * Mounted in server.ts via `apiRouter.use('/channels', channelRoutes)`, so the
 * handler paths here are relative to the `/channels` prefix.
 *
 * Extracted verbatim from server.ts. The channel-move helpers
 * (detectChannelMoves / snapshotChannelsBeforeChange /
 * migrateMessagesIfChannelsMoved) were server.ts-local and only used by these
 * handlers, so they moved here too.
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { ALL_SOURCES, type SourceScope } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requireAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { transformChannel } from '../utils/channelView.js';
import { detectChannelCollisions } from '../utils/channelCollision.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { migrateAutomationChannels } from '../utils/automationChannelMigration.js';
import { modemPresetChannelName, CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { getEncryptionStatus, getRoleName } from '../utils/channelView.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import { fail } from '../utils/apiResponse.js';
import { requireSourceId } from '../utils/requireSourceId.js';

const router: Router = Router();

/**
 * Build the Channels-tab channel list for an MQTT source (mqtt_bridge /
 * mqtt_broker). MQTT sources don't sync device channel slots, so their
 * per-source `channels` table is empty; instead every message is filed under a
 * channel_database-backed virtual channel (`CHANNEL_DB_OFFSET + id`) or, for
 * legacy stragglers, a raw hash slot (`< CHANNEL_DB_OFFSET`).
 *
 * We enumerate the distinct `messages.channel` values that actually carry
 * traffic for the source and project each into the same shape `transformChannel`
 * emits (id, name, displayName, role, roleName, pskSet, encryptionStatus, …),
 * so the existing frontend Channels tab renders them without changes. Virtual
 * channels resolve their name/PSK/enabled state from the channel_database row;
 * raw stragglers get a best-effort label. Per-channel read permission is
 * enforced (channel_database permissions for virtual ids, channel_${id} for raw
 * ids); admins see all. Sorted most-active first.
 */
async function buildMqttSourceChannels(
  req: Request,
  sourceId: string,
  isAdmin: boolean,
): Promise<unknown[]> {
  const distinct = await databaseService.messages.getDistinctChannelsForSource(sourceId);
  if (distinct.length === 0) return [];

  // Virtual-channel read permissions (channel_database) for the caller.
  const virtualPerms = (!isAdmin && req.user)
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(req.user.id)
    : {};

  const out: unknown[] = [];
  for (const { channel } of distinct) {
    if (channel >= CHANNEL_DB_OFFSET) {
      const dbId = channel - CHANNEL_DB_OFFSET;
      // Permission gate for virtual channels.
      if (!isAdmin && !(virtualPerms[dbId]?.read === true)) continue;

      const row = await databaseService.channelDatabase.getByIdAsync(dbId);
      const name = (row?.name ?? '').trim() || `Channel ${channel}`;
      const psk = row?.psk ?? '';
      out.push({
        id: channel,
        name,
        // Virtual channels carry the channel number in their display name so
        // the tab disambiguates same-name channels (e.g. "MediumFast #101").
        displayName: `${name} #${channel}`,
        role: null,
        roleName: getRoleName(undefined),
        uplinkEnabled: false,
        downlinkEnabled: false,
        positionPrecision: undefined,
        scope: null,
        pskSet: !!psk,
        encryptionStatus: getEncryptionStatus(psk),
      });
    } else {
      // Raw hash straggler (< OFFSET). Gate on channel_${id} read.
      if (!isAdmin) {
        const channelResource = `channel_${channel}` as import('../../types/permission.js').ResourceType;
        const ok = req.user ? await hasPermission(req.user, channelResource, 'read', sourceId) : false;
        if (!ok) continue;
      }
      out.push({
        id: channel,
        name: `Channel ${channel}`,
        displayName: `Channel ${channel}`,
        role: null,
        roleName: getRoleName(undefined),
        uplinkEnabled: false,
        downlinkEnabled: false,
        positionPrecision: undefined,
        scope: null,
        pskSet: false,
        encryptionStatus: getEncryptionStatus(''),
      });
    }
  }
  return out;
}

// Get all channels (unfiltered, for export/config purposes)
// MM-SEC-2: Per-row permission gate + transformChannel projection so the
// raw `psk` column never appears in any HTTP response. Anonymous callers
// only see channels they have `channel_${id}:read` for; admins see all.
router.get('/all', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const allChannelsSourceId = req.query.sourceId as string | undefined;
    // intentional cross-source: omitting sourceId on this route returns channels from all sources
    const allChannels = await databaseService.channels.getAllChannels(allChannelsSourceId ?? ALL_SOURCES);
    const isAdmin = req.user?.isAdmin === true;

    const accessible: typeof allChannels = [];
    for (const channel of allChannels) {
      if (isAdmin) {
        accessible.push(channel);
        continue;
      }
      const channelResource = `channel_${channel.id}` as import('../../types/permission.js').ResourceType;
      if (req.user && await hasPermission(req.user, channelResource, 'read')) {
        accessible.push(channel);
      }
    }

    // MM-SEC-2 follow-up: include the raw `psk` only for callers with write
    // permission to the specific channel (or admins). Without this, the
    // channel-config edit dialog and Info popup can't display the existing
    // key for the operator who is allowed to change it. See issue #2951.
    const projected = await Promise.all(accessible.map(async (channel) => {
      const channelResource = `channel_${channel.id}` as import('../../types/permission.js').ResourceType;
      const includePsk = isAdmin || (req.user
        ? await hasPermission(req.user, channelResource, 'write', allChannelsSourceId)
        : false);
      return transformChannel(channel, { includePsk });
    }));

    logger.debug(`📡 Serving ${accessible.length} channels (per-row filtered, of ${allChannels.length} total)`);
    res.json(projected);
  } catch (error) {
    logger.error('Error fetching all channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

router.get('/', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const channelsSourceId = req.query.sourceId as string | undefined;
    const isAdmin = req.user?.isAdmin === true;

    // MQTT sources (mqtt_bridge / mqtt_broker) don't sync device channel slots;
    // migration 103 emptied their `channels` table and ingestion files messages
    // under channel_database-backed virtual channels (`CHANNEL_DB_OFFSET + id`).
    // For those sources enumerate the virtual channels that actually carry
    // traffic so the Channels tab isn't empty. TCP/device sources keep the
    // existing slot-based code path below.
    if (channelsSourceId) {
      try {
        const source = await databaseService.sources.getSource(channelsSourceId);
        if (source && (source.type === 'mqtt_bridge' || source.type === 'mqtt_broker')) {
          const mqttChannels = await buildMqttSourceChannels(req, channelsSourceId, isAdmin);
          logger.debug(`📡 Serving ${mqttChannels.length} MQTT virtual channels for source ${channelsSourceId}`);
          res.json(mqttChannels);
          return;
        }
      } catch (err) {
        logger.warn(`Failed to build MQTT channel list for source ${channelsSourceId}:`, err);
        // Fall through to the slot-based path (returns [] for MQTT, but never 500s).
      }
    }

    // intentional cross-source: omitting sourceId on this route returns channels from all sources
    const allChannels = await databaseService.channels.getAllChannels(channelsSourceId ?? ALL_SOURCES);

    // Resolve the source's persisted modem preset (if scoped to one source)
    // so empty-name slot 0 displays as "MediumFast"/"LongFast"/etc. via
    // transformChannel's `displayName` field. Matches the unified picker
    // and the firmware-derived label MQTT gateways publish under.
    let channelsPresetName: string | null = null;
    if (channelsSourceId) {
      try {
        const raw = await databaseService.settings.getSetting(`lora.preset.${channelsSourceId}`);
        const n = raw != null ? Number(raw) : NaN;
        if (Number.isFinite(n)) channelsPresetName = modemPresetChannelName(n);
      } catch (err) {
        logger.debug(`Failed to load preset for source ${channelsSourceId}:`, err);
      }
    }

    // Per-row permission gate (MM-SEC-2). Build the authorized set first.
    const accessible: typeof allChannels = [];
    for (const channel of allChannels) {
      if (isAdmin) {
        accessible.push(channel);
        continue;
      }
      const channelResource = `channel_${channel.id}` as import('../../types/permission.js').ResourceType;
      if (req.user && await hasPermission(req.user, channelResource, 'read')) {
        accessible.push(channel);
      }
    }

    // Channel 0 will be created automatically when device config syncs
    // It should have an empty name as per Meshtastic protocol

    // Filter accessible channels to only show configured ones
    // Meshtastic supports channels 0-7 (8 total)
    const filteredChannels = accessible.filter(channel => {
      // Exclude disabled channels (role === 0)
      if (channel.role === 0) {
        return false;
      }

      // Always show channel 0 (Primary channel)
      if (channel.id === 0) {
        return true;
      }

      // Show channels 1-7 if they have a PSK configured (indicating they're in use)
      if (channel.id >= 1 && channel.id <= 7 && channel.psk) {
        return true;
      }

      // Show channels with a role defined (PRIMARY, SECONDARY)
      if (channel.role !== null && channel.role !== undefined) {
        return true;
      }

      return false;
    });

    // Ensure Primary channel (ID 0) is first in the list
    const primaryIndex = filteredChannels.findIndex(ch => ch.id === 0);
    if (primaryIndex > 0) {
      const primary = filteredChannels.splice(primaryIndex, 1)[0];
      filteredChannels.unshift(primary);
    }

    // MM-SEC-2 follow-up: include the raw `psk` only for callers with write
    // permission to the specific channel (or admins). Without this, the
    // channel-config edit dialog can't display the existing key for the
    // operator who is allowed to change it. See issue #2951.
    const projected = await Promise.all(filteredChannels.map(async (channel) => {
      const channelResource = `channel_${channel.id}` as import('../../types/permission.js').ResourceType;
      const includePsk = isAdmin || (req.user
        ? await hasPermission(req.user, channelResource, 'write', channelsSourceId)
        : false);
      return transformChannel(channel, { includePsk, presetName: channelsPresetName });
    }));

    logger.debug(`📡 Serving ${filteredChannels.length} filtered channels (from ${allChannels.length} total)`);
    res.json(projected);
  } catch (error) {
    logger.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /collisions — device channels whose PSK matches a channel_database
// (server-decryption) entry under a DIFFERENT name (#3644). Such a channel's
// messages get filed under the other name's tab, leaving the device channel's
// own tab empty. PSKs are compared server-side (readers don't receive raw PSKs)
// and only names/ids are returned. Registered before `/:id` so it isn't
// swallowed by the id param route.
router.get('/collisions', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const sourceId = req.query.sourceId as string | undefined;
    // intentional cross-source: omitting sourceId on the collisions route returns channels from all sources
    const allChannels = await databaseService.channels.getAllChannels(sourceId ?? ALL_SOURCES);
    const isAdmin = req.user?.isAdmin === true;

    // Per-row permission gate (MM-SEC-2), mirroring GET /. Only consider
    // channels the caller may read so collision detection can't leak the names
    // of restricted channels to unauthorized callers.
    const accessible: typeof allChannels = [];
    for (const channel of allChannels) {
      if (isAdmin) {
        accessible.push(channel);
        continue;
      }
      const channelResource = `channel_${channel.id}` as import('../../types/permission.js').ResourceType;
      if (req.user && await hasPermission(req.user, channelResource, 'read')) {
        accessible.push(channel);
      }
    }

    const dbEntries = await databaseService.channelDatabase.getAllAsync();
    const collisions = detectChannelCollisions(
      accessible.map(c => ({ id: c.id, name: c.name, psk: c.psk })),
      dbEntries
        .filter((d): d is typeof d & { id: number } => typeof d.id === 'number')
        .map(d => ({ id: d.id, name: d.name, psk: d.psk })),
    );
    res.json({ collisions });
  } catch (error) {
    logger.error('Error detecting channel collisions:', error);
    res.status(500).json({ error: 'Failed to detect channel collisions' });
  }
});

// Export a specific channel configuration
router.get('/:id/export', requireAuth(), requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // MM-SEC-4: gate per-channel. Export includes the raw PSK, so the caller
    // must have read permission for the SPECIFIC channel they're exporting,
    // not just channel_0.
    const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'read'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'read' },
      });
    }

    // Scope to the required source (#3712) so a multi-source install can't
    // export the PSK from a different source's channel that shares this slot.
    // Presence is validated by requireSourceId('query').
    const exportSourceId = req.query.sourceId as string;
    const channel = await databaseService.channels.getChannelById(channelId, exportSourceId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    logger.debug(`📤 Exporting channel ${channelId} (${channel.name}):`, {
      role: channel.role,
      positionPrecision: channel.positionPrecision,
      uplinkEnabled: channel.uplinkEnabled,
      downlinkEnabled: channel.downlinkEnabled,
    });

    // Create export data with metadata
    // Normalize boolean values to ensure consistent export format (handle any numeric 0/1 values)
    const normalizeBoolean = (value: any): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
      return !!value;
    };

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      channel: {
        id: channel.id,
        name: channel.name,
        psk: channel.psk,
        role: channel.role,
        uplinkEnabled: normalizeBoolean(channel.uplinkEnabled),
        downlinkEnabled: normalizeBoolean(channel.downlinkEnabled),
        positionPrecision: channel.positionPrecision,
      },
    };

    // Set filename header
    const filename = `meshmonitor-channel-${channel.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    // Use pretty-printed JSON for consistency with other exports
    res.send(JSON.stringify(exportData, null, 2));
  } catch (error) {
    logger.error('Error exporting channel:', error);
    res.status(500).json({ error: 'Failed to export channel' });
  }
});

/**
 * Detect channel moves/swaps by comparing PSKs before and after a change.
 * Returns an array of {from, to} slot pairs indicating where channels moved.
 */
function detectChannelMoves(
  before: { id: number; psk?: string | null }[],
  after: { id: number; psk?: string | null }[]
): { from: number; to: number }[] {
  const moves: { from: number; to: number }[] = [];

  for (const oldCh of before) {
    if (!oldCh.psk || oldCh.psk === '') continue;
    const newCh = after.find(ch => ch.psk === oldCh.psk && ch.id !== oldCh.id);
    if (newCh) {
      // This PSK moved from oldCh.id to newCh.id
      // Avoid duplicates (swap would register A→B and B→A)
      if (!moves.find(m => m.from === newCh.id && m.to === oldCh.id)) {
        moves.push({ from: oldCh.id, to: newCh.id });
      }
    }
  }

  return moves;
}

/**
 * Snapshot channel slots and migrate messages after a channel configuration change.
 * Call snapshotBefore() before applying changes, then migrateIfNeeded() after.
 */
async function snapshotChannelsBeforeChange(sourceId?: SourceScope) {
  return (await databaseService.channels.getAllChannels(sourceId ?? ALL_SOURCES)).map(ch => ({ id: ch.id, psk: ch.psk }));
}

async function migrateMessagesIfChannelsMoved(
  beforeSnapshot: { id: number; psk?: string | null }[],
  sourceId?: SourceScope,
) {
  try {
    const afterSnapshot = (await databaseService.channels.getAllChannels(sourceId ?? ALL_SOURCES)).map(ch => ({ id: ch.id, psk: ch.psk }));
    const moves = detectChannelMoves(beforeSnapshot, afterSnapshot);
    if (moves.length > 0) {
      logger.debug(`📦 Detected channel move(s): ${moves.map(m => `${m.from}→${m.to}`).join(', ')}`);
      await databaseService.messages.migrateMessagesForChannelMoves(moves, typeof sourceId === 'string' ? sourceId : undefined);
      await migrateAutomationChannels(
        moves,
        (key) => databaseService.settings.getSetting(key),
        (key, value) => databaseService.settings.setSetting(key, value)
      );
    }
  } catch (error) {
    logger.error('📦 Failed to migrate messages after channel change:', error);
    // Don't fail the channel operation — message migration is best-effort
  }
}

// Update a channel configuration
router.put('/:id', requireAuth(), requireSourceId('body'), async (req: Request, res: Response) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId) || channelId < 0) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // The 0-7 slot cap is a Meshtastic-only convention; MeshCore devices
    // expose a device-dependent number of channels (see phase-1 plan).
    // Resolve the source type early so we can gate the cap accordingly.
    const { sourceId: chanSourceId } = req.body;
    const sourceRowForType = (typeof chanSourceId === 'string' && chanSourceId.length > 0)
      ? await databaseService.sources.getSource(chanSourceId)
      : null;
    const sourceType = sourceRowForType?.type ?? 'meshtastic_tcp';

    if (sourceType !== 'meshcore' && channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID. Must be between 0-7' });
    }

    // MM-SEC-4: per-channel write gate — caller needs write permission for
    // the SPECIFIC channel they're modifying, not just channel_0.
    const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'write'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'write' },
      });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision, scope } = req.body;

    // Validate MeshCore region/scope if provided (#3667). Plain region name —
    // alphanumeric + hyphen, optional leading '#' which we strip. Empty string
    // clears the scope. Meaningful only for MeshCore; ignored for Meshtastic.
    let normalizedScope: string | null | undefined;
    if (scope !== undefined) {
      if (scope === null || scope === '') {
        normalizedScope = null;
      } else if (typeof scope !== 'string') {
        return res.status(400).json({ error: 'Scope must be a string' });
      } else {
        const stripped = scope.trim().replace(/^#/, '');
        // An all-whitespace or bare '#' value strips to '' and clears the scope
        // (same as sending null/'') — the regex check only applies to a real name.
        if (stripped !== '' && !/^[A-Za-z0-9-]{1,63}$/.test(stripped)) {
          return res.status(400).json({ error: 'Scope must be 1-63 chars: letters, digits, hyphen' });
        }
        normalizedScope = stripped || null;
      }
    }

    // Validate name if provided (allow empty names for unnamed channels).
    // Meshtastic caps channel names at 11 chars; MeshCore allows up to 31.
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'Channel name must be a string' });
      }
      const maxLen = sourceType === 'meshcore' ? 31 : 11;
      if (name.length > maxLen) {
        return res.status(400).json({ error: `Channel name must be ${maxLen} characters or less` });
      }
    }

    // Validate PSK if provided
    if (psk !== undefined && psk !== null && typeof psk !== 'string') {
      return res.status(400).json({ error: 'Invalid PSK format' });
    }

    // Validate role if provided
    if (role !== undefined && role !== null && (typeof role !== 'number' || role < 0 || role > 2)) {
      return res.status(400).json({ error: 'Invalid role. Must be 0 (Disabled), 1 (Primary), or 2 (Secondary)' });
    }

    // Validate positionPrecision if provided
    if (
      positionPrecision !== undefined &&
      positionPrecision !== null &&
      (typeof positionPrecision !== 'number' || positionPrecision < 0 || positionPrecision > 32)
    ) {
      return res.status(400).json({ error: 'Invalid position precision. Must be between 0-32' });
    }

    // MeshCore channels are created on-device (setChannel + syncChannelsFromDevice),
    // so there is no pre-existing DB row when adding a new slot. Skip the
    // existence check for MeshCore; enforce 404 only for Meshtastic, which
    // always pre-creates 8 slots.
    const scopedSourceId = typeof chanSourceId === 'string' && chanSourceId.length > 0
      ? chanSourceId
      : undefined;
    const existingChannel = sourceType !== 'meshcore'
      ? await databaseService.channels.getChannelById(channelId, scopedSourceId)
      : null;
    if (sourceType !== 'meshcore' && !existingChannel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Snapshot channels before change for message migration (per-source — #3712)
    const beforeSnapshot = await snapshotChannelsBeforeChange(scopedSourceId);

    // Prepare the updated channel data
    const updatedChannelData = {
      id: channelId,
      name: name !== undefined && name !== null ? name : (existingChannel?.name ?? ''),
      psk: psk !== undefined && psk !== null ? psk : (existingChannel?.psk ?? null),
      role: role !== undefined && role !== null ? role : (existingChannel?.role ?? null),
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : (existingChannel?.uplinkEnabled ?? null),
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : (existingChannel?.downlinkEnabled ?? null),
      positionPrecision:
        positionPrecision !== undefined && positionPrecision !== null
          ? positionPrecision
          : (existingChannel?.positionPrecision ?? null),
    };

    if (sourceType === 'meshcore') {
      // MeshCore write path: push the channel to the device first, then
      // re-sync the DB from the device (the manager's setChannel handles
      // both — including base64↔hex secret conversion).
      //
      // resolveSourceManager only knows about Meshtastic managers; look up the
      // MeshCore manager via the unified sourceManagerRegistry and narrow it.
      const _rawCh = sourceManagerRegistry.getManager(chanSourceId);
      const mcManager = _rawCh && isMeshCoreManager(_rawCh) ? _rawCh : null;
      if (!mcManager || typeof mcManager.setChannel !== 'function') {
        return fail(res, 503, 'SOURCE_NOT_CONNECTED', `No active MeshCore manager for source ${chanSourceId}. Connect the source and retry.`);
      }

      // Convert the base64 PSK to hex for the meshcore.js wire format.
      // Reject anything that doesn't decode to exactly 16 bytes (AES-128).
      const incomingPskBase64 = updatedChannelData.psk;
      let secretHex: string;
      try {
        const bytes = Buffer.from(incomingPskBase64 ?? '', 'base64');
        if (bytes.length !== 16) {
          return res.status(400).json({
            error: `MeshCore channel secret must decode to exactly 16 bytes (got ${bytes.length})`,
          });
        }
        secretHex = bytes.toString('hex');
      } catch {
        return res.status(400).json({ error: 'Invalid MeshCore channel secret (expected base64 of 16 bytes)' });
      }

      try {
        await mcManager.setChannel(channelId, updatedChannelData.name, secretHex, normalizedScope);
        logger.debug(`✅ MeshCore: pushed channel ${channelId} to device + re-synced DB`);
      } catch (deviceError) {
        logger.error(`⚠️ MeshCore: failed to push channel ${channelId} to device:`, deviceError);
        return res.status(502).json({
          error: 'Failed to write channel to MeshCore device',
          message: deviceError instanceof Error ? deviceError.message : String(deviceError),
        });
      }

      const updatedChannel = await databaseService.channels.getChannelById(channelId, chanSourceId);
      return res.json({ success: true, channel: updatedChannel });
    }

    // Meshtastic write path.
    // Update channel in database. Scope to the requesting source so each
    // source's channel row is independent. `allowBlankName: true` lets the
    // user clear a stored channel name — without it, the ingest-protection
    // coalesce in upsertChannel silently keeps the old name (#1567 backfire).
    await databaseService.channels.upsertChannel(
      updatedChannelData,
      scopedSourceId,
      { allowBlankName: true },
    );

    // Send channel configuration to Meshtastic device
    const chanUpdateManager = (resolveSourceManager(chanSourceId));
    try {
      await chanUpdateManager.setChannelConfig(channelId, {
        name: updatedChannelData.name,
        psk: updatedChannelData.psk === '' ? undefined : updatedChannelData.psk,
        role: updatedChannelData.role,
        uplinkEnabled: updatedChannelData.uplinkEnabled,
        downlinkEnabled: updatedChannelData.downlinkEnabled,
        positionPrecision: updatedChannelData.positionPrecision,
      });
      logger.debug(`✅ Sent channel ${channelId} configuration to device`);
    } catch (deviceError) {
      logger.error(`⚠️ Failed to send channel ${channelId} config to device:`, deviceError);
      // Continue even if device update fails - database is updated
    }

    // Migrate messages if channel PSK moved to a different slot (per-source — #3712)
    await migrateMessagesIfChannelsMoved(beforeSnapshot, scopedSourceId);

    const updatedChannel = await databaseService.channels.getChannelById(channelId, scopedSourceId);
    logger.debug(`✅ Updated channel ${channelId}: ${name}`);
    res.json({ success: true, channel: updatedChannel });
  } catch (error) {
    logger.error('Error updating channel:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Delete a channel's messages and database record
router.delete('/:id', requireAuth(), async (req: Request, res: Response) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId) || channelId < 0) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // sourceId is required so the channel and its messages are removed from a single source
    const rawSourceId = (req.body && req.body.sourceId) ?? (req.query && req.query.sourceId);
    if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '' || typeof rawSourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const deleteChannelSourceId: string = rawSourceId;

    // Same 0-7 cap softening as the PUT route — MeshCore allows higher idx.
    const sourceRowForType = await databaseService.sources.getSource(deleteChannelSourceId);
    const sourceType = sourceRowForType?.type ?? 'meshtastic_tcp';
    if (sourceType !== 'meshcore' && channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID (0-7)' });
    }
    if (sourceType !== 'meshcore' && channelId === 0) {
      return res.status(400).json({ error: 'Cannot delete primary channel' });
    }

    // MM-SEC-4: per-channel write gate.
    const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'write'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'write' },
      });
    }

    if (sourceType === 'meshcore') {
      // MeshCore: push delete to the device first, then re-sync the DB.
      const _rawDel = sourceManagerRegistry.getManager(deleteChannelSourceId);
      const mcManager = _rawDel && isMeshCoreManager(_rawDel) ? _rawDel : null;
      if (!mcManager || typeof mcManager.deleteChannel !== 'function') {
        return fail(res, 503, 'SOURCE_NOT_CONNECTED', `No active MeshCore manager for source ${deleteChannelSourceId}. Connect the source and retry.`);
      }
      try {
        await mcManager.deleteChannel(channelId);
      } catch (deviceError) {
        logger.error(`⚠️ MeshCore: failed to delete channel ${channelId} on device:`, deviceError);
        return res.status(502).json({
          error: 'Failed to delete channel on MeshCore device',
          message: deviceError instanceof Error ? deviceError.message : String(deviceError),
        });
      }
      logger.debug(`🗑️ MeshCore: deleted channel ${channelId} on device + re-synced DB (source=${deleteChannelSourceId})`);
      return res.json({ success: true, message: `Channel ${channelId} deleted`, sourceId: deleteChannelSourceId });
    }

    // Meshtastic path.
    // Purge messages for this channel (scoped to the chosen source)
    const deletedCount = await databaseService.messages.purgeChannelMessages(channelId, deleteChannelSourceId);
    // Delete the channel record (scoped to the chosen source)
    await databaseService.channels.deleteChannel(channelId, deleteChannelSourceId);

    logger.debug(`🗑️ Deleted channel ${channelId} (source=${deleteChannelSourceId}): ${deletedCount} messages purged`);
    res.json({ success: true, message: `Channel ${channelId} deleted`, sourceId: deleteChannelSourceId, messagesDeleted: deletedCount });
  } catch (error) {
    logger.error('Error deleting channel:', error);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// Import a channel configuration to a specific slot
router.post('/:slotId/import', requireAuth(), requireSourceId('body'), async (req: Request, res: Response) => {
  try {
    const slotId = parseInt(req.params.slotId);
    if (isNaN(slotId) || slotId < 0 || slotId > 7) {
      return res.status(400).json({ error: 'Invalid slot ID. Must be between 0-7' });
    }

    // MM-SEC-4: per-channel write gate. Importing a channel into slot N
    // overwrites slot N — caller needs write permission for that slot.
    const slotResource = `channel_${slotId}` as import('../../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, slotResource, 'write'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: slotResource, action: 'write' },
      });
    }

    const { channel, sourceId: importSourceId } = req.body;

    if (!channel || typeof channel !== 'object') {
      return res.status(400).json({ error: 'Invalid import data. Expected channel object' });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision } = channel;

    // Validate name type/length but allow empty string (parity with PUT /channels/:id;
    // Meshtastic protocol allows blank slot-0 names — display falls back to "Primary").
    if (typeof name !== 'string') {
      return res.status(400).json({ error: 'Channel name must be a string' });
    }

    if (name.length > 11) {
      return res.status(400).json({ error: 'Channel name must be 11 characters or less' });
    }

    // Validate role if provided (handle both null and undefined as "not provided")
    if (role !== null && role !== undefined) {
      if (typeof role !== 'number' || role < 0 || role > 2) {
        return res.status(400).json({ error: 'Channel role must be 0 (Disabled), 1 (Primary), or 2 (Secondary)' });
      }
    }

    // Validate positionPrecision if provided (handle both null and undefined as "not provided")
    if (positionPrecision !== null && positionPrecision !== undefined) {
      if (typeof positionPrecision !== 'number' || positionPrecision < 0 || positionPrecision > 32) {
        return res.status(400).json({ error: 'Position precision must be between 0-32 bits' });
      }
    }

    // Prepare the imported channel data
    // Normalize boolean values - handle both boolean (true/false) and numeric (1/0) formats
    const normalizeBoolean = (value: any, defaultValue: boolean = true): boolean => {
      if (value === undefined || value === null) {
        return defaultValue;
      }
      // Handle boolean values
      if (typeof value === 'boolean') {
        return value;
      }
      // Handle numeric values (0/1)
      if (typeof value === 'number') {
        return value !== 0;
      }
      // Handle string values ("true"/"false", "1"/"0")
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
      }
      // Default to truthy check
      return !!value;
    };

    // Snapshot channels before change for message migration (per-source — #3712)
    const importScopedSourceId = typeof importSourceId === 'string' && importSourceId.length > 0
      ? importSourceId
      : undefined;
    const beforeSnapshot = await snapshotChannelsBeforeChange(importScopedSourceId);

    const importedChannelData = {
      id: slotId,
      name,
      psk: psk || undefined,
      role: role !== null && role !== undefined ? role : undefined,
      uplinkEnabled: normalizeBoolean(uplinkEnabled, true),
      downlinkEnabled: normalizeBoolean(downlinkEnabled, true),
      positionPrecision: positionPrecision !== null && positionPrecision !== undefined ? positionPrecision : undefined,
    };

    // Import channel to the specified slot in database (scoped to source — #3712)
    await databaseService.channels.upsertChannel(importedChannelData, importScopedSourceId);

    // Send channel configuration to Meshtastic device
    const importManager = (resolveSourceManager(importSourceId));
    try {
      await importManager.setChannelConfig(slotId, {
        name: importedChannelData.name,
        psk: importedChannelData.psk,
        role: importedChannelData.role,
        uplinkEnabled: importedChannelData.uplinkEnabled,
        downlinkEnabled: importedChannelData.downlinkEnabled,
        positionPrecision: importedChannelData.positionPrecision,
      });
      logger.debug(`✅ Sent imported channel ${slotId} configuration to device`);
    } catch (deviceError) {
      logger.error(`⚠️ Failed to send imported channel ${slotId} config to device:`, deviceError);
      // Continue even if device update fails - database is updated
    }

    // Migrate messages if channel PSK moved to a different slot (per-source — #3712)
    await migrateMessagesIfChannelsMoved(beforeSnapshot, importScopedSourceId);

    const importedChannel = await databaseService.channels.getChannelById(slotId, importScopedSourceId);
    logger.debug(`✅ Imported channel to slot ${slotId}: ${name}`);
    res.json({ success: true, channel: importedChannel });
  } catch (error) {
    logger.error('Error importing channel:', error);
    res.status(500).json({ error: 'Failed to import channel' });
  }
});

// Reorder device channel slots (drag-and-drop)
router.post('/reorder', requireAuth(), requireSourceId('body'), async (req: Request, res: Response) => {
  try {
    const { newOrder, sourceId: reorderSourceId } = req.body;

    // Validate: newOrder must be an array of 8 slot indices [0-7], each used exactly once
    if (!Array.isArray(newOrder) || newOrder.length !== 8) {
      return res.status(400).json({ error: 'newOrder must be an array of 8 slot indices' });
    }
    const sorted = [...newOrder].sort();
    if (sorted.some((v, i) => v !== i)) {
      return res.status(400).json({ error: 'newOrder must contain each slot index 0-7 exactly once' });
    }

    // Check if anything actually changed
    const isIdentity = newOrder.every((v: number, i: number) => v === i);
    if (isIdentity) {
      return res.json({ success: true, requiresReboot: false });
    }

    // MM-SEC-4: per-channel write gate. Reorder rewrites every slot whose
    // contents change; for each one, the caller must have write permission.
    // (Affected set is symmetric for permutations, so checking the destination
    // slots covers the source slots too.)
    if (!req.user?.isAdmin) {
      const affectedSlots = new Set<number>();
      for (let i = 0; i < newOrder.length; i++) {
        if (newOrder[i] !== i) {
          affectedSlots.add(i);
          affectedSlots.add(newOrder[i] as number);
        }
      }
      for (const slot of affectedSlots) {
        const slotResource = `channel_${slot}` as import('../../types/permission.js').ResourceType;
        if (!(req.user && await hasPermission(req.user, slotResource, 'write'))) {
          return res.status(403).json({
            error: 'Insufficient permissions',
            code: 'FORBIDDEN',
            required: { resource: slotResource, action: 'write' },
            message: `Reorder requires write permission for every affected channel slot (missing: channel_${slot})`,
          });
        }
      }
    }

    // Resolve the target source manager first so the channel lookup below can
    // be scoped to THIS source. MeshCore and Meshtastic channels share the
    // `channels` table and both use slot ids 0-7, so an unscoped
    // getAllChannels() returns rows from every source; the slot-keyed Map then
    // collapses same-id rows and a MeshCore channel can win the slot being
    // reordered — silently overwriting a Meshtastic channel with a MeshCore
    // one (and vice-versa). Scoping to reorderManager.sourceId keeps the
    // reorder confined to the source the user is actually editing.
    const reorderManager = (resolveSourceManager(reorderSourceId));
    const reorderSourceScope = reorderManager.sourceId;

    const allChannels = await databaseService.channels.getAllChannels(reorderSourceScope);

    // Build the new channel configs based on the reorder mapping
    // newOrder[newSlot] = oldSlot — means "new slot i gets the channel from old slot newOrder[i]"
    const channelsBySlot = new Map(allChannels.map(ch => [ch.id, ch]));

    // Begin edit settings transaction
    logger.debug(`🔄 Beginning channel reorder: ${newOrder.join(',')}`);
    await reorderManager.beginEditSettings();
    // Pacing: device firmware silently drops admin packets that arrive too soon
    // after BeginEditSettings on TCP PhoneAPI. See /channels/import-config for details.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    for (let newSlot = 0; newSlot < 8; newSlot++) {
      const oldSlot = newOrder[newSlot];
      if (oldSlot === newSlot) continue; // No change for this slot

      const sourceChannel = channelsBySlot.get(oldSlot);
      // Slot 0 is always primary, others secondary
      const role = newSlot === 0 ? 1 : (sourceChannel?.role === 1 ? 2 : (sourceChannel?.role ?? 0));

      if (sourceChannel && sourceChannel.role !== 0) {
        await reorderManager.setChannelConfig(newSlot, {
          name: sourceChannel.name || '',
          psk: sourceChannel.psk || undefined,
          role,
          uplinkEnabled: sourceChannel.uplinkEnabled ?? true,
          downlinkEnabled: sourceChannel.downlinkEnabled ?? true,
          positionPrecision: sourceChannel.positionPrecision ?? undefined,
        });

        // Update database (scoped to this source; reorder is an authoritative
        // user write, so allow blank names to overwrite)
        await databaseService.channels.upsertChannel({
          id: newSlot,
          name: sourceChannel.name || '',
          psk: sourceChannel.psk,
          role,
          uplinkEnabled: sourceChannel.uplinkEnabled,
          downlinkEnabled: sourceChannel.downlinkEnabled,
          positionPrecision: sourceChannel.positionPrecision,
        }, reorderSourceScope, { allowBlankName: true });
      } else {
        // Empty/disabled slot
        await reorderManager.setChannelConfig(newSlot, {
          name: '',
          psk: undefined,
          role: 0,
        });
        await databaseService.channels.upsertChannel({
          id: newSlot,
          name: '',
          psk: null,
          role: 0,
        }, reorderSourceScope, { allowBlankName: true });
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Pacing: leave time for the last SetChannel to be processed before commit.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Commit to device
    await reorderManager.commitEditSettings();
    logger.debug(`✅ Channel reorder committed`);

    // Migrate messages — derive moves directly from newOrder mapping
    // newOrder[newSlot] = oldSlot, so messages on oldSlot should move to newSlot
    const moves: { from: number; to: number }[] = [];
    for (let newSlot = 0; newSlot < 8; newSlot++) {
      const oldSlot = newOrder[newSlot];
      if (oldSlot !== newSlot) {
        moves.push({ from: oldSlot, to: newSlot });
      }
    }
    if (moves.length > 0) {
      logger.debug(`📦 Channel reorder message migration: ${moves.map(m => `${m.from}→${m.to}`).join(', ')}`);
      try {
        await databaseService.messages.migrateMessagesForChannelMoves(moves, reorderSourceScope);
      } catch (error) {
        logger.error('📦 Failed to migrate messages after channel reorder:', error);
      }
      try {
        await databaseService.auth.migratePermissionsForChannelMoves(moves);
        logger.debug(`🔑 Permission migration complete for channel reorder`);
      } catch (error) {
        logger.error('🔑 Failed to migrate permissions after channel reorder:', error);
      }
    }

    res.json({ success: true, requiresReboot: true });
  } catch (error) {
    logger.error('Error reordering channels:', error);
    res.status(500).json({ error: 'Failed to reorder channels' });
  }
});

// Decode Meshtastic channel URL for preview
router.post('/decode-url', requirePermission('configuration', 'read'), async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const channelUrlService = (await import('../services/channelUrlService.js')).default;
    const decoded = channelUrlService.decodeUrl(url);

    if (!decoded) {
      return res.status(400).json({ error: 'Invalid or malformed Meshtastic URL' });
    }

    res.json(decoded);
  } catch (error) {
    logger.error('Error decoding channel URL:', error);
    res.status(500).json({ error: 'Failed to decode channel URL' });
  }
});

// Encode current configuration to Meshtastic URL
router.post('/encode-url', requirePermission('configuration', 'read'), requireSourceId('body'), async (req: Request, res: Response) => {
  try {
    const { channelIds, includeLoraConfig, sourceId: encodeUrlSourceId } = req.body;
    const encodeUrlManager = resolveSourceManager(encodeUrlSourceId);
    const encodeUrlSourceScope = encodeUrlManager.sourceId;

    if (!Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'channelIds must be an array' });
    }

    const channelUrlService = (await import('../services/channelUrlService.js')).default;

    // Get selected channels from database, scoped to this source. MeshCore and
    // Meshtastic channels share the `channels` table with the same slot ids, so
    // an unscoped getChannelById can return another source's row for the slot.
    const channelResults = await Promise.all(
      channelIds.map((id: number) => databaseService.channels.getChannelById(id, encodeUrlSourceScope))
    );
    const channels = channelResults
      .filter((ch): ch is NonNullable<typeof ch> => ch !== null)
      .map(ch => {
        logger.debug(`📡 Channel ${ch.id} from DB - name: "${ch.name}" (length: ${ch.name.length})`);
        return {
          psk: ch.psk ? ch.psk : 'none',
          name: ch.name, // Use the actual name from database (preserved from device)
          uplinkEnabled: ch.uplinkEnabled,
          downlinkEnabled: ch.downlinkEnabled,
          positionPrecision: ch.positionPrecision,
        };
      });

    if (channels.length === 0) {
      return res.status(400).json({ error: 'No valid channels selected' });
    }

    // Get LoRa config if requested
    let loraConfig = undefined;
    if (includeLoraConfig) {
      logger.debug('📡 includeLoraConfig is TRUE, fetching device config...');
      const deviceConfig = await encodeUrlManager.getDeviceConfig();
      logger.debug('📡 Device config lora:', JSON.stringify(deviceConfig?.lora, null, 2));
      if (deviceConfig?.lora) {
        loraConfig = {
          usePreset: deviceConfig.lora.usePreset,
          modemPreset: deviceConfig.lora.modemPreset,
          bandwidth: deviceConfig.lora.bandwidth,
          spreadFactor: deviceConfig.lora.spreadFactor,
          codingRate: deviceConfig.lora.codingRate,
          frequencyOffset: deviceConfig.lora.frequencyOffset,
          region: deviceConfig.lora.region,
          hopLimit: deviceConfig.lora.hopLimit,
          // Emit the device's actual txEnabled (issue #4294) — exports should
          // reflect the real radio state, not force TX on.
          txEnabled: deviceConfig.lora.txEnabled,
          txPower: deviceConfig.lora.txPower,
          channelNum: deviceConfig.lora.channelNum,
          sx126xRxBoostedGain: deviceConfig.lora.sx126xRxBoostedGain,
          configOkToMqtt: deviceConfig.lora.configOkToMqtt,
        };
        logger.debug('📡 LoRa config to encode:', JSON.stringify(loraConfig, null, 2));
      } else {
        logger.warn('⚠️ Device config or lora config is missing');
      }
    } else {
      logger.debug('📡 includeLoraConfig is FALSE, skipping LoRa config');
    }

    const url = channelUrlService.encodeUrl(channels, loraConfig);

    if (!url) {
      return res.status(500).json({ error: 'Failed to encode URL' });
    }

    res.json({ url });
  } catch (error) {
    logger.error('Error encoding channel URL:', error);
    res.status(500).json({ error: 'Failed to encode channel URL' });
  }
});

// Import configuration from URL
router.post('/import-config', requirePermission('configuration', 'write'), requireSourceId('body'), async (req: Request, res: Response) => {
  try {
    const { url: configUrl, sourceId: configSourceId } = req.body;

    if (!configUrl || typeof configUrl !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    logger.info(`📥 Importing configuration from URL: ${configUrl}`);

    // Dynamically import channelUrlService
    const channelUrlService = (await import('../services/channelUrlService.js')).default;

    // Decode the URL to get channels and lora config
    const decoded = channelUrlService.decodeUrl(configUrl);

    if (!decoded || (!decoded.channels && !decoded.loraConfig)) {
      return res.status(400).json({ error: 'Invalid or empty configuration URL' });
    }

    logger.debug(`📥 Decoded ${decoded.channels?.length || 0} channels, LoRa config: ${!!decoded.loraConfig}`);

    // Begin edit settings transaction to batch all changes
    const configImportManager = (resolveSourceManager(configSourceId));
    try {
      logger.debug(`🔄 Beginning edit settings transaction for import`);
      await configImportManager.beginEditSettings();
      // Allow device time to enter edit mode and ack back before sending config messages.
      // Empirically: 500ms is too short — device firmware silently drops the first
      // SetChannel that follows BeginEditSettings on TCP PhoneAPI under contention.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      logger.debug(`✅ Edit settings transaction started`);
    } catch (error) {
      logger.error(`❌ Failed to begin edit settings transaction:`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start configuration transaction: ${errMsg}`, { cause: error });
    }

    // Snapshot channels before change for message migration (per-source — #3712)
    const configScopedSourceId = typeof configSourceId === 'string' && configSourceId.length > 0
      ? configSourceId
      : undefined;
    const beforeSnapshot = await snapshotChannelsBeforeChange(configScopedSourceId);

    // Import channels FIRST (before LoRa config to avoid premature reboot)
    const importedChannels = [];
    if (decoded.channels && decoded.channels.length > 0) {
      for (let i = 0; i < decoded.channels.length; i++) {
        const channel = decoded.channels[i];
        try {
          logger.debug(`📥 Importing channel ${i}: ${channel.name || '(unnamed)'}`);

          // Determine role: if not specified, channel 0 is PRIMARY (1), others are SECONDARY (2)
          let role = channel.role;
          if (role === undefined) {
            role = i === 0 ? 1 : 2; // PRIMARY for channel 0, SECONDARY for others
          }

          // Write channel to device via Meshtastic manager
          await configImportManager.setChannelConfig(i, {
            name: channel.name || '',
            psk: channel.psk === 'none' ? undefined : channel.psk,
            role: role,
            uplinkEnabled: channel.uplinkEnabled,
            downlinkEnabled: channel.downlinkEnabled,
            positionPrecision: channel.positionPrecision,
          });

          // Allow device time to process channel config before sending the next message
          await new Promise((resolve) => setTimeout(resolve, 1000));
          importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
          logger.debug(`✅ Imported channel ${i}`);
        } catch (error) {
          logger.error(`❌ Failed to import channel ${i}:`, error);
          // Continue with other channels even if one fails
        }
      }
    }

    // Import LoRa config (part of transaction, won't trigger reboot yet)
    let loraImported = false;
    let requiresReboot = false;
    if (decoded.loraConfig) {
      try {
        logger.debug(`📥 Importing LoRa config:`, JSON.stringify(decoded.loraConfig, null, 2));

        // Preserve the device's current txEnabled rather than importing the
        // URL's value (issue #4294) — this is a local-node import.
        //
        // setLoRaConfig sends the ENTIRE LoRaConfig struct to the device (whole
        // message replace, not a patch), and proto3 decodes an omitted bool as
        // false. So we can't just strip the key — that would silently reach the
        // radio as txEnabled=false and kill TX (the exact #1328 mechanism that
        // motivated the original, overly-broad force-true). Explicitly backfill
        // with the device's actual current value instead.
        const loraConfigToImport = {
          ...decoded.loraConfig,
          txEnabled: configImportManager.isTxEnabled(),
        };

        logger.debug(`📥 LoRa config import: txEnabled preserved from device = ${loraConfigToImport.txEnabled}`);
        await configImportManager.setLoRaConfig(loraConfigToImport);
        // LoRa config triggers heavier processing (frequency calculations, radio reconfiguration)
        // so allow extra time before committing
        await new Promise((resolve) => setTimeout(resolve, 1500));
        loraImported = true;
        requiresReboot = true; // LoRa config requires reboot when committed
        logger.debug(`✅ Imported LoRa config`);
      } catch (error) {
        logger.error(`❌ Failed to import LoRa config:`, error);
      }
    }

    // Migrate messages before device reboots — build "after" from decoded config
    // since the DB won't be updated until device reconnects
    if (decoded.channels && decoded.channels.length > 0) {
      const afterSnapshot = decoded.channels.map((ch: any, i: number) => ({
        id: i,
        psk: ch.psk === 'none' ? null : (ch.psk || null),
      }));
      const moves = detectChannelMoves(beforeSnapshot, afterSnapshot);
      if (moves.length > 0) {
        logger.debug(`📦 Detected channel move(s) from config import: ${moves.map(m => `${m.from}→${m.to}`).join(', ')}`);
        try {
          await databaseService.messages.migrateMessagesForChannelMoves(moves, configScopedSourceId);
          await migrateAutomationChannels(
            moves,
            (key) => databaseService.settings.getSetting(key),
            (key, value) => databaseService.settings.setSetting(key, value)
          );
        } catch (error) {
          logger.error('📦 Failed to migrate messages after config import:', error);
        }
      }
    }

    // Commit all changes (channels + LoRa config) as a single transaction
    // This will save everything to flash and trigger device reboot if needed
    try {
      logger.debug(
        `💾 Committing all configuration changes (${importedChannels.length} channels${
          loraImported ? ' + LoRa config' : ''
        })...`
      );
      await configImportManager.commitEditSettings();
      logger.info(`✅ Configuration changes committed successfully`);
    } catch (error) {
      logger.error(`❌ Failed to commit configuration changes:`, error);
    }

    res.json({
      success: true,
      imported: {
        channels: importedChannels.length,
        channelDetails: importedChannels,
        loraConfig: loraImported,
      },
      requiresReboot,
    });
  } catch (error) {
    logger.error('Error importing configuration:', error);
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to import configuration: ${errMsg}` });
  }
});

// Manual channel-database refresh
router.post('/refresh', requirePermission('messages', 'write'), async (req: Request, res: Response) => {
  try {
    logger.debug('🔄 Manual channel refresh requested...');

    const { sourceId: chanRefreshSourceId } = req.body;
    const chanRefreshManager = (resolveSourceManager(chanRefreshSourceId));
    // Trigger full node database refresh (includes channels)
    await chanRefreshManager.refreshNodeDatabase();

    const channelCount = await databaseService.channels.getChannelCount(
      typeof chanRefreshSourceId === 'string' && chanRefreshSourceId.length > 0 ? chanRefreshSourceId : ALL_SOURCES,
    );

    logger.debug(`✅ Channel refresh complete: ${channelCount} channels`);

    res.json({
      success: true,
      channelCount,
      message: `Refreshed ${channelCount} channels`,
    });
  } catch (error) {
    logger.error('❌ Failed to refresh channels:', error);
    res.status(500).json({
      error: 'Failed to refresh channel database',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
