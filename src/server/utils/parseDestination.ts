/**
 * Destination parsing for routes that accept a Meshtastic node identifier
 * in their request body (DM, traceroute, position request, NodeInfo request,
 * NeighborInfo request, telemetry request).
 *
 * Accepts:
 *   - a JS number that's already a valid uint32 `nodeNum`
 *   - an 8-char hex string with optional `!` prefix (the canonical
 *     Meshtastic nodeId, e.g. `!ad8c9eff`)
 *   - a 64-char hex string (a 32-byte public key) — looks up the node by
 *     its `publicKey` column and returns the resolved `nodeNum`
 *
 * Returns `null` for anything else: route handlers should treat null as a
 * client error and respond with HTTP 400.
 *
 * Background (issue #3186): the previous parsing did `parseInt(input, 16)`
 * with no length check, so a 64-hex-char public key pasted as the
 * destination would parse into ~2.7e+76, overflow PG's `bigint`, and crash
 * the request with a `DrizzleQueryError`. This helper rejects malformed
 * inputs up front and treats long hex strings as public keys instead.
 */
import { isValidNodeNum } from '../constants/meshtastic.js';
import { logger } from '../../utils/logger.js';
import type databaseService from '../../services/database.js';

const NODE_ID_HEX_RE = /^[0-9a-f]{8}$/i;
const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * Resolve a route's `destination` field to a Meshtastic 32-bit nodeNum.
 *
 * @param destination Value as received from the request body. String or
 *   number; anything else is rejected.
 * @param sourceId Source to scope `publicKey` lookups by. When omitted, the
 *   lookup falls back to a cross-source first-match (legacy behavior).
 * @param db Injected database facade so this helper is testable without a
 *   global singleton import.
 * @returns The validated `nodeNum`, or `null` if the input is malformed,
 *   out of range, or names an unknown publicKey.
 */
export async function parseDestinationNum(
  destination: unknown,
  sourceId: string | undefined,
  db: typeof databaseService,
): Promise<number | null> {
  // Pre-parsed number from the client.
  if (typeof destination === 'number') {
    if (isValidNodeNum(destination)) return destination;
    logger.warn(`parseDestinationNum: rejecting out-of-range numeric destination ${destination}`);
    return null;
  }

  if (typeof destination !== 'string') return null;

  // Strip a single leading `!` and any whitespace; lowercase for matching.
  const raw = destination.trim().replace(/^!/, '').toLowerCase();

  if (NODE_ID_HEX_RE.test(raw)) {
    const num = parseInt(raw, 16);
    return isValidNodeNum(num) ? num : null;
  }

  if (PUBLIC_KEY_HEX_RE.test(raw)) {
    // Repository stores publicKey as base64 (32-byte key → 44 base64 chars).
    const base64 = Buffer.from(raw, 'hex').toString('base64');
    const node = await db.nodes.getNodeByPublicKey(base64, sourceId);
    if (!node) {
      logger.warn(
        `parseDestinationNum: no node matches publicKey ${raw.slice(0, 16)}…${sourceId ? ` (source ${sourceId})` : ''}`,
      );
      return null;
    }
    if (!isValidNodeNum(node.nodeNum)) {
      // A stored row whose nodeNum is itself bad — should be unreachable
      // post-issue-#3186 but guard so we never propagate junk downstream.
      logger.error(
        `parseDestinationNum: stored node has invalid nodeNum ${node.nodeNum} for publicKey ${raw.slice(0, 16)}…`,
      );
      return null;
    }
    return node.nodeNum;
  }

  logger.warn(
    `parseDestinationNum: rejecting destination "${destination}" — expected 8-hex nodeId or 64-hex publicKey`,
  );
  return null;
}
