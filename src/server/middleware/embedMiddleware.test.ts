import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEmbedCspMiddleware } from './embedMiddleware.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    getEmbedProfileByIdAsync: vi.fn(),
  }
}));

const mockDb = databaseService as unknown as {
  getEmbedProfileByIdAsync: ReturnType<typeof vi.fn>;
};

const sampleProfile = {
  id: 'profile-uuid-123',
  name: 'Test Embed',
  enabled: true,
  channels: [0],
  tileset: 'osm',
  defaultLat: 38.0,
  defaultLng: -97.0,
  defaultZoom: 10,
  showTooltips: true,
  showPopups: true,
  showLegend: true,
  showPaths: false,
  showNeighborInfo: false,
  showMqttNodes: true,
  pollIntervalSeconds: 30,
  allowedOrigins: ['https://example.com', 'https://other.org'],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const createApp = () => {
  const app = express();
  // Set X-Frame-Options by default (like a real server would)
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/embed/:profileId', createEmbedCspMiddleware(), (req, res) => {
    res.json({ profile: (req as any).embedProfile });
  });
  return app;
};

describe('Embed CSP Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets frame-ancestors with allowedOrigins from profile', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue(sampleProfile);
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    expect(response.status).toBe(200);
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'self' https://example.com https://other.org");
  });

  it('removes X-Frame-Options header', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue(sampleProfile);
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    expect(response.status).toBe(200);
    expect(response.headers['x-frame-options']).toBeUndefined();
  });

  it('returns 404 for disabled profile', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue({ ...sampleProfile, enabled: false });
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'Embed profile not found' });
  });

  it('returns 404 for nonexistent profile', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue(null);
    const app = createApp();

    const response = await request(app).get('/embed/nonexistent-id');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'Embed profile not found' });
  });

  it('attaches profile to request object', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue(sampleProfile);
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    expect(response.status).toBe(200);
    expect(response.body.profile).toEqual(sampleProfile);
  });

  it('sets CSP with default-src, script-src, style-src, img-src, connect-src, worker-src', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue(sampleProfile);
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it('handles profile with empty allowedOrigins', async () => {
    mockDb.getEmbedProfileByIdAsync.mockResolvedValue({ ...sampleProfile, allowedOrigins: [] });
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    expect(response.status).toBe(200);
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'self'");
    // Should NOT contain extra origins
    expect(csp).not.toContain('https://example.com');
  });

  it('returns 500 when database throws', async () => {
    mockDb.getEmbedProfileByIdAsync.mockRejectedValue(new Error('db down'));
    const app = createApp();

    const response = await request(app).get('/embed/profile-uuid-123');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: 'Internal server error' });
  });
});
