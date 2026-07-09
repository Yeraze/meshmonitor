import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetAllPreferenceUserIds = vi.fn();
const mockGetUserPreferenceRows = vi.fn();
vi.mock('../../services/database.js', () => ({
  default: {
    notifications: {
      getAllPreferenceUserIds: (...args: unknown[]) => mockGetAllPreferenceUserIds(...args),
      getUserPreferenceRows: (...args: unknown[]) => mockGetUserPreferenceRows(...args),
    },
  },
}));

import {
  parseMonitoredUnion,
  countMonitoredNodes,
  truncateSourceId,
  formatSourceIdForLog,
  logZeroEligiblePrefRows,
} from './notificationCheckHelpers.js';
import { HourlyLogLimiter } from './hourlyLogLimiter.js';
import { logger } from '../../utils/logger.js';

describe('parseMonitoredUnion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unions and dedups ids across rows', () => {
    const rows = [
      { sourceId: '', monitoredNodes: JSON.stringify(['!a', 'mc:s1:aabbccddeeff']) },
      { sourceId: 's1', monitoredNodes: JSON.stringify(['mc:s1:aabbccddeeff', '!b']) },
    ];
    expect(parseMonitoredUnion(1, rows).sort()).toEqual(['!a', '!b', 'mc:s1:aabbccddeeff'].sort());
  });

  it('skips null/empty rows and returns [] when nothing is monitored', () => {
    expect(parseMonitoredUnion(1, [
      { sourceId: '', monitoredNodes: null },
      { sourceId: 's1', monitoredNodes: JSON.stringify([]) },
    ])).toEqual([]);
  });

  it('logs and skips a malformed row without aborting the union', () => {
    const rows = [
      { sourceId: 's1', monitoredNodes: '{not json' },
      { sourceId: 's2', monitoredNodes: JSON.stringify(['!ok']) },
    ];
    expect(parseMonitoredUnion(7, rows)).toEqual(['!ok']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores JSON that is valid but not an array', () => {
    expect(parseMonitoredUnion(1, [{ sourceId: 's1', monitoredNodes: '{"a":1}' }])).toEqual([]);
  });
});

describe('countMonitoredNodes', () => {
  it('counts array entries', () => {
    expect(countMonitoredNodes(JSON.stringify(['a', 'b', 'c']))).toBe(3);
  });
  it('returns 0 for null, malformed JSON, and non-array JSON', () => {
    expect(countMonitoredNodes(null)).toBe(0);
    expect(countMonitoredNodes('{oops')).toBe(0);
    expect(countMonitoredNodes('"str"')).toBe(0);
  });
});

describe('truncateSourceId / formatSourceIdForLog', () => {
  it('truncates long ids and leaves short ones alone', () => {
    expect(truncateSourceId('b5cfff10-392d-49bb')).toBe('b5cfff10…');
    expect(truncateSourceId('short')).toBe('short');
  });
  it("renders the '' row as two quotes", () => {
    expect(formatSourceIdForLog('')).toBe("''");
    expect(formatSourceIdForLog('b5cfff10-392d-49bb')).toBe('b5cfff10…');
  });
});

describe('logZeroEligiblePrefRows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dumps one line per user with rows, via the provided formatter', async () => {
    mockGetAllPreferenceUserIds.mockResolvedValue([1, 2]);
    mockGetUserPreferenceRows.mockImplementation(async (userId: number) =>
      userId === 1
        ? [{ sourceId: '', prefs: { notifyOnLowBattery: true } }, { sourceId: 's1', prefs: { notifyOnLowBattery: false } }]
        : []
    );
    const limiter = new HourlyLogLimiter();
    await logZeroEligiblePrefRows(limiter, '🔋 [low-battery]', (sourceId, prefs: any) =>
      `[src=${formatSourceIdForLog(sourceId)} flag=${prefs.notifyOnLowBattery ? '✓' : '✗'}]`
    );
    // user 2 has no rows → no line; user 1 gets one line containing both rows
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "🔋 [low-battery] user=1 rows: [src='' flag=✓] [src=s1 flag=✗]"
    );
  });

  it('is rate-limited per user by the caller-supplied limiter', async () => {
    mockGetAllPreferenceUserIds.mockResolvedValue([1]);
    mockGetUserPreferenceRows.mockResolvedValue([{ sourceId: '', prefs: {} }]);
    const limiter = new HourlyLogLimiter();
    await logZeroEligiblePrefRows(limiter, 'x', () => '[row]');
    await logZeroEligiblePrefRows(limiter, 'x', () => '[row]');
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
