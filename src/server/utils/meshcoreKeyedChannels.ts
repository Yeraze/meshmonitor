/**
 * Keyed MeshCore channels (#5551): channels a source has messages on but no
 * slot for, because it decrypted them with a key stored on another source (a
 * MESH_PACKET_LOGGING repeater). Each is filed under
 * `keyedChannelIndex(secret)` and its rows carry the key's fingerprint.
 *
 * These helpers name those channels (from the `channels` row that holds the
 * key) and list the ones a viewer may see, so the source's channel list and
 * the unified feed can show them. Names only — never a secret.
 */
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import { channelKeyFingerprint, pskToHex, type ChannelKeyRow } from '../services/meshcoreFrameIngest.js';
import { resolveMeshcoreKeyAccess, type KeyAccessUser } from './meshcoreKeyAccess.js';

/** One keyed channel on a source. */
export interface KeyedChannelEntry {
  /** The channel index messages are filed under (`channel-<id>`). */
  id: number;
  name: string;
  keyFingerprint: string;
}

function parseChannelKey(key: string): number | null {
  if (!key.startsWith('channel-')) return null;
  const n = Number(key.slice('channel-'.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Every keyed channel with messages on `sourceId`, named from the channel row
 * that holds its key: the recorded (keySourceId, keyChannelIdx) row when it
 * still holds that key, else any row with the same secret, else ''.
 */
export async function listKeyedChannels(
  sourceId: string,
  rows?: ChannelKeyRow[],
): Promise<KeyedChannelEntry[]> {
  const summaries = await databaseService.meshcore.getKeyedChannelSummaries(sourceId);
  if (summaries.length === 0) return [];
  const all = rows ?? ((await databaseService.channels.getAllChannels(ALL_SOURCES)) as ChannelKeyRow[]);

  const nameByFp = new Map<string, string>();
  const exact = new Map<string, string>();
  for (const ch of all) {
    const secretHex = pskToHex(ch.psk);
    if (!secretHex) continue;
    const fp = channelKeyFingerprint(secretHex);
    const name = typeof ch.name === 'string' ? ch.name : '';
    if (name && !nameByFp.has(fp)) nameByFp.set(fp, name);
    exact.set(`${ch.sourceId ?? ''}\u0000${Number(ch.id)}\u0000${fp}`, name);
  }

  // A virtual channel's own name (#5552) wins over a same-secret device slot:
  // it is the name an admin gave the key on purpose.
  try {
    for (const vc of await databaseService.channelDatabase.getAllAsync('meshcore')) {
      const secretHex = pskToHex(vc.psk);
      if (secretHex && vc.name) nameByFp.set(channelKeyFingerprint(secretHex), vc.name);
    }
  } catch {
    // Names fall back to the device rows.
  }

  const byId = new Map<number, KeyedChannelEntry>();
  for (const s of summaries) {
    const id = parseChannelKey(s.channelKey);
    if (id === null || byId.has(id)) continue;
    const recorded = exact.get(`${s.keySourceId ?? ''}\u0000${s.keyChannelIdx ?? -1}\u0000${s.keyFingerprint}`);
    byId.set(id, {
      id,
      name: recorded || nameByFp.get(s.keyFingerprint) || '',
      keyFingerprint: s.keyFingerprint,
    });
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Channel index -> display name for the keyed channels on `sourceId`. */
export async function keyedChannelNames(sourceId: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const e of await listKeyedChannels(sourceId)) {
    if (e.name) out.set(e.id, e.name);
  }
  return out;
}

/**
 * The keyed channels on `sourceId` that `user` may see: admins see all;
 * others need `messages:read` on `sourceId` (keyed indices sit above the
 * `channel_0..7` resources, so that is what `canAccessMeshcoreChannel` checks
 * for them) AND read access to the key on a source that holds it.
 */
export async function listKeyedChannelsForViewer(
  user: KeyAccessUser | null | undefined,
  sourceId: string,
): Promise<KeyedChannelEntry[]> {
  if (!user) return [];
  const all = (await databaseService.channels.getAllChannels(ALL_SOURCES)) as ChannelKeyRow[];
  const entries = await listKeyedChannels(sourceId, all);
  if (entries.length === 0 || user.isAdmin) return entries;
  if (!(await databaseService.checkPermissionAsync(user.id, 'messages', 'read', sourceId))) return [];
  const access = await resolveMeshcoreKeyAccess(user, all);
  if (access === 'all') return entries;
  const allowed = new Set(access);
  return entries.filter((e) => allowed.has(e.keyFingerprint));
}
