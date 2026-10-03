/**
 * Decrypt-on-read for the MeshCore Packet Monitor decode modal (#5567, #5568).
 *
 * The packet log stores ciphertext. When a viewer opens a GRP_TXT (0x05) or
 * GRP_DATA (0x06) packet, this opens it with a channel key the server holds
 * and returns the plaintext for that one response. Nothing is stored, and no
 * secret leaves the server.
 *
 * Key pool (#5568): every `channels` row on every source, plus the enabled
 * MeshCore virtual channels in `channel_database`.
 *
 * Access rule: the same one that gates keyed channel messages
 * (`resolveMeshcoreKeyAccess` / `canSeeKeyedMessage`). A key is tried only
 * when the viewer may read a channel holding that secret. So a viewer without
 * access gets exactly the answer a server without the key would give, and
 * cannot learn from this endpoint that the key exists. Anonymous viewers never
 * get plaintext, whatever the anonymous user has been granted.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import {
  channelKeyFingerprint,
  findChannelKeysByHash,
  openGroupFrame,
  pskToHex,
  type ChannelKeyRow,
  type OpenedGroupFrame,
} from '../services/meshcoreFrameIngest.js';
import { canSeeKeyedMessage, resolveMeshcoreKeyAccess } from './meshcoreKeyAccess.js';

/** The caller fields this module reads. */
export interface PacketDecodeViewer {
  id: number;
  username?: string;
  isAdmin?: boolean;
}

/** Where the key that opened a frame is stored. Never the key itself. */
export type GroupKeyOrigin =
  | { kind: 'source'; sourceName: string; currentSource: boolean }
  | { kind: 'virtual' };

/**
 * The answer for one group packet.
 *
 * `decrypted: false` is the ONE shape for both "no such key" and "a key the
 * viewer may not read". Do not add a field that tells them apart.
 */
export type GroupPacketPlaintext =
  | { decrypted: false; payloadType: number; channelHash: string }
  | {
      decrypted: true;
      payloadType: number;
      channelHash: string;
      channelName: string;
      keyOrigin: GroupKeyOrigin;
      /** GRP_TXT. */
      text?: { sender: string | null; timestampSec: number; text: string };
      /** GRP_DATA. */
      data?: { dataType: number; dataHex: string };
    };

interface VirtualRow {
  id?: number;
  name?: string | null;
  psk?: string | null;
  isEnabled?: boolean;
}

/** A device slot's read rule, as in `canAccessMeshcoreChannel`. */
async function canReadDeviceRow(viewer: PacketDecodeViewer, row: ChannelKeyRow): Promise<boolean> {
  if (viewer.isAdmin) return true;
  if (!row.sourceId) return false;
  // Number(): ids are BIGINT on PostgreSQL / MySQL. 0-7 is the whole RBAC
  // resource set (`channel_0`..`channel_7`, see `channelResourceFor`); a higher
  // MeshCore slot is readable through `messages:read` on its source alone.
  const idx = Number(row.id);
  if (Number.isInteger(idx) && idx >= 0 && idx <= 7) {
    if (await databaseService.checkPermissionAsync(viewer.id, `channel_${idx}`, 'read', row.sourceId)) return true;
  }
  return databaseService.checkPermissionAsync(viewer.id, 'messages', 'read', row.sourceId);
}

/**
 * Name the channel and say where its key lives, choosing only among rows the
 * viewer may read: this source's slot, then a virtual channel, then a slot on
 * another source. Null when the viewer can read none of them.
 */
