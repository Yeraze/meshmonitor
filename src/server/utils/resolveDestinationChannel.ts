import type databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Meshtastic supports channel indexes 0–7 (PRIMARY plus up to seven
 * secondary channels). Anything outside this range is not a transmittable
 * channel index.
 */
export const MAX_MESHTASTIC_CHANNEL_INDEX = 7;

function isValidChannelIndex(value: unknown): value is number {
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
