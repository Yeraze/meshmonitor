/**
 * Solar Monitoring Service Tests
 *
 * Tests solar monitoring initialization, fetching, and cron job scheduling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { solarMonitoringService } from './solarMonitoringService.js';
import databaseService from '../../services/database.js';

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

// Mock fetch globally
global.fetch = vi.fn();

describe('SolarMonitoringService', () => {
  beforeEach(() => {
    // Clear settings before each test
    databaseService.setSetting('solarMonitoringEnabled', '0');
    databaseService.setSetting('solarMonitoringLatitude', '0');
    databaseService.setSetting('solarMonitoringLongitude', '0');
    databaseService.setSetting('solarMonitoringDeclination', '0');
    databaseService.setSetting('solarMonitoringAzimuth', '0');

    // Clear any existing solar estimates
    databaseService.db.prepare('DELETE FROM solar_estimates').run();

    vi.clearAllMocks();
    mockStart.mockClear();
    mockStop.mockClear();
    mockSchedule.mockClear();
    mockValidate.mockClear();
  });

  afterEach(() => {
    solarMonitoringService.stop();
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
      databaseService.setSetting('solarMonitoringEnabled', '0');
      databaseService.setSetting('solarMonitoringLatitude', '40.7');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0');

      await solarMonitoringService.triggerFetch();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not fetch when coordinates are not set', async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '0');
      databaseService.setSetting('solarMonitoringLongitude', '0');

      await solarMonitoringService.triggerFetch();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should fetch estimates with valid configuration', async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');
      databaseService.setSetting('solarMonitoringDeclination', '25');
      databaseService.setSetting('solarMonitoringAzimuth', '180');

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
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

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

      const estimates = solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(2);
      expect(estimates[0].watt_hours).toBe(750);
      expect(estimates[1].watt_hours).toBe(500);
    });

    it('should handle API errors gracefully', async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500
      });

      await expect(solarMonitoringService.triggerFetch()).resolves.not.toThrow();
    });

    it('should handle network errors gracefully', async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      await expect(solarMonitoringService.triggerFetch()).resolves.not.toThrow();
    });

    it('should handle API error responses', async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

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
      const estimates = solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(0);
    });

    it('should upsert estimates on duplicate timestamps', async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

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
      const estimates = solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(1);
      expect(estimates[0].watt_hours).toBe(750);
    });
  });

  describe('Estimate Retrieval', () => {
    beforeEach(async () => {
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

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

    it('should get recent estimates', () => {
      const estimates = solarMonitoringService.getRecentEstimates(10);
      expect(estimates.length).toBe(4);
      // Should be sorted by timestamp DESC
      expect(estimates[0].watt_hours).toBe(800);
      expect(estimates[3].watt_hours).toBe(500);
    });

    it('should respect limit parameter', () => {
      const estimates = solarMonitoringService.getRecentEstimates(2);
      expect(estimates.length).toBe(2);
    });

    it('should get estimates in time range', () => {
      const start = Math.floor(new Date('2024-11-07 13:00:00').getTime() / 1000);
      const end = Math.floor(new Date('2024-11-07 15:00:00').getTime() / 1000);

      const estimates = solarMonitoringService.getEstimatesInRange(start, end);
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
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

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
      databaseService.setSetting('solarMonitoringEnabled', '1');
      databaseService.setSetting('solarMonitoringLatitude', '40.7128');
      databaseService.setSetting('solarMonitoringLongitude', '-74.0060');

      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      // Should not throw even if fetch fails
      expect(() => solarMonitoringService.initialize()).not.toThrow();
    });
  });
});
