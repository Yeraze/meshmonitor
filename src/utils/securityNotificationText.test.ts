import { describe, it, expect } from 'vitest';
import { securityNotificationText, NOTIFICATION_MAX_BYTES } from './securityNotificationText';
import { isClockNotSet, formatCompactSpan, CLOCK_NOT_SET_OFFSET_SECONDS } from './securityClock';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('securityNotificationText', () => {
  it('keeps the two Meshtastic key texts exactly', () => {
    expect(securityNotificationText('lowEntropy')).toBe(
      'MeshMonitor Security Notification: Your node has a low entropy key. Read more: https://bit.ly/4oL5m0P',
    );
    expect(securityNotificationText('duplicateKey', { duplicateCount: 3 })).toBe(
      'MeshMonitor Security Notification: Your node has a key shared with 3 other nearby nodes. Read more: https://bit.ly/4okVACV',
    );
  });

  it('the example text is 69 bytes', () => {
    const t = securityNotificationText('timeOffset', { offsetSeconds: 2 * 3600 + 14 * 60 });
    expect(t).toBe("MeshMonitor: your node's clock is 2h 14m behind. Please set its time.");
    expect(bytes(t)).toBe(69);
  });

  it('every new text stays within the byte cap across the whole range', () => {
    const offsets = [
      0, 1, 59, 60, 3599, 3600, 86399, 86400, 86400 * 3 + 3600 * 23, 86400 * 364 + 86399,
      CLOCK_NOT_SET_OFFSET_SECONDS - 1, CLOCK_NOT_SET_OFFSET_SECONDS, 86400 * 365 * 40, -1, -3600, -86400 * 364 - 86399, -86400 * 365 * 40,
    ];
    for (const o of offsets) {
      expect(bytes(securityNotificationText('timeOffset', { offsetSeconds: o })), `offset ${o}`).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
    }
    for (const p of [1, 31, 999, 100000, 99999999, 12345678901234, null, undefined, 0]) {
      expect(bytes(securityNotificationText('excessivePackets', { packetsPerHour: p })), `rate ${p}`).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
    }
    expect(bytes(securityNotificationText('timeOffset', {}))).toBeLessThanOrEqual(NOTIFICATION_MAX_BYTES);
  });

  it('labels a never-set clock and an ahead clock', () => {
    expect(securityNotificationText('timeOffset', { offsetSeconds: 800 * 86400 })).toContain('clock is not set');
    expect(securityNotificationText('timeOffset', { offsetSeconds: -7200 })).toContain('2h ahead');
  });

  it('is plain ASCII (the draft goes over the air)', () => {
    for (const k of ['excessivePackets', 'timeOffset'] as const) {
      expect(/^[\x20-\x7e]*$/.test(securityNotificationText(k, { packetsPerHour: 44, offsetSeconds: 7200 }))).toBe(true);
    }
  });
});

describe('securityClock', () => {
  it('clock-not-set threshold is a year, either direction', () => {
    expect(isClockNotSet(CLOCK_NOT_SET_OFFSET_SECONDS - 1)).toBe(false);
    expect(isClockNotSet(CLOCK_NOT_SET_OFFSET_SECONDS)).toBe(true);
    expect(isClockNotSet(-CLOCK_NOT_SET_OFFSET_SECONDS)).toBe(true);
    expect(isClockNotSet(null)).toBe(false);
  });
  it('formats compact spans', () => {
    expect(formatCompactSpan(30)).toBe('30s');
    expect(formatCompactSpan(45 * 60)).toBe('45m');
    expect(formatCompactSpan(2 * 3600)).toBe('2h');
    expect(formatCompactSpan(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(formatCompactSpan(-90)).toBe('1m');
  });
});
