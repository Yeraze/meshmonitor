/**
 * #6523: chart times drawn in a node's zone. Every case passes the zone in, so
 * the result must not depend on the process zone; CI also runs this file with
 * TZ=Asia/Tokyo, a zone that differs from both UTC and the node zones used.
 */
import { describe, it, expect } from 'vitest';
import { formatTime, formatChartAxisTimestamp, formatInTimeZone, getZonedDateTimeFormat } from './datetime';

// 2026-01-15T05:30:00Z: 23:30 on Jan 14 in Chicago (UTC-6), 14:30 on Jan 15 in Tokyo.
const NEAR_MIDNIGHT = Date.UTC(2026, 0, 15, 5, 30);
const DAY = 24 * 60 * 60 * 1000;
const MULTI_DAY: [number, number] = [NEAR_MIDNIGHT - 3 * DAY, NEAR_MIDNIGHT];

describe('formatTime with a zone', () => {
  it('renders the wall clock of that zone', () => {
    expect(formatTime(new Date(NEAR_MIDNIGHT), '24', 'America/Chicago')).toBe('23:30');
    expect(formatTime(new Date(NEAR_MIDNIGHT), '12', 'America/Chicago')).toBe('11:30 PM');
    expect(formatTime(new Date(NEAR_MIDNIGHT), '24', 'Asia/Tokyo')).toBe('14:30');
    expect(formatTime(new Date(NEAR_MIDNIGHT), '24', 'UTC')).toBe('05:30');
  });

  it('is unchanged without a zone, and falls back to it for a zone the runtime lacks', () => {
    const plain = formatTime(new Date(NEAR_MIDNIGHT), '24');
    expect(formatTime(new Date(NEAR_MIDNIGHT), '24', undefined)).toBe(plain);
    expect(formatTime(new Date(NEAR_MIDNIGHT), '24', 'Mars/Olympus_Mons')).toBe(plain);
    expect(formatTime(new Date(NaN), '24', 'America/Chicago')).toBe('Invalid Date');
  });
});

describe('formatChartAxisTimestamp with a zone', () => {
  it('takes the date from the zone, not the browser, near midnight', () => {
    expect(formatChartAxisTimestamp(NEAR_MIDNIGHT, MULTI_DAY, '24', 'America/Chicago')).toBe('Jan 14 23:30');
    expect(formatChartAxisTimestamp(NEAR_MIDNIGHT, MULTI_DAY, '24', 'Asia/Tokyo')).toBe('Jan 15 14:30');
  });

  it('shows time only for a short range or no range', () => {
    expect(formatChartAxisTimestamp(NEAR_MIDNIGHT, [NEAR_MIDNIGHT - 3600_000, NEAR_MIDNIGHT], '24', 'America/Chicago')).toBe('23:30');
    expect(formatChartAxisTimestamp(NEAR_MIDNIGHT, null, '24', 'America/Chicago')).toBe('23:30');
  });

  it('matches the browser-zone output when no zone is given', () => {
    const d = new Date(NEAR_MIDNIGHT);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    expect(formatChartAxisTimestamp(NEAR_MIDNIGHT, MULTI_DAY, '24')).toBe(
      `${months[d.getMonth()]} ${d.getDate()} ${formatTime(d, '24')}`,
    );
  });
});

describe('formatInTimeZone', () => {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

  it('is toLocaleString without a zone', () => {
    const d = new Date(NEAR_MIDNIGHT);
    expect(formatInTimeZone(d, opts)).toBe(d.toLocaleString([], opts));
  });

  it('renders in the zone when given', () => {
    const d = new Date(NEAR_MIDNIGHT);
    expect(formatInTimeZone(d, opts, 'America/Chicago')).toBe(
      new Intl.DateTimeFormat([], { ...opts, timeZone: 'America/Chicago' }).format(d),
    );
    expect(formatInTimeZone(d, opts, 'America/Chicago')).toContain('14');
  });
});

describe('getZonedDateTimeFormat', () => {
  it('caches one formatter per zone', () => {
    const a = getZonedDateTimeFormat('en-US', { hour: '2-digit' }, 'Europe/Paris');
    const b = getZonedDateTimeFormat('en-US', { hour: '2-digit' }, 'Europe/Paris');
    const c = getZonedDateTimeFormat('en-US', { hour: '2-digit' }, 'Europe/Berlin');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.resolvedOptions().timeZone).toBe('Europe/Paris');
  });
});
