import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatTime,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatMessageTime,
  getMessageDateSeparator,
  shouldShowDateSeparator,
  formatChartAxisTimestamp
} from './datetime';

describe('datetime utilities', () => {
  describe('formatTime', () => {
    it('should format time in 24-hour format by default', () => {
      const date = new Date('2024-03-15T14:30:00');
      expect(formatTime(date)).toBe('14:30');
      expect(formatTime(date, '24')).toBe('14:30');
    });

    it('should format time in 12-hour format', () => {
      const afternoon = new Date('2024-03-15T14:30:00');
      expect(formatTime(afternoon, '12')).toMatch(/2:30\s*PM/i);

      const morning = new Date('2024-03-15T09:15:00');
      expect(formatTime(morning, '12')).toMatch(/9:15\s*AM/i);
    });

    it('should handle midnight and noon', () => {
      const midnight = new Date('2024-03-15T00:00:00');
      // toLocaleTimeString may return "00:00" or "24:00" depending on locale
      expect(formatTime(midnight, '24')).toMatch(/^(00|24):00$/);
      expect(formatTime(midnight, '12')).toMatch(/12:00\s*AM/i);

      const noon = new Date('2024-03-15T12:00:00');
      expect(formatTime(noon, '24')).toBe('12:00');
      expect(formatTime(noon, '12')).toMatch(/12:00\s*PM/i);
    });
  });

  describe('formatDate', () => {
    it('should format date in MM/DD/YYYY format by default', () => {
      const date = new Date('2024-03-15T12:00:00');
      expect(formatDate(date)).toBe('03/15/2024');
      expect(formatDate(date, 'MM/DD/YYYY')).toBe('03/15/2024');
    });

    it('should format date in DD/MM/YYYY format', () => {
      const date = new Date('2024-03-15T12:00:00');
      expect(formatDate(date, 'DD/MM/YYYY')).toBe('15/03/2024');
    });

    it('should format date in ISO format (YYYY-MM-DD)', () => {
      const date = new Date('2024-03-15T12:00:00');
      expect(formatDate(date, 'YYYY-MM-DD')).toBe('2024-03-15');
    });

    it('should pad single digit months and days', () => {
      const date = new Date('2024-01-05T12:00:00');
      expect(formatDate(date, 'MM/DD/YYYY')).toBe('01/05/2024');
      expect(formatDate(date, 'DD/MM/YYYY')).toBe('05/01/2024');
      expect(formatDate(date, 'YYYY-MM-DD')).toBe('2024-01-05');
    });
  });

  describe('formatDateTime', () => {
    it('should combine date and time formatting', () => {
      const date = new Date('2024-03-15T14:30:00');
      expect(formatDateTime(date)).toBe('03/15/2024 14:30');
      expect(formatDateTime(date, '12', 'DD/MM/YYYY')).toMatch(/15\/03\/2024 2:30\s*PM/i);
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-03-15T12:00:00'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "just now" for less than 60 seconds', () => {
      const now = Date.now();
      expect(formatRelativeTime(now)).toBe('just now');
      expect(formatRelativeTime(now - 30000)).toBe('just now'); // 30 seconds ago
      expect(formatRelativeTime(now - 59000)).toBe('just now'); // 59 seconds ago
    });

    it('should return minutes ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 60000)).toBe('1 minute ago');
      expect(formatRelativeTime(now - 120000)).toBe('2 minutes ago');
      expect(formatRelativeTime(now - 3540000)).toBe('59 minutes ago');
    });

    it('should return hours ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 3600000)).toBe('1 hour ago');
      expect(formatRelativeTime(now - 7200000)).toBe('2 hours ago');
      expect(formatRelativeTime(now - 82800000)).toBe('23 hours ago');
    });

    it('should return days ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 86400000)).toBe('1 day ago');
      expect(formatRelativeTime(now - 172800000)).toBe('2 days ago');
      expect(formatRelativeTime(now - 518400000)).toBe('6 days ago');
    });

    it('should return absolute date for older than 7 days', () => {
      const now = Date.now();
      const oldTimestamp = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      const result = formatRelativeTime(oldTimestamp);
      expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/); // MM/DD/YYYY format
    });

    it('should include absolute time when showAbsolute is true', () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 300000;
      const result = formatRelativeTime(fiveMinutesAgo, '24', 'MM/DD/YYYY', true);
      expect(result).toContain('5 minutes ago');
      expect(result).toContain('(');
    });
  });

  describe('formatMessageTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-03-15T12:00:00'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return just time for today', () => {
      const today = new Date('2024-03-15T09:30:00');
      expect(formatMessageTime(today, '24')).toBe('09:30');
    });

    it('should return "Yesterday" prefix for yesterday', () => {
      const yesterday = new Date('2024-03-14T15:45:00');
      expect(formatMessageTime(yesterday, '24')).toBe('Yesterday 15:45');
    });

    it('should return day name for this week', () => {
      const threeDaysAgo = new Date('2024-03-12T10:00:00'); // Tuesday
      const result = formatMessageTime(threeDaysAgo, '24');
      expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
    });

    it('should return month and day for this year', () => {
      const twoWeeksAgo = new Date('2024-02-15T14:00:00');
      const result = formatMessageTime(twoWeeksAgo, '24');
      expect(result).toBe('Feb 15 14:00');
    });

    it('should return full date for older years', () => {
      const lastYear = new Date('2023-06-20T08:30:00');
      const result = formatMessageTime(lastYear, '24', 'MM/DD/YYYY');
      expect(result).toBe('06/20/2023 08:30');
    });
  });

  describe('getMessageDateSeparator', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-03-15T12:00:00'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "Today" for today', () => {
      const today = new Date('2024-03-15T09:00:00');
      expect(getMessageDateSeparator(today)).toBe('Today');
    });

    it('should return "Yesterday" for yesterday', () => {
      const yesterday = new Date('2024-03-14T15:00:00');
      expect(getMessageDateSeparator(yesterday)).toBe('Yesterday');
    });

    it('should return month and day for this year', () => {
      const earlier = new Date('2024-02-10T12:00:00');
      expect(getMessageDateSeparator(earlier)).toBe('February 10');
    });

    it('should return full date with year for older years', () => {
      const lastYear = new Date('2023-08-25T12:00:00');
      expect(getMessageDateSeparator(lastYear)).toBe('August 25, 2023');
    });
  });

  describe('shouldShowDateSeparator', () => {
    it('should return true when prevDate is null', () => {
      const current = new Date('2024-03-15T12:00:00');
      expect(shouldShowDateSeparator(null, current)).toBe(true);
    });

    it('should return false for same day', () => {
      const prev = new Date('2024-03-15T09:00:00');
      const current = new Date('2024-03-15T12:00:00');
      expect(shouldShowDateSeparator(prev, current)).toBe(false);
    });

    it('should return true for different days', () => {
      const prev = new Date('2024-03-14T12:00:00');
      const current = new Date('2024-03-15T12:00:00');
      expect(shouldShowDateSeparator(prev, current)).toBe(true);
    });

    it('should return true for different months', () => {
      const prev = new Date('2024-02-28T12:00:00');
      const current = new Date('2024-03-01T12:00:00');
      expect(shouldShowDateSeparator(prev, current)).toBe(true);
    });

    it('should return true for different years', () => {
      const prev = new Date('2023-12-31T12:00:00');
      const current = new Date('2024-01-01T12:00:00');
      expect(shouldShowDateSeparator(prev, current)).toBe(true);
    });
  });

  describe('formatChartAxisTimestamp', () => {
    it('should return time only when no range provided', () => {
      const timestamp = new Date('2024-03-15T14:30:00').getTime();
      expect(formatChartAxisTimestamp(timestamp, null, '24')).toBe('14:30');
    });

    it('should return time only for single day range', () => {
      const timestamp = new Date('2024-03-15T14:30:00').getTime();
      const start = new Date('2024-03-15T00:00:00').getTime();
      const end = new Date('2024-03-15T23:59:59').getTime();
      expect(formatChartAxisTimestamp(timestamp, [start, end], '24')).toBe('14:30');
    });

    it('should include date for multi-day range', () => {
      const timestamp = new Date('2024-03-15T14:30:00').getTime();
      const start = new Date('2024-03-10T00:00:00').getTime();
      const end = new Date('2024-03-20T23:59:59').getTime();
      const result = formatChartAxisTimestamp(timestamp, [start, end], '24');
      expect(result).toBe('Mar 15 14:30');
    });

    it('should respect time format preference', () => {
      const timestamp = new Date('2024-03-15T14:30:00').getTime();
      const start = new Date('2024-03-10T00:00:00').getTime();
      const end = new Date('2024-03-20T23:59:59').getTime();
      const result = formatChartAxisTimestamp(timestamp, [start, end], '12');
      expect(result).toMatch(/Mar 15 2:30\s*PM/i);
    });
  });
});
