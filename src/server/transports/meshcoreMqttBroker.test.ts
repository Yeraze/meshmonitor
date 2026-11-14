import { describe, it, expect } from 'vitest';
import { MqttFrameSizeGuard } from './meshcoreMqttBroker.js';

describe('MqttFrameSizeGuard', () => {
  it('passes packets at or under the limit, across chunk boundaries', () => {
    const g = new MqttFrameSizeGuard(200);
    // PUBLISH with remaining length 150 (0x96 0x01), body split over chunks.
    expect(g.feed(Buffer.from([0x30, 0x96]))).toBe(true);
    expect(g.feed(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(100)]))).toBe(true);
    expect(g.feed(Buffer.alloc(50))).toBe(true);
    // Next packet in the same stream: PINGREQ (remaining length 0).
    expect(g.feed(Buffer.from([0xc0, 0x00]))).toBe(true);
  });

  it('fails as soon as a packet declares more than the limit', () => {
    const g = new MqttFrameSizeGuard(200);
    expect(g.feed(Buffer.from([0x30, 0xc9, 0x01]))).toBe(false); // 201
  });

  it('fails on a malformed five-byte remaining length', () => {
    const g = new MqttFrameSizeGuard(Number.MAX_SAFE_INTEGER);
    expect(g.feed(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x80, 0x01]))).toBe(false);
  });
});
