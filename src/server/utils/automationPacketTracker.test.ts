import { describe, it, expect, beforeEach } from 'vitest';
import {
  AutomationPacketTracker,
  AUTOMATION_PACKET_TTL_MS,
  AUTOMATION_PACKET_MAX_PER_SOURCE,
  randomPacketId,
} from './automationPacketTracker.js';

describe('AutomationPacketTracker (#5414)', () => {
  let now: number;
  let tracker: AutomationPacketTracker;

  beforeEach(() => {
    now = 1_000_000;
    tracker = new AutomationPacketTracker({ now: () => now });
  });

  it('matches a recorded automation packet by (from, id)', () => {
    tracker.record('src-a', 0xaaaa0001, 0x1234);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x1234)).toBe(true);
  });

  it('does not match an id that was never recorded (a manual send)', () => {
    tracker.record('src-a', 0xaaaa0001, 0x1234);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x9999)).toBe(false);
  });

  it('keeps matching within the TTL — several gateways can uplink the same packet', () => {
    tracker.record('src-a', 0xaaaa0001, 0x1234);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x1234)).toBe(true);
    now += AUTOMATION_PACKET_TTL_MS - 1;
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x1234)).toBe(true);
  });

  it('forgets a packet once the TTL passes (30 s)', () => {
    expect(AUTOMATION_PACKET_TTL_MS).toBe(30_000);
    tracker.record('src-a', 0xaaaa0001, 0x1234);
    now += AUTOMATION_PACKET_TTL_MS;
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x1234)).toBe(false);
    expect(tracker.size('src-a')).toBe(0);
  });

  it('evicts expired entries lazily on the next record, with no timer', () => {
    tracker.record('src-a', 0xaaaa0001, 1);
    tracker.record('src-a', 0xaaaa0001, 2);
    now += AUTOMATION_PACKET_TTL_MS + 1;
    tracker.record('src-a', 0xaaaa0001, 3);
    expect(tracker.size('src-a')).toBe(1);
  });

  it('caps each source at the hard size limit, evicting the oldest', () => {
    const small = new AutomationPacketTracker({ now: () => now, maxPerSource: 3 });
    for (let id = 1; id <= 5; id++) small.record('src-a', 0xaaaa0001, id);
    expect(small.size('src-a')).toBe(3);
    expect(small.isAutomationPacket(0xaaaa0001, 1)).toBe(false);
    expect(small.isAutomationPacket(0xaaaa0001, 2)).toBe(false);
    expect(small.isAutomationPacket(0xaaaa0001, 5)).toBe(true);
  });

  it('never grows past the default cap under a flood of sends', () => {
    for (let id = 1; id <= AUTOMATION_PACKET_MAX_PER_SOURCE * 3; id++) {
      tracker.record('src-a', 0xaaaa0001, id);
    }
    expect(tracker.size('src-a')).toBe(AUTOMATION_PACKET_MAX_PER_SOURCE);
  });

  it('isolates sources: an automation on A never matches a packet from B\'s node with the same id', () => {
    tracker.record('src-a', 0xaaaa0001, 0x1234);
    // Same 32-bit id, originated by source B's node — a manual send on B.
    expect(tracker.isAutomationPacket(0xbbbb0002, 0x1234)).toBe(false);
    // A's own node still matches.
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x1234)).toBe(true);
  });

  it('matches automation sends on each source against that source\'s own node', () => {
    tracker.record('src-a', 0xaaaa0001, 0x10);
    tracker.record('src-b', 0xbbbb0002, 0x20);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x10)).toBe(true);
    expect(tracker.isAutomationPacket(0xbbbb0002, 0x20)).toBe(true);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0x20)).toBe(false);
    expect(tracker.isAutomationPacket(0xbbbb0002, 0x10)).toBe(false);
  });

  it('caps are per source — a flood on A does not evict B', () => {
    const small = new AutomationPacketTracker({ now: () => now, maxPerSource: 2 });
    small.record('src-b', 0xbbbb0002, 99);
    for (let id = 1; id <= 10; id++) small.record('src-a', 0xaaaa0001, id);
    expect(small.isAutomationPacket(0xbbbb0002, 99)).toBe(true);
  });

  it('ignores id 0 and a missing local node number', () => {
    tracker.record('src-a', 0xaaaa0001, 0);
    tracker.record('src-a', undefined, 0x1234);
    tracker.record('src-a', null, 0x5678);
    expect(tracker.size('src-a')).toBe(0);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0)).toBe(false);
    expect(tracker.isAutomationPacket(undefined, 0x1234)).toBe(false);
  });

  it('normalises signed ids to unsigned 32-bit', () => {
    tracker.record('src-a', 0xaaaa0001, -1);
    expect(tracker.isAutomationPacket(0xaaaa0001, 0xffffffff)).toBe(true);
  });

  it('clearSource drops only that source', () => {
    tracker.record('src-a', 0xaaaa0001, 1);
    tracker.record('src-b', 0xbbbb0002, 2);
    tracker.clearSource('src-a');
    expect(tracker.isAutomationPacket(0xaaaa0001, 1)).toBe(false);
    expect(tracker.isAutomationPacket(0xbbbb0002, 2)).toBe(true);
  });

  it('randomPacketId returns a non-zero unsigned 32-bit id', () => {
    for (let i = 0; i < 200; i++) {
      const id = randomPacketId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
