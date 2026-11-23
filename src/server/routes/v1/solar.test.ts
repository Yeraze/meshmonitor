/**
 * v1 per-node solar irradiance (#6523). The gates live in getNodeIrradiance
 * (covered by solarRoutes.irradiance.test.ts); this covers the v1 shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/solarNodeCell.js', () => ({ getNodeIrradiance: vi.fn() }));

import solarRouter from './solar.js';
import { getNodeIrradiance } from '../../utils/solarNodeCell.js';

const mocked = vi.mocked(getNodeIrradiance);

describe('GET /api/v1/solar', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use('/api/v1/solar', solarRouter);
  });

  it('returns points with units and ISO datetimes', async () => {
    mocked.mockResolvedValue({ status: 200, enabled: true, points: [{ timestamp: 1700000000, shortwaveRadiation: 410, cloudCover: 20 }] });
    const res = await request(app).get('/api/v1/solar?sourceId=s1&nodeId=!abcd1234&start=1&end=2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      enabled: true,
      unit: { shortwaveRadiation: 'W/m²', cloudCover: '%' },
      count: 1,
      data: [{ timestamp: 1700000000, shortwaveRadiation: 410, cloudCover: 20, datetime: '2023-11-14T22:13:20.000Z' }],
    });
    expect(mocked).toHaveBeenCalledWith(undefined, 's1', '!abcd1234', 1, 2);
  });

  it('defaults the window to the last 24 h through the next 48 h', async () => {
    mocked.mockResolvedValue({ status: 200, enabled: false, points: [] });
    const now = Math.floor(Date.now() / 1000);
    await request(app).get('/api/v1/solar?sourceId=s1&nodeId=!abcd1234');
    const [, , , start, end] = mocked.mock.calls[0];
    expect(Math.abs(start - (now - 86_400))).toBeLessThan(5);
    expect(end - start).toBe(3 * 86_400);
  });

  it('requires sourceId', async () => {
    const res = await request(app).get('/api/v1/solar?nodeId=!abcd1234');
    expect(res.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('passes through 403 and 400', async () => {
    mocked.mockResolvedValueOnce({ status: 403, message: 'Insufficient permissions' });
    expect((await request(app).get('/api/v1/solar?sourceId=s1&nodeId=x')).status).toBe(403);
    mocked.mockResolvedValueOnce({ status: 400, message: 'nodeId is required' });
    expect((await request(app).get('/api/v1/solar?sourceId=s1')).status).toBe(400);
  });

  it('500s on an unexpected error', async () => {
    mocked.mockRejectedValue(new Error('boom'));
    expect((await request(app).get('/api/v1/solar?sourceId=s1&nodeId=x')).status).toBe(500);
  });
});
