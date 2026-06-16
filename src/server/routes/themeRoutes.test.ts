import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import themeRoutes from './themeRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    auditLogAsync: vi.fn(),
    validateThemeDefinition: vi.fn(),
    misc: {
      getAllCustomThemes: vi.fn(),
      getCustomThemeBySlug: vi.fn(),
      createCustomTheme: vi.fn(),
      updateCustomTheme: vi.fn(),
      deleteCustomTheme: vi.fn(),
    },
  },
}));

const mockDb = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
  auditLogAsync: ReturnType<typeof vi.fn>;
  validateThemeDefinition: ReturnType<typeof vi.fn>;
  misc: {
    getAllCustomThemes: ReturnType<typeof vi.fn>;
    getCustomThemeBySlug: ReturnType<typeof vi.fn>;
    createCustomTheme: ReturnType<typeof vi.fn>;
    updateCustomTheme: ReturnType<typeof vi.fn>;
    deleteCustomTheme: ReturnType<typeof vi.fn>;
  };
};

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (userId?: number, isAdmin = false): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  if (userId !== undefined) {
    app.use((req, _res, next) => {
      req.session.userId = userId;
      next();
    });
  }
  app.use('/themes', themeRoutes);
  return app;
};

const sampleTheme = { id: 1, name: 'Dark Mode', slug: 'custom-dark', definition: '{}', is_builtin: false };

describe('Theme Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.auditLogAsync.mockResolvedValue(undefined);
    mockDb.validateThemeDefinition.mockReturnValue(true);
  });

  describe('GET /themes', () => {
    it('returns all themes without authentication', async () => {
      mockDb.misc.getAllCustomThemes.mockResolvedValue([sampleTheme]);
      const app = createApp();
      const res = await request(app).get('/themes');
      expect(res.status).toBe(200);
      expect(res.body.themes).toHaveLength(1);
    });

    it('returns all themes for authenticated users', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
      mockDb.misc.getAllCustomThemes.mockResolvedValue([sampleTheme]);
      const app = createApp(regularUser.id);
      const res = await request(app).get('/themes');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /themes/:slug', () => {
    it('returns a specific theme by slug', async () => {
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(sampleTheme);
      const app = createApp();
      const res = await request(app).get('/themes/custom-dark');
      expect(res.status).toBe(200);
      expect(res.body.theme.slug).toBe('custom-dark');
    });

    it('returns 404 for unknown slug', async () => {
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(null);
      const app = createApp();
      const res = await request(app).get('/themes/custom-nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /themes', () => {
    it('returns 401 for unauthenticated users', async () => {
      const app = createApp();
      const res = await request(app).post('/themes').send({ name: 'Test', slug: 'custom-test', definition: {} });
      expect(res.status).toBe(401);
    });

    it('returns 403 for users without themes:write permission', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
      const app = createApp(regularUser.id);
      const res = await request(app).post('/themes').send({ name: 'Test', slug: 'custom-test', definition: {} });
      expect(res.status).toBe(403);
    });

    it('creates a theme for admin', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(null);
      mockDb.misc.createCustomTheme.mockResolvedValue(sampleTheme);
      const app = createApp(adminUser.id);
      const res = await request(app)
        .post('/themes')
        .send({ name: 'Dark Mode', slug: 'custom-dark', definition: { '--primary': '#000' } });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('returns 400 for invalid slug format', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      const app = createApp(adminUser.id);
      const res = await request(app)
        .post('/themes')
        .send({ name: 'Test', slug: 'invalid-slug', definition: {} });
      expect(res.status).toBe(400);
    });

    it('returns 409 when slug already exists', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(sampleTheme);
      const app = createApp(adminUser.id);
      const res = await request(app)
        .post('/themes')
        .send({ name: 'Dark Mode', slug: 'custom-dark', definition: {} });
      expect(res.status).toBe(409);
    });
  });

  describe('PUT /themes/:slug', () => {
    it('updates an existing theme', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(sampleTheme);
      mockDb.misc.updateCustomTheme.mockResolvedValue(undefined);
      const app = createApp(adminUser.id);
      const res = await request(app).put('/themes/custom-dark').send({ name: 'Dark Mode Updated' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 when trying to modify a built-in theme', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue({ ...sampleTheme, is_builtin: true });
      const app = createApp(adminUser.id);
      const res = await request(app).put('/themes/custom-dark').send({ name: 'Updated' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /themes/:slug', () => {
    it('deletes a custom theme', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(sampleTheme);
      mockDb.misc.deleteCustomTheme.mockResolvedValue(undefined);
      const app = createApp(adminUser.id);
      const res = await request(app).delete('/themes/custom-dark');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 when trying to delete a built-in theme', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue({ ...sampleTheme, is_builtin: true });
      const app = createApp(adminUser.id);
      const res = await request(app).delete('/themes/custom-dark');
      expect(res.status).toBe(403);
    });

    it('returns 404 for unknown theme', async () => {
      mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
      mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
      mockDb.misc.getCustomThemeBySlug.mockResolvedValue(null);
      const app = createApp(adminUser.id);
      const res = await request(app).delete('/themes/custom-nonexistent');
      expect(res.status).toBe(404);
    });
  });
});
