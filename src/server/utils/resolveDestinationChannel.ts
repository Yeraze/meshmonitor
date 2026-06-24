import type databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Meshtastic supports channel indexes 0–7 (PRIMARY plus up to seven
 * secondary channels). Anything outside this range is not a transmittable
 * channel index.
 */
export const MAX_MESHTASTIC_CHANNEL_INDEX = 7;

/**
 * The well-known default Meshtastic PSK: a single 0x01 byte, stored base64 as
 * "AQ==". The firmware expands this to the public default channel key that
 * every node ships with, so any node in the mesh can decrypt a channel that
 * uses it. A channel with no PSK at all is unencrypted and likewise readable by
 * everyone. These are the only channels guaranteed traversable by intermediate
 * nodes — which is what traceroute requires (issue #3696).
 */
const DEFAULT_PSK_BASE64 = 'AQ==';

export function isValidChannelIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_MESHTASTIC_CHANNEL_INDEX
  );
}

/**
 * Resolve the channel index to transmit a mesh request (telemetry, traceroute,
 * position, NodeInfo, NeighborInfo) on, scoped to the source that will actually
 * send it.
 *
 * Background (issue #3573): these routes used to look up the destination node's
 * channel with the request body's `sourceId`, which several frontend callers
 * never send. With `sourceId` undefined, `NodesRepository.getNode` falls back to
 * a cross-source first-match and can return a row from an MQTT broker/bridge
 * source whose stored `channel` is not a valid Meshtastic channel index (e.g.
 * 101). The request was then transmitted on that bogus channel, so the target
 * node never received or answered it — the telemetry/traceroute/etc. silently
 * produced no response.
 *
 * Scoping the lookup to the *resolved manager's* `sourceId` guarantees the
 * channel reflects the mesh the request will traverse, and clamping to 0–7
 * defends against any residual out-of-range value.
 *
 * @param destinationNum Target node number.
 * @param manager The source manager the request will be sent through. Its
 *   `sourceId` is authoritative for the channel lookup.
 * @param db Injected database facade.
 * @param explicitChannel Optional caller-supplied channel (e.g. position
 *   requests accept one). Used as-is when it is a valid 0–7 index.
 * @returns A valid Meshtastic channel index (0–7), defaulting to 0.
 */
export async function resolveDestinationChannel(
  destinationNum: number,
  manager: { sourceId: string },
  db: typeof databaseService,
  explicitChannel?: unknown,
): Promise<number> {
  if (isValidChannelIndex(explicitChannel)) {
    return explicitChannel;
  }

  const node = await db.nodes.getNode(destinationNum, manager.sourceId);
  const stored = node?.channel ?? 0;
  if (isValidChannelIndex(stored)) {
    return stored;
  }

  logger.warn(
    `resolveDestinationChannel: node ${destinationNum.toString(16)} on source ${manager.sourceId} has out-of-range channel ${stored}; falling back to channel 0`,
  );
  return 0;
}

/**
 * True when a channel's PSK is one that every node in the mesh can decrypt:
 * the well-known default key ("AQ==") or no key at all (unencrypted).
 *
 * The ingest path stores an unencrypted channel as NULL psk (meshtasticManager
 * only base64-encodes a PSK when `psk.length > 0`, otherwise leaves it
 * undefined → NULL). Empty string is handled too, purely defensively, for any
 * row that slipped in with `''`.
 */
function isMeshReadablePsk(psk: string | null | undefined): boolean {
  return psk == null || psk === '' || psk === DEFAULT_PSK_BASE64;
}

/**
 * Resolve the channel a broadcast-style mesh request (e.g. traceroute) should
 * traverse so that EVERY intermediate node can decrypt and append to the
 * packet. Returns the lowest-numbered channel on the source whose PSK is the
 * well-known default key (or unencrypted); falls back to channel 0.
 *
 * Background (issue #3696, follow-up): traceroutes were first changed to always
 * use channel index 0, on the assumption that "channel 0 is readable by all".
 * That is false — channel 0 is merely the PRIMARY *slot*; its PSK can be a
 * private custom key. If a user reconfigures channel 0 with a private key,
 * hardcoding index 0 reproduces the original bug (opaque payload → "Unknown"
 * hops). What actually matters is the PSK, not the slot number, so we pick the
 * channel whose key the whole mesh shares.
 *
 * If no channel uses a mesh-readable key (the user encrypted every slot,
 * including PRIMARY), there is no channel a traceroute can cleanly traverse; we
 * log and fall back to 0 so the request still goes out.
 *
 * @param manager The source manager the request will be sent through.
 * @param db Injected database facade.
 * @returns A valid Meshtastic channel index (0–7).
 */
export async function resolveBroadcastChannel(
  manager: { sourceId: string },
  db: typeof databaseService,
): Promise<number> {
  const channels = await db.channels.getAllChannels(manager.sourceId);
  const readable = channels
    .filter((ch) => isValidChannelIndex(ch.id) && isMeshReadablePsk(ch.psk))
    .sort((a, b) => a.id - b.id);

  if (readable.length > 0) {
    return readable[0].id;
  }

  logger.warn(
    `resolveBroadcastChannel: source ${manager.sourceId} has no default-keyed (mesh-readable) channel ` +
      `among its ${channels.length} channel(s); falling back to channel 0. Traceroutes may show ` +
      '"Unknown" hops because intermediate nodes cannot decrypt an encrypted-channel payload (issue #3696).',
  );
  return 0;
}