async function describeKey(
  viewer: PacketDecodeViewer,
  sourceId: string,
  secretHex: string,
  deviceRows: ChannelKeyRow[],
  virtualRows: VirtualRow[],
): Promise<{ channelName: string; keyOrigin: GroupKeyOrigin } | null> {
  const holders = deviceRows
    .filter((r) => pskToHex(r.psk) === secretHex)
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const row of holders.filter((r) => r.sourceId === sourceId)) {
    if (await canReadDeviceRow(viewer, row)) {
      const src = await databaseService.sources.getSource(sourceId);
      return {
        channelName: row.name ?? '',
        keyOrigin: { kind: 'source', sourceName: src?.name ?? sourceId, currentSource: true },
      };
    }
  }

  const virtualHolders = virtualRows.filter((r) => r.id !== undefined && pskToHex(r.psk) === secretHex);
  if (virtualHolders.length > 0) {
    const readable = viewer.isAdmin
      ? null
      : new Set(
          (await databaseService.channelDatabase.getPermissionsForUserAsync(viewer.id, 'all'))
            .filter((p) => p.canRead === true)
            .map((p) => p.channelDatabaseId),
        );
    for (const row of virtualHolders) {
      // null = admin, who reads every entry.
      if (readable === null || readable.has(row.id!)) {
        return { channelName: row.name ?? '', keyOrigin: { kind: 'virtual' } };
      }
    }
  }

  for (const row of holders.filter((r) => r.sourceId && r.sourceId !== sourceId)) {
    if (await canReadDeviceRow(viewer, row)) {
      const src = await databaseService.sources.getSource(row.sourceId!);
      return {
        channelName: row.name ?? '',
        keyOrigin: { kind: 'source', sourceName: src?.name ?? row.sourceId!, currentSource: false },
      };
    }
  }
  return null;
}

/** `openGroupFrame`, with a malformed key or ciphertext read as "did not open". */
function tryOpen(
  payloadType: number,
  group: { cipherMacHex: string; ciphertextHex: string },
  secretHex: string,
): OpenedGroupFrame | null {
  try {
    return openGroupFrame(payloadType, group, secretHex);
  } catch {
    return null;
  }
}

/**
 * Open one captured group packet for `viewer`, who is looking at `sourceId`.
 *
 * Returns null when `rawHex` is not a GRP_TXT / GRP_DATA frame with a group
 * header (the caller answers 400).
 */
export async function decodeGroupPacketForViewer(
  viewer: PacketDecodeViewer | null | undefined,
  sourceId: string,
  rawHex: string,
): Promise<GroupPacketPlaintext | null> {
  const packet = decodeMeshCorePacket(rawHex);
  const payloadType = packet?.header.payloadType;
  const group =
    payloadType === 0x05 ? packet?.payload.groupText : payloadType === 0x06 ? packet?.payload.groupData : undefined;
  if (!packet || payloadType === undefined || !group) return null;

  const unknown: GroupPacketPlaintext = { decrypted: false, payloadType, channelHash: group.channelHash };
  if (!viewer || viewer.username === 'anonymous') return unknown;

  const deviceRows = (await databaseService.channels.getAllChannels(ALL_SOURCES)) as ChannelKeyRow[];
  const access = await resolveMeshcoreKeyAccess(viewer, deviceRows);

  let virtualRows: VirtualRow[] = [];
  try {
    virtualRows = await databaseService.channelDatabase.getAllAsync('meshcore');
  } catch (err) {
    // Device keys stay usable.
    logger.warn('Failed to read MeshCore virtual channels for packet decode:', err);
  }

  const candidates = await findChannelKeysByHash(
    group.channelHash,
    deviceRows,
    virtualRows.filter((r) => r.isEnabled !== false),
  );

  const tried = new Set<string>();
  for (const key of candidates) {
    if (tried.has(key.secretHex)) continue;
    tried.add(key.secretHex);
    // Gate BEFORE the decrypt: a key the viewer may not read is never tried.
    if (!canSeeKeyedMessage(access, { keyFingerprint: channelKeyFingerprint(key.secretHex) })) continue;

    const opened = tryOpen(payloadType, group, key.secretHex);
    if (!opened) continue;

    const described = await describeKey(viewer, sourceId, key.secretHex, deviceRows, virtualRows);
    // Fail closed if no row is individually readable.
    if (!described) continue;

    const base = { decrypted: true as const, payloadType, channelHash: group.channelHash, ...described };
    return opened.kind === 'text'
      ? { ...base, text: { sender: opened.senderName, timestampSec: opened.timestampSec, text: opened.text } }
      : { ...base, data: { dataType: opened.dataType, dataHex: opened.dataHex } };
  }
  return unknown;
}
