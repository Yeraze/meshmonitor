import { describe, it, expect } from 'vitest';
import {
  packetLogDedupKey,
  isDuplicatePacketLog,
  isRfTransport,
  dedupTtlForTransport,
  PACKET_LOG_DEDUP_TTL_MS,
  PACKET_LOG_DEDUP_RF_TTL_MS,
  PACKET_LOG_DEDUP_MAX_ENTRIES,
} from './packetLogDedup';
import { TransportMechanism } from '../constants/meshtastic';

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

/**
 * Firmware 2.8 PhoneAPI NodeDB replay (issue #5034).
 *
 * The firmware periodically re-delivers each node's cached position/telemetry
 * with the ORIGINAL packet id, a stabilized rx_snr/hop set, and
 * transport_mechanism forced to TRANSPORT_LORA — so a replay is byte-alike to a
 * fresh LoRa reception on every field except `rx_time`, which keeps the original
 * first-heard timestamp. They arrive ~hourly, so the 30s window from #4811 never
 * spanned them.
 */
describe('RF replay suppression (#5034)', () => {
  const HOUR_MS = 60 * 60 * 1000;

  describe('isRfTransport', () => {
    it('treats every LoRa radio as RF', () => {
      expect(isRfTransport(TransportMechanism.LORA)).toBe(true);
      expect(isRfTransport(TransportMechanism.LORA_ALT1)).toBe(true);
      expect(isRfTransport(TransportMechanism.LORA_ALT2)).toBe(true);
      expect(isRfTransport(TransportMechanism.LORA_ALT3)).toBe(true);
    });

    it('treats an absent transport as RF (pre-2.8 firmware omits the field)', () => {
      expect(isRfTransport(undefined)).toBe(true);
      expect(isRfTransport(null)).toBe(true);
    });

    it('does NOT treat MQTT or multicast UDP as RF', () => {
      expect(isRfTransport(TransportMechanism.MQTT)).toBe(false);
      expect(isRfTransport(TransportMechanism.MULTICAST_UDP)).toBe(false);
    });
  });

  describe('dedupTtlForTransport', () => {
    it('gives RF the long window and everything else the short one', () => {
      expect(dedupTtlForTransport(TransportMechanism.LORA)).toBe(PACKET_LOG_DEDUP_RF_TTL_MS);
      expect(dedupTtlForTransport(undefined)).toBe(PACKET_LOG_DEDUP_RF_TTL_MS);
      expect(dedupTtlForTransport(TransportMechanism.MQTT)).toBe(PACKET_LOG_DEDUP_TTL_MS);
      expect(dedupTtlForTransport(TransportMechanism.MULTICAST_UDP)).toBe(PACKET_LOG_DEDUP_TTL_MS);
    });

    it('uses an RF window long enough to span the observed ~1h replay interval', () => {
      expect(PACKET_LOG_DEDUP_RF_TTL_MS).toBeGreaterThan(HOUR_MS);
    });
  });

  it('folds rx_time into the key so a re-reception of one id stays distinct', () => {
    const replay = packetLogDedupKey(10, 999, 0, TransportMechanism.LORA, 1_788_402_926);
    const fresh = packetLogDedupKey(10, 999, 0, TransportMechanism.LORA, 1_788_420_034);
    expect(replay).not.toBe(fresh);
    expect(replay).toBe(packetLogDedupKey(10, 999, 0, TransportMechanism.LORA, 1_788_402_926));
  });

  it('folds an absent rx_time to a stable token', () => {
    expect(packetLogDedupKey(10, 999, 0, 1, null)).toBe(packetLogDedupKey(10, 999, 0, 1));
    expect(packetLogDedupKey(10, 999, 0, 1, undefined)).toBe(packetLogDedupKey(10, 999, 0, 1, null));
  });

  it('suppresses hourly replays of a cached reception, then logs a genuine new one', () => {
    const seen = new Map<string, number>();
    const rfTtl = dedupTtlForTransport(TransportMechanism.LORA);
    // The device's own receive time for the reception the firmware cached.
    const cachedRxTime = 1_788_402_926;
    const replayKey = packetLogDedupKey(10, 999, 0, TransportMechanism.LORA, cachedRxTime);

    // 06:15 — the genuine reception. Logged.
    let now = 0;
    expect(isDuplicatePacketLog(seen, replayKey, now, rfTtl)).toBe(false);

    // 07:20, 08:20, 09:20 … — PhoneAPI replays the same cached packet. Each
    // carries the same rx_time, so each collapses, and each refreshes the entry
    // so suppression persists indefinitely while they keep arriving.
    for (let hour = 1; hour <= 5; hour++) {
      now = hour * HOUR_MS;
      expect(isDuplicatePacketLog(seen, replayKey, now, rfTtl)).toBe(true);
    }

    // 11:30 — the node is genuinely heard again: new rx_time, so a new row.
    now = 5 * HOUR_MS + 10 * 60 * 1000;
    const freshKey = packetLogDedupKey(10, 999, 0, TransportMechanism.LORA, cachedRxTime + 19_000);
    expect(isDuplicatePacketLog(seen, freshKey, now, rfTtl)).toBe(false);

    // …and replays of the NEW reception collapse against it in turn.
    expect(isDuplicatePacketLog(seen, freshKey, now + HOUR_MS, rfTtl)).toBe(true);
  });

  it('still keeps a flood rebroadcast heard via a different relay', () => {
    const seen = new Map<string, number>();
    const rfTtl = dedupTtlForTransport(TransportMechanism.LORA);
    const rxTime = 1_788_402_926;
    // Same packet id and rx_time, different relay -> a distinct reception with
    // its own SNR/hop data, which is the point of the packet monitor.
    expect(isDuplicatePacketLog(seen, packetLogDedupKey(10, 999, 1, 1, rxTime), 0, rfTtl)).toBe(false);
    expect(isDuplicatePacketLog(seen, packetLogDedupKey(10, 999, 2, 1, rxTime), 0, rfTtl)).toBe(false);
  });

  it('does NOT extend the window for MQTT, where repeats are real receptions', () => {
    const seen = new Map<string, number>();
    const mqttTtl = dedupTtlForTransport(TransportMechanism.MQTT);
    const key = packetLogDedupKey(10, 999, 0, TransportMechanism.MQTT, 1_788_402_926);
    expect(isDuplicatePacketLog(seen, key, 0, mqttTtl)).toBe(false);
    // An hour later the same MQTT tuple is logged again rather than swallowed.
    expect(isDuplicatePacketLog(seen, key, HOUR_MS, mqttTtl)).toBe(false);
  });

  it('caps retained entries, evicting oldest-inserted first', () => {
    const seen = new Map<string, number>();
    const rfTtl = dedupTtlForTransport(TransportMechanism.LORA);
    const maxEntries = 3;
    for (let id = 1; id <= 5; id++) {
      isDuplicatePacketLog(seen, packetLogDedupKey(10, id, 0, 1, 1_788_402_926), 0, rfTtl, maxEntries);
    }
    expect(seen.size).toBeLessThan(maxEntries + 1);
    // The newest survives; the first-inserted was evicted.
    expect(seen.has(packetLogDedupKey(10, 5, 0, 1, 1_788_402_926))).toBe(true);
    expect(seen.has(packetLogDedupKey(10, 1, 0, 1, 1_788_402_926))).toBe(false);
  });

  it('has a sane default entry cap', () => {
    expect(PACKET_LOG_DEDUP_MAX_ENTRIES).toBeGreaterThan(1_000);
  });
});
