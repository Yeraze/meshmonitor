/**
 * Reticulum interface-history telemetry helpers (epic #3960, Phase 1a WP1).
 *
 * The interface throughput history rides the SHARED `telemetry` table rather
 * than a dedicated Reticulum history table — see
 * `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §3.2 / §7 risk 1
 * (RESOLVED, LOCKED). The `telemetry.nodeNum` column's `.references(() =>
 * nodes.nodeNum)` is vestigial (migration 041 dropped the FK on SQLite; PG/
 * MySQL never declared it — see the spec for the full history), so writing a
 * row with a synthetic nodeNum and no matching `nodes` row is safe on every
 * backend. MeshCore already does exactly this for its own telemetry
 * (`nodeNumFromPubkey` in `meshcoreTelemetryPoller.ts`); this module is the
 * Reticulum analogue, keyed by interface name instead of a public key.
 *
 * The actual poller that calls `insertTelemetryBatch` with these values is
 * WP4 (`ReticulumManager`) — this module only provides the stable mapping so
 * every future writer/reader agrees on the derived identity.
 */

/**
 * Standard CRC-32 (CRC-32/ISO-HDLC, a.k.a. zlib crc32): reflected, polynomial
 * 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF. Hand-rolled rather than
 * using Node's `zlib.crc32` (Node 22.2+ only) to match the project's existing
 * hand-rolled implementation (`src/services/lowEntropyKeyService.ts`).
 * Verified against the canonical `crc32("123456789") === 0xCBF43926` vector
 * in the tests.
 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Derive a stable, synthetic `nodeNum` for a Reticulum interface so its
 * throughput history can be written to the shared `telemetry` table (which
 * requires a non-null `nodeNum`). Computed as `crc32("if:<interfaceName>")`,
 * masked to a positive 31-bit int (the `telemetry.nodeNum` column mirrors
 * `nodes.nodeNum`, which callers elsewhere treat as unsigned 32-bit, but
 * masking to 31 bits keeps this value unambiguously positive across every
 * JS/SQL numeric boundary — same convention as
 * `meshcoreTelemetryPoller.nodeNumFromPubkey`).
 *
 * Deterministic and collision-free for any two distinct interface names
 * short of an actual CRC-32 collision — stable across restarts/reconnects
 * since it depends only on the interface's display name, not connection
 * order.
 */
export function reticulumInterfaceNodeNum(interfaceName: string): number {
  if (!interfaceName) return 0;
  return crc32(Buffer.from(`if:${interfaceName}`, 'utf8')) & 0x7fffffff;
}

/**
 * Synthetic `telemetry.nodeId` for a Reticulum interface's history rows.
 * Namespaced with `rns:iface:` so it can never collide with a Meshtastic
 * `!hexnodeid` or a MeshCore 64-char hex public key.
 */
export function reticulumInterfaceNodeId(interfaceName: string): string {
  return `rns:iface:${interfaceName}`;
}

/** `telemetry.telemetryType` values used for Reticulum interface history. */
export const RETICULUM_IFACE_TX_RATE = 'reticulum_iface_tx_rate';
export const RETICULUM_IFACE_RX_RATE = 'reticulum_iface_rx_rate';
