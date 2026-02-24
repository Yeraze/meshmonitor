/**
 * Solar API Endpoint Unit Tests
 *
 * Tests the solar production estimates v1 API endpoints
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the solarMonitoringService before importing the router
vi.mock('../../services/solarMonitoringService.js', () => ({
  solarMonitoringService: {
    getRecentEstimates: vi.fn(),
    getEstimatesInRange: vi.fn()
  }
}));

// Import after mocking
import solarRouter from './solar.js';
import { solarMonitoringService } from '../../services/solarMonitoringService.js';

describe('Solar API Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/v1/solar', solarRouter);
  });

  describe('GET /api/v1/solar', () => {
    it('should return solar estimates with correct format', async () => {
      const mockEstimates = [
        { timestamp: 1699560000, watt_hours: 450.5, fetched_at: 1699557600 },
        { timestamp: 1699563600, watt_hours: 520.3, fetched_at: 1699557600 },
        { timestamp: 1699567200, watt_hours: 380.2, fetched_at: 1699557600 }
      ];

      vi.mocked(solarMonitoringService.getRecentEstimates).mockReturnValue(mockEstimates);

      const response = await request(app)
        .get('/api/v1/solar')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBe(3);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.data[0]).toHaveProperty('timestamp');
      expect(response.body.data[0]).toHaveProperty('datetime');
      expect(response.body.data[0]).toHaveProperty('wattHours');
      expect(response.body.data[0]).toHaveProperty('fetchedAt');
    });

    it('should use default limit of 100', async () => {
      vi.mocked(solarMonitoringService.getRecentEstimates).mockReturnValue([]);

      await request(app)
        .get('/api/v1/solar')
        .expect(200);

      expect(solarMonitoringService.getRecentEstimates).toHaveBeenCalledWith(100);
    });

    it('should respect custom limit parameter', async () => {
      vi.mocked(solarMonitoringService.getRecentEstimates).mockReturnValue([]);

      await request(app)
        .get('/api/v1/solar?limit=50')
        .expect(200);

      expect(solarMonitoringService.getRecentEstimates).toHaveBeenCalledWith(50);
    });

    it('should cap limit at 1000', async () => {
      vi.mocked(solarMonitoringService.getRecentEstimates).mockReturnValue([]);

      await request(app)
        .get('/api/v1/solar?limit=5000')
        .expect(200);

      expect(solarMonitoringService.getRecentEstimates).toHaveBeenCalledWith(1000);
    });

    it('should return empty array when no data', async () => {
      vi.mocked(solarMonitoringService.getRecentEstimates).mockReturnValue([]);

      const response = await request(app)
        .get('/api/v1/solar')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBe(0);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('GET /api/v1/solar/range', () => {
    it('should return solar estimates within time range', async () => {
      const mockEstimates = [
        { timestamp: 1699560000, watt_hours: 450.5, fetched_at: 1699557600 },
        { timestamp: 1699563600, watt_hours: 520.3, fetched_at: 1699557600 }
      ];

      vi.mocked(solarMonitoringService.getEstimatesInRange).mockReturnValue(mockEstimates);

      const response = await request(app)
        .get('/api/v1/solar/range?start=1699520400&end=1699606800')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBe(2);
      expect(response.body.start).toBe(1699520400);
      expect(response.body.end).toBe(1699606800);
      expect(response.body.data).toHaveLength(2);
    });

    it('should return 400 for missing start parameter', async () => {
      const response = await request(app)
        .get('/api/v1/solar/range?end=1699606800')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Bad Request');
      expect(response.body.message).toContain('Invalid');
    });

    it('should return 400 for missing end parameter', async () => {
      const response = await request(app)
        .get('/api/v1/solar/range?start=1699520400')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Bad Request');
      expect(response.body.message).toContain('Invalid');
    });

    it('should return 400 when start is after end', async () => {
      const response = await request(app)
        .get('/api/v1/solar/range?start=1699606800&end=1699520400')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Bad Request');
      expect(response.body.message).toContain('before');
    });

    it('should return empty array for range with no data', async () => {
      vi.mocked(solarMonitoringService.getEstimatesInRange).mockReturnValue([]);

      const response = await request(app)
        .get('/api/v1/solar/range?start=1699520400&end=1699606800')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBe(0);
      expect(response.body.data).toEqual([]);
    });
  });
});
