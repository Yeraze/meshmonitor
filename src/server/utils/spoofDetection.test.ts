import { describe, it, expect } from 'vitest';
import {
  detectLocalNodeSpoof,
  hasRfReceptionMarkers,
  SentPacketIdCache,
  type SpoofDetectionInput,
} from './spoofDetection.js';

const LOCAL = 0x11223344;
const OTHER = 0xaabbccdd;

// Genuine local transmission as the host sees it: INTERNAL transport, fresh hop
// count, no reception metadata.
const genuineLocalTx: SpoofDetectionInput = {
  fromNum: LOCAL,
  localNodeNum: LOCAL,
  transportMechanism: 0, // INTERNAL
  hopStart: 3,
  hopLimit: 3,
  rxSnr: 0,
  rxRssi: 0,
  viaMqtt: false,
};

// A spoof: claims to be us, but arrived over LoRa with RX metadata and travelled.
const spoofedRf: SpoofDetectionInput = {
  fromNum: LOCAL,
  localNodeNum: LOCAL,
  transportMechanism: 1, // LORA
  hopStart: 3,
  hopLimit: 1,
  rxSnr: -7.5,
  rxRssi: -110,
  viaMqtt: false,
  packetId: 999,
  wasRecentlySentByUs: false,
};

describe('hasRfReceptionMarkers', () => {
  it('is false for a genuine local transmission (no RX metadata, fresh hops)', () => {
    expect(hasRfReceptionMarkers(genuineLocalTx)).toBe(false);
  });

  it('treats a non-zero rxSnr as a reception marker', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, rxSnr: -8 })).toBe(true);
  });

  it('treats a non-zero rxRssi as a reception marker', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, rxRssi: -95 })).toBe(true);
  });

  it('does NOT treat rxSnr/rxRssi of exactly 0 as a marker (self-origin default)', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, rxSnr: 0, rxRssi: 0 })).toBe(false);
  });

  it('treats hopStart > hopLimit (travelled) as a marker', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, hopStart: 3, hopLimit: 1 })).toBe(true);
  });

  it('does not treat equal hopStart/hopLimit as travelled', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, hopStart: 3, hopLimit: 3 })).toBe(false);
  });

  it('treats viaMqtt as a reception marker', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, viaMqtt: true })).toBe(true);
  });

  it('treats a radio transport (LORA/MQTT/UDP) as a reception marker', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, transportMechanism: 1 })).toBe(true); // LORA
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, transportMechanism: 5 })).toBe(true); // MQTT
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, transportMechanism: 6 })).toBe(true); // UDP
  });

  it('does not treat INTERNAL/API/undefined transport as a marker', () => {
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, transportMechanism: 0 })).toBe(false);
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, transportMechanism: 7 })).toBe(false);
    expect(hasRfReceptionMarkers({ ...genuineLocalTx, transportMechanism: undefined })).toBe(false);
  });
});

describe('detectLocalNodeSpoof', () => {
  it('classifies a genuine local transmission as tx, not spoof', () => {
    expect(detectLocalNodeSpoof(genuineLocalTx)).toEqual({
      isGenuineLocalTx: true,
      spoofSuspected: false,
    });
  });

  it('flags a spoofed RF packet claiming our node number', () => {
    expect(detectLocalNodeSpoof(spoofedRf)).toEqual({
      isGenuineLocalTx: false,
      spoofSuspected: true,
    });
  });

  it('ignores packets from other nodes entirely (Phase 1 = self only)', () => {
    expect(detectLocalNodeSpoof({ ...spoofedRf, fromNum: OTHER })).toEqual({
      isGenuineLocalTx: false,
      spoofSuspected: false,
    });
  });

  it('does not flag when the local node is unknown', () => {
    expect(detectLocalNodeSpoof({ ...spoofedRf, localNodeNum: null })).toEqual({
      isGenuineLocalTx: false,
      spoofSuspected: false,
    });
  });

  it('does NOT flag our own packet overheard back (id in sent buffer)', () => {
    // Same RF shape as a spoof, but it is a packet we originated.
    expect(detectLocalNodeSpoof({ ...spoofedRf, wasRecentlySentByUs: true })).toEqual({
      isGenuineLocalTx: false,
      spoofSuspected: false,
    });
  });

  it('does NOT flag our own message echoed back via the MQTT bridge (id in buffer)', () => {
    const mqttEcho: SpoofDetectionInput = {
      fromNum: LOCAL,
      localNodeNum: LOCAL,
      transportMechanism: 5, // MQTT
      viaMqtt: true,
      hopStart: 3,
      hopLimit: 3,
      packetId: 555,
      wasRecentlySentByUs: true,
    };
    expect(detectLocalNodeSpoof(mqttEcho)).toEqual({
      isGenuineLocalTx: false,
      spoofSuspected: false,
    });
  });

  it('flags an MQTT-echoed packet claiming us that we did NOT send (spoof via MQTT)', () => {
    const mqttSpoof: SpoofDetectionInput = {
      fromNum: LOCAL,
      localNodeNum: LOCAL,
      transportMechanism: 5,
      viaMqtt: true,
      packetId: 556,
      wasRecentlySentByUs: false,
    };
    expect(detectLocalNodeSpoof(mqttSpoof).spoofSuspected).toBe(true);
  });

  it('stays quiet on an ambiguous self-claim with no concrete RF markers', () => {
    // from==us, transport unknown, no rx metadata, fresh hops, not in buffer.
    const ambiguous: SpoofDetectionInput = {
      fromNum: LOCAL,
      localNodeNum: LOCAL,
      transportMechanism: undefined,
      hopStart: undefined,
      hopLimit: undefined,
      rxSnr: undefined,
      rxRssi: undefined,
      wasRecentlySentByUs: false,
    };
    // No RF markers ⇒ treated as a (genuine) local origin, never a spoof.
    expect(detectLocalNodeSpoof(ambiguous)).toEqual({
      isGenuineLocalTx: true,
      spoofSuspected: false,
    });
  });
});

describe('SentPacketIdCache', () => {
  it('records and recognises a sent packet id', () => {
    const cache = new SentPacketIdCache();
    cache.record(1234);
    expect(cache.has(1234)).toBe(true);
    expect(cache.has(5678)).toBe(false);
  });

  it('ignores id 0 / null / undefined', () => {
    const cache = new SentPacketIdCache();
    cache.record(0);
    cache.record(null);
    cache.record(undefined);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(null)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('expires entries after the TTL', () => {
    let t = 1_000_000;
    const cache = new SentPacketIdCache({ ttlMs: 1000, now: () => t });
    cache.record(42);
    expect(cache.has(42)).toBe(true);
    t += 1001;
    expect(cache.has(42)).toBe(false);
  });

  it('evicts oldest entries past the size cap', () => {
    const cache = new SentPacketIdCache({ maxEntries: 3 });
    cache.record(1);
    cache.record(2);
    cache.record(3);
    cache.record(4); // evicts 1
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(4)).toBe(true);
    expect(cache.size).toBe(3);
  });
});
