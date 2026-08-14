import type databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { MODEM_PRESET_CHANNEL_NAMES } from '../../utils/loraFrequency.js';

/**
 * Meshtastic supports channel indexes 0–7 (PRIMARY plus up to seven
 * secondary channels). Anything outside this range is not a transmittable
 * channel index.
 */
export const MAX_MESHTASTIC_CHANNEL_INDEX = 7;

/**
 * ModemPreset index 2 ("VeryLongSlow") is deprecated and has no case in
 * firmware's `getModemPresetDisplayName()` — it always falls through to
 * "Invalid" on-device, so no real channel name can ever equal it. Excluded
 * from the well-known-name match below to mirror firmware's
 * `Channels::isWellKnownChannel()` (issue #4691).
 */
const NON_MATCHING_PRESET_INDEX = 2;

/**
 * Channel names that mirror one of firmware's ModemPreset display names
 * (`Channels::isWellKnownChannel()` matches PSK size against this set of
 * names, not just the LongFast/primary case).
 */
const WELL_KNOWN_CHANNEL_NAMES = new Set(
  Object.entries(MODEM_PRESET_CHANNEL_NAMES)
    .filter(([index]) => Number(index) !== NON_MATCHING_PRESET_INDEX)
    .map(([, name]) => name),
);

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
 * True when a channel's PSK is one every node in the mesh can compute: no key
 * at all (unencrypted), or any 1-byte shorthand PSK. Firmware's
 * `channelFileUsesPublicKey()` treats every 1-byte PSK (0x01-0xFF) as part of
 * the public "defaultpsk" family, not just the literal default byte
 * (0x01/"AQ=="), so a 1-byte value like "1A==" (0xD4) expands to the same
 * shared key space (issue #4691).
 *
 * The ingest path stores an unencrypted channel as NULL psk (meshtasticManager
 * only base64-encodes a PSK when `psk.length > 0`, otherwise leaves it
 * undefined → NULL). Empty string is handled too, purely defensively, for any
 * row that slipped in with `''`.
 */
function isMeshReadablePsk(psk: string | null | undefined): boolean {
  if (psk == null || psk === '') return true;
  try {
    return Buffer.from(psk, 'base64').length === 1;
  } catch {
    return false;
  }
}

/**
 * True when a channel's name matches one of firmware's ModemPreset display
 * names. Combined with {@link isMeshReadablePsk}, this mirrors firmware's
 * `Channels::isWellKnownChannel()`: the on-wire channel hash is
 * `hash(name) XOR hash(psk)`, so a mesh-readable PSK under a custom name
 * still hashes to something no other node's factory-configured channel
 * matches (issue #4691).
 */
function isWellKnownChannelName(name: string | null | undefined): boolean {
  return name != null && WELL_KNOWN_CHANNEL_NAMES.has(name);
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
  // A candidate must be an ENABLED slot. A DISABLED channel (role 0) has no key
  // configured on the node, so the firmware refuses to encode a packet on that
  // index and NAKs the sender NO_CHANNEL (6) — traceroute never leaves the node
  // (issue #4173). Disabled slots are stored with a NULL psk, which would
  // otherwise pass isMeshReadablePsk() below and, if lower-numbered than the
  // primary, get selected (e.g. private-key PRIMARY at 0 + disabled slots 1–7).
  // Among enabled slots we still prefer a well-known channel — mesh-readable
  // PSK AND a name matching a ModemPreset display name — so every
  // intermediate node's factory-configured channel hashes to the same value
  // and can decrypt & append the hop (issues #3696, #4691).
  const readable = channels
    .filter(
      (ch) =>
        isValidChannelIndex(ch.id) &&
        ch.role !== 0 &&
        isMeshReadablePsk(ch.psk) &&
        isWellKnownChannelName(ch.name),
    )
    .sort((a, b) => a.id - b.id);

  if (readable.length > 0) {
    return readable[0].id;
  }

  logger.warn(
    `resolveBroadcastChannel: source ${manager.sourceId} has no ENABLED default-keyed (mesh-readable) ` +
      `channel among its ${channels.length} channel(s); falling back to channel 0 (the PRIMARY slot, which ` +
      'is always enabled). Traceroutes may show "Unknown" hops if the primary uses a private key (issue #3696).',
  );
  return 0;
}
