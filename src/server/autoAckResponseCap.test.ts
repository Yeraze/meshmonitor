import { describe, it, expect } from 'vitest';
import {
  AUTO_ACK_MAX_PENDING,
  AUTO_ACK_MAX_RESPONSES_DEFAULT,
  AUTO_ACK_RESPONSE_WAIT_MAX_MS,
  AUTO_ACK_RESPONSE_WAIT_MIN_MS,
  autoAckChannelWaitMs,
  AUTO_ACK_HOP_PENALTY_MS,
  AUTO_ACK_MIN_SPREAD_MS,
  isValidAutoAckMaxResponses,
  resolveAutoAckMaxResponses,
} from './autoAckResponseCap.js';

describe('resolveAutoAckMaxResponses', () => {
  it('defaults to 2 when unset, blank or malformed', () => {
    expect(AUTO_ACK_MAX_RESPONSES_DEFAULT).toBe(2);
    for (const raw of [null, undefined, '', '  ', 'abc', '2.5', '-1']) {
      expect(resolveAutoAckMaxResponses(raw)).toBe(2);
    }
  });

  it('keeps 0 (no cap) and clamps to 10', () => {
    expect(resolveAutoAckMaxResponses('0')).toBe(0);
    expect(resolveAutoAckMaxResponses('7')).toBe(7);
    expect(resolveAutoAckMaxResponses('10')).toBe(10);
    expect(resolveAutoAckMaxResponses('99')).toBe(10);
  });
});

describe('isValidAutoAckMaxResponses', () => {
  it('accepts whole numbers 0-10 as string or number', () => {
    for (const v of ['0', '2', '10', 0, 10]) expect(isValidAutoAckMaxResponses(v)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const v of ['-1', '11', '2.5', '', 'abc', null, undefined, true, 11, 2.5, {}]) {
      expect(isValidAutoAckMaxResponses(v)).toBe(false);
    }
  });
});

describe('autoAckChannelWaitMs', () => {
  it('the window is 5 s to 30 s', () => {
    expect(AUTO_ACK_RESPONSE_WAIT_MIN_MS).toBe(5_000);
    expect(AUTO_ACK_RESPONSE_WAIT_MAX_MS).toBe(30_000);
  });

  it('is uniform over [5 s, 30 s] with no Pre-Send Delay', () => {
    expect(autoAckChannelWaitMs(0, 0)).toBe(5_000);
    expect(autoAckChannelWaitMs(0, 0.25)).toBe(11_250);
    expect(autoAckChannelWaitMs(0, 0.5)).toBe(17_500); // the average a user sees
    expect(autoAckChannelWaitMs(0, 1)).toBe(30_000);
    let sum = 0;
    for (let i = 0; i < 4000; i++) {
      const ms = autoAckChannelWaitMs(0, Math.random());
      expect(ms).toBeGreaterThanOrEqual(AUTO_ACK_RESPONSE_WAIT_MIN_MS);
      expect(ms).toBeLessThanOrEqual(AUTO_ACK_RESPONSE_WAIT_MAX_MS);
      sum += ms;
    }
    expect(sum / 4000).toBeGreaterThan(16_000);
    expect(sum / 4000).toBeLessThan(19_000);
  });

  it('a Pre-Send Delay under 5 s changes nothing; a longer one becomes the floor', () => {
    expect(autoAckChannelWaitMs(3, 0)).toBe(5_000);
    expect(autoAckChannelWaitMs(3, 1)).toBe(30_000);
    // Exactly 5 s is the boundary: still the plain 5-30 s window.
    expect(autoAckChannelWaitMs(5, 0)).toBe(5_000);
    expect(autoAckChannelWaitMs(5, 1)).toBe(30_000);
    expect(autoAckChannelWaitMs(6, 0)).toBe(6_000);
    expect(autoAckChannelWaitMs(20, 0)).toBe(20_000);
    expect(autoAckChannelWaitMs(20, 1)).toBe(45_000);
  });

  it('raises the floor 3 s per hop and leaves the ceiling at 30 s (#5788)', () => {
    expect(AUTO_ACK_HOP_PENALTY_MS).toBe(3_000);
    const floors = [5_000, 8_000, 11_000, 14_000, 17_000, 20_000, 23_000, 26_000];
    floors.forEach((floor, hops) => {
      expect(autoAckChannelWaitMs(0, 0, hops)).toBe(floor);
      expect(autoAckChannelWaitMs(0, 1, hops)).toBe(30_000);
    });
    // Still a spread, not a fixed time: 2 hops, half way = 11 s + 9.5 s.
    expect(autoAckChannelWaitMs(0, 0.5, 2)).toBe(20_500);
  });

  it('a nearer instance never draws a later wait than a farther one for the same roll', () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
      for (let hops = 0; hops < 7; hops++) {
        expect(autoAckChannelWaitMs(0, r, hops)).toBeLessThanOrEqual(autoAckChannelWaitMs(0, r, hops + 1));
      }
    }
  });

  it('keeps at least 2 s of spread, and treats bad hop values as no bias or the 7-hop cap', () => {
    expect(AUTO_ACK_MIN_SPREAD_MS).toBe(2_000);
    // Past 7 hops counts as 7; the floor can never pass ceiling - 2 s.
    expect(autoAckChannelWaitMs(0, 0, 9)).toBe(26_000);
    expect(autoAckChannelWaitMs(0, 0, 250)).toBe(26_000);
    for (const hops of [-1, NaN, Infinity, undefined as unknown as number]) {
      expect(autoAckChannelWaitMs(0, 0, hops)).toBe(5_000);
      expect(autoAckChannelWaitMs(0, 1, hops)).toBe(30_000);
    }
    expect(autoAckChannelWaitMs(0, 0, 2.9)).toBe(11_000);
    for (let hops = 0; hops <= 7; hops++) {
      expect(autoAckChannelWaitMs(0, 1, hops) - autoAckChannelWaitMs(0, 0, hops)).toBeGreaterThanOrEqual(2_000);
    }
  });

  it('adds the hop bias on top of a long Pre-Send Delay, inside its own 25 s window', () => {
    // preSend 20 s: window 20-45 s. Two hops raise the floor to 26 s.
    expect(autoAckChannelWaitMs(20, 0, 2)).toBe(26_000);
    expect(autoAckChannelWaitMs(20, 1, 2)).toBe(45_000);
    expect(autoAckChannelWaitMs(20, 0, 7)).toBe(41_000);
  });

  it('a bad random or a negative delay cannot produce a wait under 5 s', () => {
    expect(autoAckChannelWaitMs(-5, NaN)).toBe(5_000);
    expect(autoAckChannelWaitMs(0, -1)).toBe(5_000);
    expect(autoAckChannelWaitMs(0, 7)).toBe(30_000);
  });
});

describe('AUTO_ACK_MAX_PENDING', () => {
  it('is 10: one new matching sender every 3 s for the whole 30 s window', () => {
    expect(AUTO_ACK_MAX_PENDING).toBe(10);
    expect(AUTO_ACK_RESPONSE_WAIT_MAX_MS / AUTO_ACK_MAX_PENDING).toBe(3_000);
  });
});
