import { describe, it, expect } from 'vitest';
import {
  packetLogDedupKey,
  isDuplicatePacketLog,
  PACKET_LOG_DEDUP_TTL_MS,
} from './packetLogDedup';

/**
 * Packet Monitor recently-seen guard (issue #4811). Verifies that exact
 * duplicate deliveries collapse while genuinely-distinct relay/transport copies
 * of the same packet id survive, and that entries expire after the TTL.
 */
describe('packetLogDedupKey', () => {
  it('distinguishes different relays and transports of the same packet id', () => {
    const a = packetLogDedupKey(10, 999, 1, 0);
    const b = packetLogDedupKey(10, 999, 2, 0); // different relay
    const c = packetLogDedupKey(10, 999, 1, 1); // different transport
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(packetLogDedupKey(10, 999, 1, 0)); // identical tuple
  });

  it('folds absent relay/transport to a stable token', () => {
    expect(packetLogDedupKey(10, 999, null, undefined)).toBe(packetLogDedupKey(10, 999, undefined, null));
  });
});

describe('isDuplicatePacketLog', () => {
  it('records a first sighting (not a duplicate) then flags the repeat', () => {
    const seen = new Map<string, number>();
    const key = packetLogDedupKey(10, 999, 1, 0);
    expect(isDuplicatePacketLog(seen, key, 1_000)).toBe(false);
    expect(isDuplicatePacketLog(seen, key, 1_500)).toBe(true);
    expect(isDuplicatePacketLog(seen, key, 1_600)).toBe(true);
  });

  it('does NOT collapse distinct relay/transport copies of one id', () => {
    const seen = new Map<string, number>();
    const now = 1_000;
    expect(isDuplicatePacketLog(seen, packetLogDedupKey(10, 999, 1, 0), now)).toBe(false);
    // Same id/sender, different relay -> distinct reception, kept.
    expect(isDuplicatePacketLog(seen, packetLogDedupKey(10, 999, 2, 0), now)).toBe(false);
    // Same id/sender/relay, different transport (LoRa vs MQTT) -> kept.
    expect(isDuplicatePacketLog(seen, packetLogDedupKey(10, 999, 1, 1), now)).toBe(false);
  });

  it('lets the same tuple through again after the TTL expires', () => {
    const seen = new Map<string, number>();
    const key = packetLogDedupKey(10, 999, 1, 0);
    expect(isDuplicatePacketLog(seen, key, 1_000)).toBe(false);
    // Just after expiry it is no longer a duplicate (pruned), and re-recorded.
    const afterExpiry = 1_000 + PACKET_LOG_DEDUP_TTL_MS + 1;
    expect(isDuplicatePacketLog(seen, key, afterExpiry)).toBe(false);
    expect(isDuplicatePacketLog(seen, key, afterExpiry + 1)).toBe(true);
  });

  it('prunes expired entries so the map does not grow unbounded', () => {
    const seen = new Map<string, number>();
    isDuplicatePacketLog(seen, packetLogDedupKey(10, 1, 0, 0), 1_000);
    isDuplicatePacketLog(seen, packetLogDedupKey(10, 2, 0, 0), 1_000);
    expect(seen.size).toBe(2);
    // A later call past the TTL prunes both stale entries before recording.
    isDuplicatePacketLog(seen, packetLogDedupKey(10, 3, 0, 0), 1_000 + PACKET_LOG_DEDUP_TTL_MS + 1);
    expect(seen.size).toBe(1);
  });
});
