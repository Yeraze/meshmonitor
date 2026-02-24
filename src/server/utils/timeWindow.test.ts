import { describe, it, expect, vi, afterEach } from 'vitest';
import { isWithinTimeWindow } from './timeWindow.js';

function mockTime(hours: number, minutes: number) {
  const date = new Date(2025, 0, 15, hours, minutes, 0, 0);
  vi.useFakeTimers();
  vi.setSystemTime(date);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isWithinTimeWindow', () => {
  describe('same-day window (e.g. 08:00-17:00)', () => {
    it('returns true when current time is within the window', () => {
      mockTime(12, 0);
      expect(isWithinTimeWindow('08:00', '17:00')).toBe(true);
    });

    it('returns true at exact start time', () => {
      mockTime(8, 0);
      expect(isWithinTimeWindow('08:00', '17:00')).toBe(true);
    });

    it('returns false at exact end time', () => {
      mockTime(17, 0);
      expect(isWithinTimeWindow('08:00', '17:00')).toBe(false);
    });

    it('returns false before window start', () => {
      mockTime(7, 59);
      expect(isWithinTimeWindow('08:00', '17:00')).toBe(false);
    });

    it('returns false after window end', () => {
      mockTime(23, 0);
      expect(isWithinTimeWindow('08:00', '17:00')).toBe(false);
    });
  });

  describe('overnight window (e.g. 22:00-06:00)', () => {
    it('returns true when current time is after start (late evening)', () => {
      mockTime(23, 30);
      expect(isWithinTimeWindow('22:00', '06:00')).toBe(true);
    });

    it('returns true when current time is before end (early morning)', () => {
      mockTime(4, 0);
      expect(isWithinTimeWindow('22:00', '06:00')).toBe(true);
    });

    it('returns true at exact start time', () => {
      mockTime(22, 0);
      expect(isWithinTimeWindow('22:00', '06:00')).toBe(true);
    });

    it('returns false at exact end time', () => {
      mockTime(6, 0);
      expect(isWithinTimeWindow('22:00', '06:00')).toBe(false);
    });

    it('returns false during daytime (outside window)', () => {
      mockTime(12, 0);
      expect(isWithinTimeWindow('22:00', '06:00')).toBe(false);
    });

    it('returns false just before start', () => {
      mockTime(21, 59);
      expect(isWithinTimeWindow('22:00', '06:00')).toBe(false);
    });
  });

  describe('equal start and end (24h window)', () => {
    it('returns true at any time', () => {
      mockTime(0, 0);
      expect(isWithinTimeWindow('08:00', '08:00')).toBe(true);

      mockTime(12, 0);
      expect(isWithinTimeWindow('08:00', '08:00')).toBe(true);

      mockTime(23, 59);
      expect(isWithinTimeWindow('08:00', '08:00')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles midnight boundaries (00:00-06:00)', () => {
      mockTime(0, 0);
      expect(isWithinTimeWindow('00:00', '06:00')).toBe(true);

      mockTime(3, 0);
      expect(isWithinTimeWindow('00:00', '06:00')).toBe(true);

      mockTime(6, 0);
      expect(isWithinTimeWindow('00:00', '06:00')).toBe(false);
    });

    it('handles window ending at midnight (18:00-00:00)', () => {
      mockTime(20, 0);
      expect(isWithinTimeWindow('18:00', '00:00')).toBe(true);

      mockTime(23, 59);
      expect(isWithinTimeWindow('18:00', '00:00')).toBe(true);

      mockTime(0, 0);
      expect(isWithinTimeWindow('18:00', '00:00')).toBe(false);

      mockTime(12, 0);
      expect(isWithinTimeWindow('18:00', '00:00')).toBe(false);
    });

    it('handles 1-minute window', () => {
      mockTime(12, 0);
      expect(isWithinTimeWindow('12:00', '12:01')).toBe(true);

      mockTime(12, 1);
      expect(isWithinTimeWindow('12:00', '12:01')).toBe(false);
    });
  });
});
