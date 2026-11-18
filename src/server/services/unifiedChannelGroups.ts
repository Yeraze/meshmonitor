/**
 * Unified channel grouping, shared by `GET /api/unified/channels` and
 * `GET /api/unified/senders`. Groups every channel the viewer may read, across
 * all sources, by case-insensitive name. Each ref is tagged `isVirtual` when it
 * is created, so callers never infer it from the channel number (MeshCore
 * indexes run to 255).
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannel,
} from '../utils/virtualChannelPermissions.js';
import {
  unifiedChannelDisplayName,
  loadSourcePresetNames,
  loadEnabledVirtualChannels,
  PRIMARY_CHANNEL_NAME,
} from '../utils/unifiedChannelNames.js';
import type { DbChannelDatabase } from '../../db/types.js';
import type { User } from '../../types/auth.js';

export interface UnifiedChannelRef {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  channelNumber: number;
  isVirtual: boolean;
  /** Present on virtual refs: the channel-database row behind the ref. */
  virtualRow?: DbChannelDatabase;
}

export interface UnifiedChannelGroup {
  name: string;
  sources: UnifiedChannelRef[];
}

export async function buildUnifiedChannelGroups(
  user: User | undefined,
  isAdmin: boolean
): Promise<UnifiedChannelGroup[]> {
  // Virtual channels and their permissions are global (not per-source), so
  // load them once up front rather than per source in the loop below.
  const [sources, virtualChannels, readableVirtualIds] = await Promise.all([
    databaseService.sources.getAllSources(),
    loadEnabledVirtualChannels(),
    getUserReadableVirtualChannelIds(user, isAdmin),
  ]);
  // Modem preset per source: the fallback display name for empty-named slot 0
  // so TCP and MQTT-side rows for the same logical channel collapse to one
  // picker entry.
  const sourcePresets = await loadSourcePresetNames(sources.map((s) => s.id));

  // Group case-insensitively so cross-device casing drift (e.g. one source
  // stores "primary", another stores "" -> "Primary") doesn't split the
  // unified picker into two entries that each show only half the messages.
  // Key is `name.toLowerCase()`; we keep the first-seen casing for display
  // but upgrade to a non-synthesized casing when one shows up later, so a
  // device-set name wins over the synthetic `Primary` fallback.
  const byName = new Map<string, { displayName: string; sources: UnifiedChannelRef[] }>();
  const upsert = (name: string, ref: UnifiedChannelRef) => {
    const key = name.toLowerCase();
    const entry = byName.get(key);
    if (entry) {
      entry.sources.push(ref);
      // Prefer a device-stored casing over the synthetic "Primary" fallback;
      // otherwise keep first-seen.
      if (entry.displayName === PRIMARY_CHANNEL_NAME && name !== PRIMARY_CHANNEL_NAME) {
        entry.displayName = name;
      }
    } else {
      byName.set(key, { displayName: name, sources: [ref] });
    }
  };

  await Promise.all(
    sources.map(async (source) => {
      // Check messages:read once per source (covers DMs and acts as "broad
      // read" grant). Per-channel read is checked individually below.
      const canReadMessages = isAdmin || (user
        ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
        : false);

      try {
        const chans = await databaseService.channels.getAllChannels(source.id);
        const presetName = sourcePresets.get(source.id) ?? null;
        for (const c of chans) {
          const name = unifiedChannelDisplayName(c as any, presetName);
          if (!name) continue; // disabled or unused slot
          const channelNum = (c as any).id as number;
          const canReadChannel = canReadMessages || (user
            ? await databaseService.checkPermissionAsync(
                user.id,
                `channel_${channelNum}`,
                'read',
                source.id,
              )
            : false);
          if (!canReadChannel) continue;
          upsert(name, {
            sourceId: source.id,
            sourceName: source.name,
            sourceType: source.type,
            channelNumber: channelNum,
            isVirtual: false,
          });
        }
      } catch (err) {
        logger.warn(`Failed to load channels for source ${source.id}:`, err);
      }

      // Virtual channels are global: every channel-database entry decrypts
      // packets from every source, so each virtual channel is surfaced under
      // every source at the synthetic channel number
      // `CHANNEL_DB_OFFSET + vcId` (same encoding used for stored message
      // rows; see meshtasticManager.ts dual-insert path). If a virtual
      // channel shares a name with a physical slot on the same source, both
      // entries collapse into the same `byName` group so the picker shows
      // one option; the `/messages` endpoint will union both channel
      // numbers when fetching.
      for (const vc of virtualChannels) {
        if (vc.id == null) continue;
        if (!canReadVirtualChannel(vc.id, readableVirtualIds)) continue;
        const name = (vc.name ?? '').trim();
        if (!name) continue;
        upsert(name, {
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
          channelNumber: CHANNEL_DB_OFFSET + vc.id,
          isVirtual: true,
          virtualRow: vc,
        });
      }
    })
  );

  return Array.from(byName.values())
    .map(({ displayName, sources: srcs }) => ({ name: displayName, sources: srcs }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
