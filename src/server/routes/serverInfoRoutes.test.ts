import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn().mockReturnValue({
    timezone: 'America/New_York',
    timezoneProvided: true,
  }),
}));

import serverInfoRoutes from './serverInfoRoutes.js';

const app = express();
app.use('/', serverInfoRoutes);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /server-info', () => {
  it('returns timezone configuration', async () => {
    const res = await request(app).get('/server-info');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      timezone: 'America/New_York',
      timezoneProvided: true,
    });
  });
});
