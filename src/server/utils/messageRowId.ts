/**
 * Packet-id extraction from stored Meshtastic message row ids. Moved out of
 * `routes/unifiedRoutes.ts` (which re-exports it) so the message export
 * (#5517) can use it without importing a router.
 */

/**
 * Extract the Meshtastic packet id from a stored message row id.
 *
 * Message rows are keyed as `${sourceId}_${fromNodeNum}_${meshPacket.id}` so
 * that the same mesh packet received by multiple sources does NOT collide on
 * the primary key. The trailing numeric segment is the packet id set by the
 * originating node — identical across every receiver. This is the ONLY
 * reliable cross-source dedup key for received text messages because the
 * `requestId` column is only populated for Virtual Node ACK tracking, not for
 * ordinary received text.
 *
 * **Contract for every code path that inserts into `messages`:** this exact
 * format (underscores, fromNum middle, packetId last) is load-bearing.
 * Diverge from it — different separator, different field order, hyphens,
 * anything — and this parser returns null. The `/messages` dedup then falls
 * back to a `${fromNum}:${text}:${floor(timestamp/1000)}` heuristic. TCP and
 * MQTT receptions of the same packet arrive seconds apart, miss the 1s
 * window, and the user sees the same message N times in the unified view —
 * once per receiving source. See `src/server/mqttIngestion.ts` for examples
 * of MQTT-side ingest matching this format.
 *
 * Defensive validation (rowId comes from DB so trusted, but cheap to harden):
 *  - non-string or empty → null
 *  - unreasonably long (>256 chars) → null, guards against malformed input
 *  - trailing segment must be a non-negative finite integer within the
 *    Meshtastic packet id range (unsigned 32-bit)
 *
 * Returns `null` when the id cannot be parsed to a valid packet id.
 */
const MAX_ROW_ID_LENGTH = 256;
const MAX_PACKET_ID = 0xffffffff; // unsigned 32-bit
// Suffixes appended by meshtasticManager when inserting server-decrypted
// copies of the same mesh packet. Stripping them before numeric extraction
// ensures _dbchan / _radio copies get the same dedupKey as the original row
// rather than falling back to the text+timestamp key (#3719).
const SERVER_COPY_SUFFIXES = new Set(['dbchan', 'radio']);

export function extractPacketIdFromRowId(rowId: unknown): number | null {
  if (typeof rowId !== 'string' || rowId.length === 0 || rowId.length > MAX_ROW_ID_LENGTH) {
    return null;
  }
  const parts = rowId.split('_');
  if (parts.length < 2) return null;
  // Strip known server-added suffixes so `_dbchan` / `_radio` copies resolve
  // to the same numeric packet id as the original row.
  const tailIdx = SERVER_COPY_SUFFIXES.has(parts[parts.length - 1])
    ? parts.length - 2
    : parts.length - 1;
  if (tailIdx < 1) return null;
  const last = parts[tailIdx];
  // Reject anything that isn't pure digits — Number.parseInt would otherwise
  // accept things like "12abc" → 12.
  if (!/^\d+$/.test(last)) return null;
  const n = Number.parseInt(last, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PACKET_ID) return null;
  return n;
}
