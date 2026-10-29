import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatTime,
  formatDate,
  formatDateTime,
  formatTimeOrDate,
  formatRelativeTime,
  formatMessageTime,
  getMessageDateSeparator,
  shouldShowDateSeparator,
  formatChartAxisTimestamp,
  getCachedDateTimeFormat
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

  describe('formatTimeOrDate (#3656)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // "now" = 2024-03-15 14:32 local
      vi.setSystemTime(new Date('2024-03-15T14:32:00'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the TIME when the date is today', () => {
      const earlierToday = new Date('2024-03-15T09:05:00');
      expect(formatTimeOrDate(earlierToday, '24')).toBe('09:05');
      expect(formatTimeOrDate(earlierToday, '12')).toMatch(/9:05\s*AM/i);
    });

    it('shows the DATE (per dateFormat) when the date is before today', () => {
      const yesterday = new Date('2024-03-14T20:00:00');
      expect(formatTimeOrDate(yesterday, '24', 'MM/DD/YYYY')).toBe('03/14/2024');
      expect(formatTimeOrDate(yesterday, '24', 'DD/MM/YYYY')).toBe('14/03/2024');
      expect(formatTimeOrDate(yesterday, '24', 'YYYY-MM-DD')).toBe('2024-03-14');
    });

    it('treats local midnight today as today (time), and 23:59 yesterday as a date', () => {
      // Midnight today must render as a TIME, not a date. The exact 24h midnight
      // form is ICU-version-dependent ("00:00" on newer Node, "24:00" on Node 20),
      // so assert it's a time rather than pinning the value.
      expect(formatTimeOrDate(new Date('2024-03-15T00:00:00'), '24')).toMatch(/^(00|24):00$/);
      expect(formatTimeOrDate(new Date('2024-03-14T23:59:00'), '24', 'MM/DD/YYYY')).toBe('03/14/2024');
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

describe('formatter cache (perf: one Intl.DateTimeFormat per locale + options)', () => {
  // Midnight, noon, single-digit and late-evening hours, across a DST boundary.
  const dates = [
    new Date(2024, 0, 1, 0, 0),
    new Date(2024, 0, 1, 0, 5),
    new Date(2024, 2, 10, 2, 30),
    new Date(2024, 5, 15, 9, 7),
    new Date(2024, 5, 15, 12, 0),
    new Date(2024, 10, 3, 1, 59),
    new Date(2024, 11, 31, 23, 59),
  ];

  it('formatTime matches toLocaleTimeString for 12 h and 24 h', () => {
    for (const d of dates) {
      expect(formatTime(d, '12')).toBe(
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      );
      expect(formatTime(d, '24')).toBe(
        d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      );
    }
  });

  it('formatTime still returns "Invalid Date" for an invalid date instead of throwing', () => {
    const bad = new Date(NaN);
    expect(formatTime(bad, '12')).toBe(bad.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }));
    expect(formatTime(bad, '24')).toBe('Invalid Date');
  });

  it('getCachedDateTimeFormat matches toLocaleString across locales and options', () => {
    const optionSets: Intl.DateTimeFormatOptions[] = [
      { hour: 'numeric', minute: '2-digit', hour12: true },
      { hour: '2-digit', minute: '2-digit', hour12: false },
      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' },
      { year: 'numeric', month: 'long', day: 'numeric' },
    ];
    const locales: Array<string | string[] | undefined> = [undefined, [], 'en-US', 'en-GB', 'de-DE', 'ja-JP'];
    for (const locale of locales) {
      for (const options of optionSets) {
        const formatter = getCachedDateTimeFormat(locale, options);
        for (const d of dates) {
          expect(formatter.format(d)).toBe(d.toLocaleString(locale, options));
        }
      }
    }
  });

  it('reuses one instance per locale + options and keeps distinct keys apart', () => {
    const a = getCachedDateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const b = getCachedDateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const c = getCachedDateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const d = getCachedDateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
