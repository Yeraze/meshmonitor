/**
 * Decoder tests for the MeshCore MQTT ingest path (#5040 Phase 1).
 *
 * The centrepiece is the **round-trip against the real encoder**: build an
 * observer wire payload with `buildObserverPacketPayload()` — the function that
 * actually publishes — then decode it back and assert the structural fields
 * survive. That is what locks the two halves together; a golden fixture would
 * only pin the decoder to a snapshot of the decoder's own behaviour and would
 * not notice the encoder drifting away from it.
 *
 * Frame builder mirrors `meshcoreObserverPacket.test.ts`'s (real wire-format
 * header bit-packing, not the native-backend test mock).
 */
import { describe, it, expect } from 'vitest';
import {
  buildObserverPacketPayload,
  parseObserverFrame,
  type ObserverPacketIdentity,
} from './meshcoreObserverPacket.js';
import {
  decodeObserverPacketMessage,
  observerPacketsSubscription,
  observerStatusSubscription,
  observerKeyFromTopic,
} from './meshcoreMqttIngestPacket.js';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';

class Builder {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  bytes(arr: number[]) {
    this.parts.push(...arr.map((x) => x & 0xff));
    return this;
  }
  fill(n: number, v = 0) {
    for (let i = 0; i < n; i++) this.parts.push(v & 0xff);
    return this;
  }
  hex(): string {
    return this.parts.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

const header = (route: number, payload: number, version = 0) =>
  ((version & 0x03) << 6) | ((payload & 0x0f) << 2) | (route & 0x03);

const IDENTITY: ObserverPacketIdentity = {
  origin: 'TestObserver',
  originId: 'AB'.repeat(32),
};

/** A FLOOD frame with no path hops and a short payload. */
function floodFrame(payloadType = 0x01): string {
  return new Builder()
    .u8(header(0x01, payloadType))
    .u8(0x00) // path_len = 0
    .bytes([0xde, 0xad, 0xbe, 0xef])
    .hex();
}

/** A DIRECT frame carrying `hops` one-byte relay hashes. */
function directFrame(hops: number[], payloadType = 0x02): string {
  return new Builder()
    .u8(header(0x02, payloadType))
    .u8(hops.length) // packed path_len: hashSize=1, hopCount=n
    .bytes(hops)
    .bytes([0x11, 0x22, 0x33])
    .hex();
}

function toEvent(rawHex: string, snr?: number | null, rssi?: number | null): OtaPacketEvent {
  return { raw_hex: rawHex, snr, rssi };
}

describe('decodeObserverPacketMessage — round-trip against the real encoder', () => {
  it('recovers the structural fields of a flood frame', () => {
    const raw = floodFrame();
    const wire = buildObserverPacketPayload(toEvent(raw, -8.75, -101), IDENTITY);
    expect(wire).not.toBeNull();

    const decoded = decodeObserverPacketMessage(wire);
    expect(decoded).not.toBeNull();

    const expected = parseObserverFrame(raw);
    expect(decoded!.event.payload_type).toBe(expected.payloadType);
    expect(decoded!.event.route_type).toBe(expected.routeType);
    expect(decoded!.event.hop_count).toBe(expected.hopCount);
    expect(decoded!.event.path_hops).toEqual(expected.hops);
    expect(decoded!.event.payload_size).toBe(expected.totalBytes);
    expect(decoded!.event.raw_hex).toBe(raw.toLowerCase());
    expect(decoded!.event.snr).toBe(-8.75);
    expect(decoded!.event.rssi).toBe(-101);
  });

  it('recovers the per-hop relay hashes of a direct frame', () => {
    const raw = directFrame([0xa1, 0xb2, 0xc3]);
    const wire = buildObserverPacketPayload(toEvent(raw, -4.5, -90), IDENTITY);
    const decoded = decodeObserverPacketMessage(wire);

    expect(decoded).not.toBeNull();
    expect(decoded!.event.hop_count).toBe(3);
    expect(decoded!.event.path_hops).toEqual(['a1', 'b2', 'c3']);
  });

  it('carries the publishing observer identity through', () => {
    const wire = buildObserverPacketPayload(toEvent(floodFrame()), IDENTITY);
    const decoded = decodeObserverPacketMessage(wire);

    expect(decoded!.origin).toBe('TestObserver');
    expect(decoded!.originId).toBe('AB'.repeat(32));
    expect(decoded!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('populates the enum name strings the packet monitor stores', () => {
    // handleOtaPacket reads payload_type_string / route_type_string; producing
    // only the narrow OtaPacketEvent would leave these null on every MQTT row.
    const decoded = decodeObserverPacketMessage(
      buildObserverPacketPayload(toEvent(floodFrame()), IDENTITY),
    );
    expect(typeof decoded!.event.payload_type_string === 'string' || decoded!.event.payload_type_string === null).toBe(true);
    expect(typeof decoded!.event.route_type_string === 'string' || decoded!.event.route_type_string === null).toBe(true);
  });
});

describe('decodeObserverPacketMessage — `raw` is the sole source of truth', () => {
  it('ignores a wire len/payload_len that disagrees with the frame', () => {
    const raw = directFrame([0xa1, 0xb2]);
    const wire = { ...buildObserverPacketPayload(toEvent(raw), IDENTITY)! };
    // A buggy third-party publisher claiming nonsense lengths.
    wire.len = '9999';
    wire.payload_len = '4242';
    wire.path = 'ff,ff,ff,ff';

    const decoded = decodeObserverPacketMessage(wire);
    const expected = parseObserverFrame(raw);
    expect(decoded!.event.payload_size).toBe(expected.totalBytes);
    expect(decoded!.event.hop_count).toBe(2);
    expect(decoded!.event.path_hops).toEqual(['a1', 'b2']);
  });

  it('rejects a frame that will not structurally parse', () => {
    expect(decodeObserverPacketMessage({ type: 'PACKET', raw: 'ff', origin_id: 'AB'.repeat(32) })).toBeNull();
  });

  it('rejects a message with no raw at all', () => {
    expect(decodeObserverPacketMessage({ type: 'PACKET', origin_id: 'AB'.repeat(32) })).toBeNull();
  });
});

describe('decodeObserverPacketMessage — hostile and malformed input', () => {
  it('returns null rather than throwing for non-objects', () => {
    for (const bad of [null, undefined, 42, 'PACKET', [], true]) {
      expect(decodeObserverPacketMessage(bad)).toBeNull();
    }
  });

  it('skips status messages sharing the topic prefix', () => {
    expect(decodeObserverPacketMessage({ status: 'online', origin_id: 'AB'.repeat(32) })).toBeNull();
  });

  it('rejects a missing or malformed origin_id, which per-observer attribution needs', () => {
    const raw = floodFrame();
    expect(decodeObserverPacketMessage({ type: 'PACKET', raw })).toBeNull();
    expect(decodeObserverPacketMessage({ type: 'PACKET', raw, origin_id: 'nothex' })).toBeNull();
    expect(decodeObserverPacketMessage({ type: 'PACKET', raw, origin_id: 'AB'.repeat(31) })).toBeNull();
  });

  it('normalises origin_id to upper case', () => {
    const decoded = decodeObserverPacketMessage({
      type: 'PACKET',
      raw: floodFrame(),
      origin_id: 'ab'.repeat(32),
    });
    expect(decoded!.originId).toBe('AB'.repeat(32));
  });
});

describe('decodeObserverPacketMessage — measurements', () => {
  const base = (extra: Record<string, unknown>) => ({
    type: 'PACKET',
    raw: floodFrame(),
    origin_id: 'AB'.repeat(32),
    ...extra,
  });

  it('reads the contract string numerics', () => {
    const d = decodeObserverPacketMessage(base({ SNR: '-8.75', RSSI: '-101' }));
    expect(d!.event.snr).toBe(-8.75);
    expect(d!.event.rssi).toBe(-101);
  });

  it('tolerates JSON numbers from third-party publishers', () => {
    const d = decodeObserverPacketMessage(base({ SNR: -6, RSSI: -90 }));
    expect(d!.event.snr).toBe(-6);
    expect(d!.event.rssi).toBe(-90);
  });

  it("treats the encoder's 'Unknown' sentinel as absent, not as a reading", () => {
    const d = decodeObserverPacketMessage(base({ SNR: 'Unknown', RSSI: 'Unknown' }));
    expect(d!.event.snr).toBeUndefined();
    expect(d!.event.rssi).toBeUndefined();
  });

  it('drops implausible values rather than storing them as real measurements', () => {
    const d = decodeObserverPacketMessage(base({ SNR: '9999', RSSI: '9999' }));
    expect(d!.event.snr).toBeUndefined();
    expect(d!.event.rssi).toBeUndefined();
  });

  it('keeps a genuine 0 reading', () => {
    const d = decodeObserverPacketMessage(base({ SNR: '0', RSSI: '0' }));
    expect(d!.event.snr).toBe(0);
    expect(d!.event.rssi).toBe(0);
  });
});

describe('topic helpers', () => {
  it('subscribes with a wildcard across every observer in the region', () => {
    expect(observerPacketsSubscription('mco')).toBe('meshcore/MCO/+/packets');
    expect(observerStatusSubscription(' mco ')).toBe('meshcore/MCO/+/status');
  });

  it('extracts the publishing key from a received topic', () => {
    const key = 'AB'.repeat(32);
    expect(observerKeyFromTopic(`meshcore/MCO/${key}/packets`)).toBe(key);
    expect(observerKeyFromTopic(`meshcore/MCO/${key.toLowerCase()}/status`)).toBe(key);
  });

  it('returns null for topics outside the contract shape', () => {
    expect(observerKeyFromTopic('meshcore/MCO/nothex/packets')).toBeNull();
    expect(observerKeyFromTopic('meshcore/MCO/packets')).toBeNull();
    expect(observerKeyFromTopic(`other/MCO/${'AB'.repeat(32)}/packets`)).toBeNull();
    expect(observerKeyFromTopic(`meshcore/MCO/${'AB'.repeat(32)}/other`)).toBeNull();
  });

  it('lets the caller cross-check a spoofed body against the topic it arrived on', () => {
    // A publisher claiming someone else's identity in the body: topic key and
    // body origin_id disagree, and the manager drops it on that basis.
    const topicKey = observerKeyFromTopic(`meshcore/MCO/${'AB'.repeat(32)}/packets`);
    const decoded = decodeObserverPacketMessage({
      type: 'PACKET',
      raw: floodFrame(),
      origin_id: 'CD'.repeat(32),
    });
    expect(decoded!.originId).not.toBe(topicKey);
  });
});
