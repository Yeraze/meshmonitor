import { describe, it, expect } from 'vitest';
import {
  AUTO_ACK_MAX_RESPONSES_DEFAULT,
  AUTO_ACK_RESPONSE_WAIT_MAX_MS,
  AUTO_ACK_RESPONSE_WAIT_MIN_MS,
  autoAckChannelWaitMs,
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
  it('is uniform over [5 s, 10 s] with no Pre-Send Delay', () => {
    expect(autoAckChannelWaitMs(0, 0)).toBe(5_000);
    expect(autoAckChannelWaitMs(0, 0.25)).toBe(6_250);
    expect(autoAckChannelWaitMs(0, 1)).toBe(10_000);
    for (let i = 0; i < 1000; i++) {
      const ms = autoAckChannelWaitMs(0, Math.random());
      expect(ms).toBeGreaterThanOrEqual(AUTO_ACK_RESPONSE_WAIT_MIN_MS);
      expect(ms).toBeLessThanOrEqual(AUTO_ACK_RESPONSE_WAIT_MAX_MS);
    }
  });

  it('a Pre-Send Delay under 5 s changes nothing; a longer one becomes the floor', () => {
    expect(autoAckChannelWaitMs(3, 0)).toBe(5_000);
    expect(autoAckChannelWaitMs(3, 1)).toBe(10_000);
    expect(autoAckChannelWaitMs(20, 0)).toBe(20_000);
    expect(autoAckChannelWaitMs(20, 1)).toBe(25_000);
  });

  it('a bad random or a negative delay cannot produce a wait under 5 s', () => {
    expect(autoAckChannelWaitMs(-5, NaN)).toBe(5_000);
    expect(autoAckChannelWaitMs(0, -1)).toBe(5_000);
    expect(autoAckChannelWaitMs(0, 7)).toBe(10_000);
  });
});
