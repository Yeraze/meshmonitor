/**
 * Channel-name helpers shared by the unified views (`routes/unifiedRoutes.ts`)
 * and the message export (#5517), so a channel picked by name in either place
 * resolves to the same slots on every source.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { modemPresetChannelName } from '../constants/meshtastic.js';
import type { DbChannelDatabase } from '../../db/types.js';

/**
 * Resolve a channel's display name for unified views.
 *
 * Meshtastic channel conventions:
 *  - Channel 0 is always the PRIMARY channel. Its name is often blank because
 *    the firmware derives the on-wire channel name from the modem preset at
 *    runtime — `MEDIUM_FAST` → "MediumFast" — and uses that derived name for
 *    both the channel hash and the `ServiceEnvelope.channelId` it publishes
 *    to MQTT. When we have the source's preset on hand (via
 *    `lora.preset.<sourceId>` in the settings table), use the preset's
 *    pascal-case label so the TCP-side empty-name channel groups with
 *    MQTT-side rows that carry the same label. Falls back to "Primary" only
 *    when no preset is known.
 *  - Channels with `role === 0` are DISABLED — skip entirely.
 *  - Any other channel with a blank name is a disabled/unused slot — skip.
 *
 * Returns `null` when the channel should be omitted from the unified list.
 */
export const PRIMARY_CHANNEL_NAME = 'Primary';
export function unifiedChannelDisplayName(
  c: { id: number; name?: string | null; role?: number | null },
  presetName?: string | null,
): string | null {
  if (c.role === 0) return null; // DISABLED
  const name = (c.name ?? '').trim();
  if (name) return name;
  if (c.id === 0) return presetName ?? PRIMARY_CHANNEL_NAME;
  return null;
}

/**
 * Load the modem-preset-derived channel name for each source the caller can
 * see. Returns a Map<sourceId, presetName | null>. Sources without a stored
 * `lora.preset.<sourceId>` setting (e.g. MQTT bridges/brokers, MeshCore
 * sources, or TCP sources we've never received config from) map to null.
 *
 * Heavy callers fetch this once up front and pass per-source slices into
 * `unifiedChannelDisplayName` so we don't hit the settings table on every
 * channel row.
 */
export async function loadSourcePresetNames(sourceIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    sourceIds.map(async (sid) => {
      try {
        const raw = await databaseService.settings.getSetting(`lora.preset.${sid}`);
        if (raw === null || raw === undefined) {
          out.set(sid, null);
          return;
        }
        const n = Number(raw);
        out.set(sid, Number.isFinite(n) ? modemPresetChannelName(n) : null);
      } catch {
        out.set(sid, null);
      }
    }),
  );
  return out;
}

/** Every enabled Channel Database (virtual channel) entry; [] on error. */
export async function loadEnabledVirtualChannels(): Promise<DbChannelDatabase[]> {
  try {
    const all = await databaseService.channelDatabase.getAllAsync();
    return all.filter((vc) => vc.isEnabled);
  } catch (err) {
    logger.warn('Failed to load virtual channels:', err);
    return [];
  }
}
