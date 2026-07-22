/**
 * Tests for the {DATE} and {TIME} Auto-Announce tokens (issue #3382).
 *
 * These tokens expand to the current date/time at send time, formatted per the
 * global `dateFormat` / `timeFormat` presentation preferences — mirroring how
 * the acknowledgement path already formats received-message timestamps.
 *
 * We drive the real `previewAnnouncementMessage` wrapper (which calls the
 * private `replaceAnnouncementTokens`) on the manager singleton, and compare
 * against the shared formatter so the assertions stay timezone-independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDate, formatTime } from '../utils/datetime.js';

const mockGetSetting = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: vi.fn(),
    settings: {
      getSetting: mockGetSetting,
      getSettingForSource: vi.fn((_s: string, key: string) => mockGetSetting(key)),
    },
    nodes: {
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getNode: vi.fn().mockResolvedValue(null),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// A fixed instant so "now" is deterministic across runs.
const FIXED_NOW = new Date('2025-03-09T14:05:00');

describe('MeshtasticManager - {DATE} / {TIME} announcement tokens', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replaces {DATE} using the configured dateFormat', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      key === 'dateFormat' ? 'DD/MM/YYYY' : key === 'timeFormat' ? '24' : undefined,
    );

    const result = await manager.previewAnnouncementMessage('Today is {DATE}');

    expect(result).toBe(`Today is ${formatDate(FIXED_NOW, 'DD/MM/YYYY')}`);
  });

  it('replaces {TIME} using the configured 12-hour timeFormat', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      key === 'timeFormat' ? '12' : key === 'dateFormat' ? 'MM/DD/YYYY' : undefined,
    );

    const result = await manager.previewAnnouncementMessage('Online at {TIME}');

    expect(result).toBe(`Online at ${formatTime(FIXED_NOW, '12')}`);
  });

  it('replaces both {DATE} and {TIME} in a single message', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      key === 'dateFormat' ? 'MM/DD/YYYY' : key === 'timeFormat' ? '24' : undefined,
    );

    const result = await manager.previewAnnouncementMessage('{DATE} {TIME}');

    expect(result).toBe(`${formatDate(FIXED_NOW, 'MM/DD/YYYY')} ${formatTime(FIXED_NOW, '24')}`);
  });

  it('falls back to default formats when the settings are unset', async () => {
    mockGetSetting.mockResolvedValue(undefined);

    const result = await manager.previewAnnouncementMessage('{DATE} {TIME}');

    expect(result).toBe(`${formatDate(FIXED_NOW, 'MM/DD/YYYY')} ${formatTime(FIXED_NOW, '24')}`);
  });

  it('leaves a message without the tokens untouched', async () => {
    mockGetSetting.mockResolvedValue(undefined);

    const result = await manager.previewAnnouncementMessage('No tokens here');

    expect(result).toBe('No tokens here');
  });
});
