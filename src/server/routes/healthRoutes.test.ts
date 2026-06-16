import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthRoutes from './healthRoutes.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  },
}));

const createApp = () => {
  const app = express();
  app.use('/health', healthRoutes);
  return app;
};

describe('Health Routes', () => {
  it('GET /health returns status ok with version and uptime', async () => {
    const app = createApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.version).toBe('string');
    expect(typeof response.body.uptime).toBe('number');
    expect(response.body.databaseType).toBe('sqlite');
    expect(typeof response.body.firmwareOtaEnabled).toBe('boolean');
  });

  it('GET /health does not require authentication', async () => {
    const app = createApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
  });
});
