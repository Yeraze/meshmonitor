import { describe, it, expect } from 'vitest';
import {
  resolveAutoAckPreSendDelaySeconds,
  AUTO_ACK_PRESEND_DELAY_DEFAULT_SECONDS,
  AUTO_ACK_PRESEND_DELAY_MAX_SECONDS,
} from './autoAckDelay';

describe('resolveAutoAckPreSendDelaySeconds', () => {
  it('defaults to 0 (off) when unset, preserving immediate-send behavior', () => {
    expect(resolveAutoAckPreSendDelaySeconds(null)).toBe(AUTO_ACK_PRESEND_DELAY_DEFAULT_SECONDS);
    expect(resolveAutoAckPreSendDelaySeconds(undefined)).toBe(0);
    expect(resolveAutoAckPreSendDelaySeconds('')).toBe(0);
  });

  it('honors a valid configured value', () => {
    expect(resolveAutoAckPreSendDelaySeconds('0')).toBe(0);
    expect(resolveAutoAckPreSendDelaySeconds('5')).toBe(5);
    expect(resolveAutoAckPreSendDelaySeconds('120')).toBe(120);
  });

  it('clamps above the 120s maximum', () => {
    expect(resolveAutoAckPreSendDelaySeconds('300')).toBe(AUTO_ACK_PRESEND_DELAY_MAX_SECONDS);
  });

  it('falls back to 0 on invalid / negative input', () => {
    expect(resolveAutoAckPreSendDelaySeconds('-5')).toBe(0);
    expect(resolveAutoAckPreSendDelaySeconds('abc')).toBe(0);
  });
});
