import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatTime,
  formatDate,
  formatDateTime,
  formatTimestamp,
  formatRelativeTime
} from './datetime';

describe('DateTime Utilities', () => {
  // Use a fixed local date for consistent testing (not UTC)
  const testDate = new Date(2024, 11, 25, 15, 30, 45); // Christmas 2024, 3:30:45 PM local time
  const testTimestamp = testDate.getTime();

  describe('formatTime', () => {
    it('should format time in 24-hour format', () => {
      const result = formatTime(testDate, '24');
      expect(result).toBe('15:30');
    });

    it('should format time in 12-hour format with PM', () => {
      const result = formatTime(testDate, '12');
      expect(result).toMatch(/3:30\s*PM/i);
    });

    it('should format morning time in 12-hour format with AM', () => {
      const morningDate = new Date(2024, 11, 25, 9, 15, 0); // 9:15 AM local time
      const result = formatTime(morningDate, '12');
      expect(result).toMatch(/9:15\s*AM/i);
    });

    it('should default to 24-hour format when no format specified', () => {
      const result = formatTime(testDate);
      expect(result).toBe('15:30');
    });

    it('should handle midnight correctly in both formats', () => {
      const midnight = new Date(2024, 11, 25, 0, 0, 0); // Midnight local time
      const time24 = formatTime(midnight, '24');
      // Some locales format midnight as '00:00', others as '24:00'
      expect(time24).toMatch(/^(00|24):00$/);
      expect(formatTime(midnight, '12')).toMatch(/12:00\s*AM/i);
    });

    it('should handle noon correctly in both formats', () => {
      const noon = new Date(2024, 11, 25, 12, 0, 0); // Noon local time
      expect(formatTime(noon, '24')).toBe('12:00');
      expect(formatTime(noon, '12')).toMatch(/12:00\s*PM/i);
    });
  });

  describe('formatDate', () => {
    it('should format date in MM/DD/YYYY format', () => {
      const result = formatDate(testDate, 'MM/DD/YYYY');
      expect(result).toBe('12/25/2024');
    });

    it('should format date in DD/MM/YYYY format', () => {
      const result = formatDate(testDate, 'DD/MM/YYYY');
      expect(result).toBe('25/12/2024');
    });

    it('should default to MM/DD/YYYY format when no format specified', () => {
      const result = formatDate(testDate);
      expect(result).toBe('12/25/2024');
    });

    it('should pad single-digit months and days with zeros', () => {
      const earlyDate = new Date(2024, 0, 5, 12, 0, 0); // Jan 5, 2024 noon local time
      expect(formatDate(earlyDate, 'MM/DD/YYYY')).toBe('01/05/2024');
      expect(formatDate(earlyDate, 'DD/MM/YYYY')).toBe('05/01/2024');
    });
  });

  describe('formatDateTime', () => {
    it('should combine date and time in MM/DD/YYYY 24-hour format', () => {
      const result = formatDateTime(testDate, '24', 'MM/DD/YYYY');
      expect(result).toBe('12/25/2024 15:30');
    });

    it('should combine date and time in DD/MM/YYYY 12-hour format', () => {
      const result = formatDateTime(testDate, '12', 'DD/MM/YYYY');
      expect(result).toMatch(/25\/12\/2024 3:30\s*PM/i);
    });

    it('should use defaults when no format specified', () => {
      const result = formatDateTime(testDate);
      expect(result).toBe('12/25/2024 15:30');
    });
  });

  describe('formatTimestamp', () => {
    it('should format timestamp in MM/DD/YYYY 24-hour format', () => {
      const result = formatTimestamp(testTimestamp, '24', 'MM/DD/YYYY');
      expect(result).toBe('12/25/2024 15:30');
    });

    it('should format timestamp in DD/MM/YYYY 12-hour format', () => {
      const result = formatTimestamp(testTimestamp, '12', 'DD/MM/YYYY');
      expect(result).toMatch(/25\/12\/2024 3:30\s*PM/i);
    });

    it('should use defaults when no format specified', () => {
      const result = formatTimestamp(testTimestamp);
      expect(result).toBe('12/25/2024 15:30');
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      // Mock Date.now() to return a consistent time
      vi.setSystemTime(new Date('2024-12-25T16:00:00.000Z'));
    });

    it('should show "just now" for very recent timestamps (< 60 seconds)', () => {
      const now = Date.now();
      const recent = now - 30000; // 30 seconds ago
      expect(formatRelativeTime(recent)).toBe('just now');
    });

    it('should show minutes for timestamps < 1 hour', () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      expect(formatRelativeTime(fiveMinutesAgo)).toBe('5 minutes ago');
    });

    it('should use singular "minute" for 1 minute', () => {
      const now = Date.now();
      const oneMinuteAgo = now - 60 * 1000;
      expect(formatRelativeTime(oneMinuteAgo)).toBe('1 minute ago');
    });

    it('should show hours for timestamps < 24 hours', () => {
      const now = Date.now();
      const threeHoursAgo = now - 3 * 60 * 60 * 1000;
      expect(formatRelativeTime(threeHoursAgo)).toBe('3 hours ago');
    });

    it('should use singular "hour" for 1 hour', () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      expect(formatRelativeTime(oneHourAgo)).toBe('1 hour ago');
    });

    it('should show days for timestamps < 7 days', () => {
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(twoDaysAgo)).toBe('2 days ago');
    });

    it('should use singular "day" for 1 day', () => {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(oneDayAgo)).toBe('1 day ago');
    });

    it('should show absolute date for timestamps >= 7 days', () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
      const result = formatRelativeTime(tenDaysAgo, '24', 'MM/DD/YYYY');
      expect(result).toMatch(/12\/15\/2024/); // 10 days before 12/25
    });

    it('should include absolute time when showAbsolute is true', () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      const result = formatRelativeTime(fiveMinutesAgo, '24', 'MM/DD/YYYY', true);
      expect(result).toMatch(/5 minutes ago \(.*\)/);
      expect(result).toContain('12/25/2024');
    });

    it('should respect time format in absolute time', () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const result12 = formatRelativeTime(oneHourAgo, '12', 'MM/DD/YYYY', true);
      const result24 = formatRelativeTime(oneHourAgo, '24', 'MM/DD/YYYY', true);

      expect(result12).toMatch(/PM|AM/i);
      expect(result24).not.toMatch(/PM|AM/i);
    });

    it('should respect date format in absolute time', () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const resultMDY = formatRelativeTime(oneHourAgo, '24', 'MM/DD/YYYY', true);
      const resultDMY = formatRelativeTime(oneHourAgo, '24', 'DD/MM/YYYY', true);

      expect(resultMDY).toContain('12/25/2024');
      expect(resultDMY).toContain('25/12/2024');
    });
  });

  describe('Edge cases', () => {
    it('should handle invalid dates gracefully', () => {
      const invalidDate = new Date('invalid');
      const result = formatTime(invalidDate, '24');
      expect(result).toBeTruthy(); // Should not throw, even if result is 'Invalid Date'
    });

    it('should handle year boundaries correctly', () => {
      const newYear = new Date(2025, 0, 1, 12, 0, 0); // Jan 1, 2025 noon local time
      expect(formatDate(newYear, 'MM/DD/YYYY')).toBe('01/01/2025');
      expect(formatDate(newYear, 'DD/MM/YYYY')).toBe('01/01/2025');
    });

    it('should handle leap year dates correctly', () => {
      const leapDay = new Date(2024, 1, 29, 12, 0, 0); // Feb 29, 2024 local time
      expect(formatDate(leapDay, 'MM/DD/YYYY')).toBe('02/29/2024');
    });
  });
});
