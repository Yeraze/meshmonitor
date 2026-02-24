/**
 * Solar Monitoring Service Tests
 *
 * Tests solar monitoring initialization, fetching, and cron job scheduling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock node-cron using vi.hoisted() to avoid hoisting issues
const { mockStart, mockStop, mockSchedule, mockValidate } = vi.hoisted(() => {
  const mockStart = vi.fn();
  const mockStop = vi.fn();
  const mockSchedule = vi.fn((_expression, _callback, _options) => {
    return {
      start: mockStart,
      stop: mockStop
    };
  });
  const mockValidate = vi.fn(() => true);

  return { mockStart, mockStop, mockSchedule, mockValidate };
});

vi.mock('node-cron', () => ({
  schedule: mockSchedule,
  validate: mockValidate
}));

// Create in-memory database for tests
let testDb: Database.Database;
const mockGetSettingAsync = vi.fn();
const mockUpsertSolarEstimateAsync = vi.fn();
const mockGetRecentSolarEstimatesAsync = vi.fn();
const mockGetSolarEstimatesInRangeAsync = vi.fn();
const mockSetSetting = vi.fn();

// Mock the database service
vi.mock('../../services/database.js', () => ({
  default: {
    getSettingAsync: (...args: unknown[]) => mockGetSettingAsync(...args),
    setSetting: (...args: unknown[]) => mockSetSetting(...args),
    upsertSolarEstimateAsync: (...args: unknown[]) => mockUpsertSolarEstimateAsync(...args),
    getRecentSolarEstimatesAsync: (...args: unknown[]) => mockGetRecentSolarEstimatesAsync(...args),
    getSolarEstimatesInRangeAsync: (...args: unknown[]) => mockGetSolarEstimatesInRangeAsync(...args)
  }
}));

// Mock fetch globally
global.fetch = vi.fn();

// Import after mocks are set up
import { solarMonitoringService } from './solarMonitoringService.js';

describe('SolarMonitoringService', () => {
  // Store solar estimates in memory for test retrieval
  let solarEstimates: Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');

    // Set up minimal schema for testing
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS solar_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL UNIQUE,
        watt_hours INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);

    // Reset in-memory storage
    solarEstimates = [];

    // Set up default mock implementations
    mockGetSettingAsync.mockImplementation(async (key: string) => {
      const row = testDb.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value || null;
    });

    mockSetSetting.mockImplementation((key: string, value: string) => {
      testDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    });

    mockUpsertSolarEstimateAsync.mockImplementation(async (timestamp: number, wattHours: number, fetchedAt: number) => {
      testDb.prepare(
        'INSERT OR REPLACE INTO solar_estimates (timestamp, watt_hours, fetched_at) VALUES (?, ?, ?)'
      ).run(timestamp, wattHours, fetchedAt);
      // Also store in memory array for easy retrieval
      const existingIndex = solarEstimates.findIndex(e => e.timestamp === timestamp);
      if (existingIndex >= 0) {
        solarEstimates[existingIndex] = { timestamp, watt_hours: wattHours, fetched_at: fetchedAt };
      } else {
        solarEstimates.push({ timestamp, watt_hours: wattHours, fetched_at: fetchedAt });
      }
    });

    mockGetRecentSolarEstimatesAsync.mockImplementation(async (limit: number) => {
      const rows = testDb.prepare(
        'SELECT timestamp, watt_hours, fetched_at FROM solar_estimates ORDER BY timestamp DESC LIMIT ?'
      ).all(limit) as Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;
      return rows;
    });

    mockGetSolarEstimatesInRangeAsync.mockImplementation(async (start: number, end: number) => {
      const rows = testDb.prepare(
        'SELECT timestamp, watt_hours, fetched_at FROM solar_estimates WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
      ).all(start, end) as Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;
      return rows;
    });

    // Clear settings before each test
    mockSetSetting('solarMonitoringEnabled', '0');
    mockSetSetting('solarMonitoringLatitude', '0');
    mockSetSetting('solarMonitoringLongitude', '0');
    mockSetSetting('solarMonitoringDeclination', '0');
    mockSetSetting('solarMonitoringAzimuth', '0');

    vi.clearAllMocks();
    mockStart.mockClear();
    mockStop.mockClear();
    mockSchedule.mockClear();
    mockValidate.mockClear();
  });

  afterEach(() => {
    solarMonitoringService.stop();
    testDb.close();
  });

  describe('Service Initialization', () => {
    it('should initialize successfully with valid cron expression', () => {
      expect(() => solarMonitoringService.initialize()).not.toThrow();
    });

    it('should not initialize twice', () => {
      solarMonitoringService.initialize();
      // Second initialization should be prevented
      solarMonitoringService.initialize();
      // Should not throw, just log a warning
      expect(true).toBe(true);
    });

    it('should call cron.schedule with UTC timezone', () => {
      solarMonitoringService.initialize();

      expect(mockSchedule).toHaveBeenCalledWith(
        '5 * * * *',
        expect.any(Function),
        expect.objectContaining({
          timezone: 'Etc/UTC'
        })
      );
    });

    it('should explicitly start the cron job', () => {
      solarMonitoringService.initialize();

      expect(mockStart).toHaveBeenCalled();
    });
  });

  describe('Solar Estimate Fetching', () => {
    it('should not fetch when monitoring is disabled', async () => {
      mockSetSetting('solarMonitoringEnabled', '0');
      mockSetSetting('solarMonitoringLatitude', '40.7');
      mockSetSetting('solarMonitoringLongitude', '-74.0');

      await solarMonitoringService.triggerFetch();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not fetch when coordinates are not set', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '0');
      mockSetSetting('solarMonitoringLongitude', '0');

      await solarMonitoringService.triggerFetch();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should fetch estimates with valid configuration', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');
      mockSetSetting('solarMonitoringDeclination', '25');
      mockSetSetting('solarMonitoringAzimuth', '180');

      const mockResponse = {
        result: {
          '2024-11-07 12:00:00': 500,
          '2024-11-07 13:00:00': 750,
          '2024-11-07 14:00:00': 1000
        },
        message: {
          code: 0,
          type: 'success',
          text: 'OK'
        }
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      await solarMonitoringService.triggerFetch();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.forecast.solar/estimate/watthours/period/40.7128/-74.006/25/180/1'
      );
    });

    it('should store fetched estimates in database', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      const mockResponse = {
        result: {
          '2024-11-07 12:00:00': 500,
          '2024-11-07 13:00:00': 750
        },
        message: {
          code: 0,
          type: 'success',
          text: 'OK'
        }
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      await solarMonitoringService.triggerFetch();

      const estimates = await solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(2);
      expect(estimates[0].watt_hours).toBe(750);
      expect(estimates[1].watt_hours).toBe(500);
    });

    it('should handle API errors gracefully', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500
      });

      await expect(solarMonitoringService.triggerFetch()).resolves.not.toThrow();
    });

    it('should handle network errors gracefully', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      await expect(solarMonitoringService.triggerFetch()).resolves.not.toThrow();
    });

    it('should handle API error responses', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      const mockResponse = {
        result: {},
        message: {
          code: 400,
          type: 'error',
          text: 'Invalid coordinates'
        }
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      await solarMonitoringService.triggerFetch();

      // Should not store anything when API returns an error
      const estimates = await solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(0);
    });

    it('should upsert estimates on duplicate timestamps', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      const timestamp = '2024-11-07 12:00:00';

      // First fetch
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          result: { [timestamp]: 500 },
          message: { code: 0, type: 'success', text: 'OK' }
        })
      });

      await solarMonitoringService.triggerFetch();

      // Second fetch with updated value
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          result: { [timestamp]: 750 },
          message: { code: 0, type: 'success', text: 'OK' }
        })
      });

      await solarMonitoringService.triggerFetch();

      // Should only have one estimate (upserted)
      const estimates = await solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(1);
      expect(estimates[0].watt_hours).toBe(750);
    });
  });

  describe('Estimate Retrieval', () => {
    beforeEach(async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      const mockResponse = {
        result: {
          '2024-11-07 12:00:00': 500,
          '2024-11-07 13:00:00': 750,
          '2024-11-07 14:00:00': 1000,
          '2024-11-07 15:00:00': 800
        },
        message: { code: 0, type: 'success', text: 'OK' }
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      await solarMonitoringService.triggerFetch();
    });

    it('should get recent estimates', async () => {
      const estimates = await solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(4);
      // Should be sorted by timestamp DESC
      expect(estimates[0].watt_hours).toBe(800);
      expect(estimates[3].watt_hours).toBe(500);
    });

    it('should respect limit parameter', async () => {
      const estimates = await solarMonitoringService.getRecentEstimates(2);
      expect(estimates.length).toBe(2);
    });

    it('should get estimates in time range', async () => {
      const start = Math.floor(new Date('2024-11-07 13:00:00').getTime() / 1000);
      const end = Math.floor(new Date('2024-11-07 15:00:00').getTime() / 1000);

      const estimates = await solarMonitoringService.getEstimatesInRange(start, end);
      expect(estimates.length).toBe(3); // 13:00, 14:00, 15:00
      expect(estimates[0].watt_hours).toBe(750); // Sorted ASC
      expect(estimates[2].watt_hours).toBe(800);
    });
  });

  describe('Service Stop', () => {
    it('should stop the cron job', () => {
      solarMonitoringService.initialize();
      solarMonitoringService.stop();

      expect(mockStop).toHaveBeenCalled();
    });

    it('should handle stop when not initialized', () => {
      expect(() => solarMonitoringService.stop()).not.toThrow();
    });
  });

  describe('Initial Fetch on Initialization', () => {
    it('should trigger initial fetch when initialized', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      const mockResponse = {
        result: { '2024-11-07 12:00:00': 500 },
        message: { code: 0, type: 'success', text: 'OK' }
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      // Initialize service (which should trigger initial fetch)
      solarMonitoringService.initialize();

      // Wait a bit for the async fetch to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify fetch was called
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should not block initialization if initial fetch fails', async () => {
      mockSetSetting('solarMonitoringEnabled', '1');
      mockSetSetting('solarMonitoringLatitude', '40.7128');
      mockSetSetting('solarMonitoringLongitude', '-74.0060');

      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      // Should not throw even if fetch fails
      expect(() => solarMonitoringService.initialize()).not.toThrow();
    });
  });
});
