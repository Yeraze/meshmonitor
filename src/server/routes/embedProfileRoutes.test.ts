import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import embedProfileRoutes from './embedProfileRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getEmbedProfilesAsync: vi.fn(),
    getEmbedProfileByIdAsync: vi.fn(),
    createEmbedProfileAsync: vi.fn(),
    updateEmbedProfileAsync: vi.fn(),
    deleteEmbedProfileAsync: vi.fn(),
    auditLog: vi.fn(),
  }
}));

const mockDb = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
  getEmbedProfilesAsync: ReturnType<typeof vi.fn>;
  getEmbedProfileByIdAsync: ReturnType<typeof vi.fn>;
  createEmbedProfileAsync: ReturnType<typeof vi.fn>;
  updateEmbedProfileAsync: ReturnType<typeof vi.fn>;
  deleteEmbedProfileAsync: ReturnType<typeof vi.fn>;
  auditLog: ReturnType<typeof vi.fn>;
};

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (opts: { authenticated?: boolean; admin?: boolean } = {}): Express => {
  const { authenticated = true, admin = true } = opts;
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
  );

  if (authenticated) {
    app.use((req, _res, next) => {
      req.session.userId = adminUser.id;
      req.session.username = adminUser.username;
      next();
    });
  }

  mockDb.findUserByIdAsync.mockResolvedValue(admin ? adminUser : regularUser);

  app.use('/api/embed-profiles', embedProfileRoutes);
  return app;
};

const sampleProfile = {
  id: 'test-uuid-1234',
  name: 'Test Profile',
  enabled: true,
  channels: [0, 1],
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
  allowedOrigins: ['https://example.com'],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('Embed Profile Admin Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      resources: {},
      isAdmin: false
    });
  });

  describe('GET /api/embed-profiles', () => {
    it('returns profiles for admin user', async () => {
      mockDb.getEmbedProfilesAsync.mockResolvedValue([sampleProfile]);
      const app = createApp();

      const response = await request(app).get('/api/embed-profiles');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([sampleProfile]);
      expect(mockDb.getEmbedProfilesAsync).toHaveBeenCalled();
    });

    it('returns 401 for unauthenticated request', async () => {
      const app = createApp({ authenticated: false });

      const response = await request(app).get('/api/embed-profiles');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('returns 403 for non-admin user', async () => {
      const app = createApp({ admin: false });

      const response = await request(app).get('/api/embed-profiles');

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('code', 'FORBIDDEN_ADMIN');
    });

    it('returns 500 when database fails', async () => {
      mockDb.getEmbedProfilesAsync.mockRejectedValue(new Error('db down'));
      const app = createApp();

      const response = await request(app).get('/api/embed-profiles');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ error: 'Failed to fetch embed profiles' });
    });
  });

  describe('POST /api/embed-profiles', () => {
    it('creates a profile and returns 201', async () => {
      mockDb.createEmbedProfileAsync.mockResolvedValue(sampleProfile);
      const app = createApp();

      const response = await request(app)
        .post('/api/embed-profiles')
        .send({ name: 'Test Profile', channels: [0, 1] });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(sampleProfile);
      expect(mockDb.createEmbedProfileAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Profile',
          channels: [0, 1],
          enabled: true,
          tileset: 'osm',
          defaultLat: 0,
          defaultLng: 0,
          defaultZoom: 10,
          showTooltips: true,
          showPopups: true,
          showLegend: true,
          showPaths: false,
          showNeighborInfo: false,
          showMqttNodes: true,
          pollIntervalSeconds: 30,
          allowedOrigins: [],
        })
      );
      expect(mockDb.auditLog).toHaveBeenCalled();
    });

    it('rejects missing name with 400', async () => {
      const app = createApp();

      const response = await request(app)
        .post('/api/embed-profiles')
        .send({ channels: [0] });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'Name is required' });
    });

    it('rejects empty name with 400', async () => {
      const app = createApp();

      const response = await request(app)
        .post('/api/embed-profiles')
        .send({ name: '  ' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'Name is required' });
    });

    it('applies default values for missing fields', async () => {
      mockDb.createEmbedProfileAsync.mockResolvedValue(sampleProfile);
      const app = createApp();

      await request(app)
        .post('/api/embed-profiles')
        .send({ name: 'Minimal Profile' });

      expect(mockDb.createEmbedProfileAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Minimal Profile',
          enabled: true,
          channels: [],
          tileset: 'osm',
          defaultLat: 0,
          defaultLng: 0,
          defaultZoom: 10,
          showTooltips: true,
          showPopups: true,
          showLegend: true,
          showPaths: false,
          showNeighborInfo: false,
          showMqttNodes: true,
          pollIntervalSeconds: 30,
          allowedOrigins: [],
        })
      );
    });

    it('returns 500 when database fails', async () => {
      mockDb.createEmbedProfileAsync.mockRejectedValue(new Error('db failure'));
      const app = createApp();

      const response = await request(app)
        .post('/api/embed-profiles')
        .send({ name: 'Fail Profile' });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ error: 'Failed to create embed profile' });
    });
  });

  describe('PUT /api/embed-profiles/:id', () => {
    it('updates a profile and returns 200', async () => {
      const updated = { ...sampleProfile, name: 'Updated Name' };
      mockDb.updateEmbedProfileAsync.mockResolvedValue(updated);
      const app = createApp();

      const response = await request(app)
        .put('/api/embed-profiles/test-uuid-1234')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(updated);
      expect(mockDb.updateEmbedProfileAsync).toHaveBeenCalledWith(
        'test-uuid-1234',
        { name: 'Updated Name' }
      );
      expect(mockDb.auditLog).toHaveBeenCalled();
    });

    it('returns 404 for nonexistent profile', async () => {
      mockDb.updateEmbedProfileAsync.mockResolvedValue(null);
      const app = createApp();

      const response = await request(app)
        .put('/api/embed-profiles/nonexistent-id')
        .send({ name: 'Does Not Exist' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: 'Embed profile not found' });
    });

    it('returns 500 when database fails', async () => {
      mockDb.updateEmbedProfileAsync.mockRejectedValue(new Error('db failure'));
      const app = createApp();

      const response = await request(app)
        .put('/api/embed-profiles/test-uuid-1234')
        .send({ name: 'Fail' });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ error: 'Failed to update embed profile' });
    });
  });

  describe('DELETE /api/embed-profiles/:id', () => {
    it('deletes a profile and returns 204', async () => {
      mockDb.deleteEmbedProfileAsync.mockResolvedValue(true);
      const app = createApp();

      const response = await request(app)
        .delete('/api/embed-profiles/test-uuid-1234');

      expect(response.status).toBe(204);
      expect(mockDb.deleteEmbedProfileAsync).toHaveBeenCalledWith('test-uuid-1234');
      expect(mockDb.auditLog).toHaveBeenCalled();
    });

    it('returns 404 for nonexistent profile', async () => {
      mockDb.deleteEmbedProfileAsync.mockResolvedValue(false);
      const app = createApp();

      const response = await request(app)
        .delete('/api/embed-profiles/nonexistent-id');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: 'Embed profile not found' });
    });

    it('returns 500 when database fails', async () => {
      mockDb.deleteEmbedProfileAsync.mockRejectedValue(new Error('db failure'));
      const app = createApp();

      const response = await request(app)
        .delete('/api/embed-profiles/test-uuid-1234');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ error: 'Failed to delete embed profile' });
    });
  });
});
