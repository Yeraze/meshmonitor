/**
 * Settings Routes Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import settingsRoutes, { validateTileUrl, validateCustomTilesets } from './settingsRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getAllSettings: vi.fn(),
      setSettings: vi.fn(),
      getSetting: vi.fn(),
      deleteAllSettings: vi.fn(),
    },
    auditLogAsync: vi.fn(),
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

// Mock securityDigestService
vi.mock('../services/securityDigestService.js', () => ({
  securityDigestService: {
    generateDigest: vi.fn().mockResolvedValue(undefined),
  }
}));

const adminUser = {
  id: 1,
  username: 'admin',
  isActive: true,
  isAdmin: true,
};

const createApp = (user: any = null, withPermission = true): Express => {
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

  // Mock auth
  app.use((req: any, _res: any, next: any) => {
    if (user) {
      req.user = user;
      req.session.userId = user.id;
    }
    next();
  });

  app.use('/api/settings', settingsRoutes);

  return app;
};

describe('settingsRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const mockDb = databaseService as any;
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({
      settings: { read: true, write: true },
      isAdmin: true,
    });
    mockDb.settings.getAllSettings.mockResolvedValue({
      meshName: 'TestMesh',
      maxNodeAgeHours: '24',
    });
    mockDb.settings.setSettings.mockResolvedValue(undefined);
    mockDb.settings.getSetting.mockResolvedValue(null);
    mockDb.settings.deleteAllSettings.mockResolvedValue(undefined);
    mockDb.auditLogAsync.mockResolvedValue(undefined);
  });

  describe('GET /api/settings', () => {
    it('should return all settings', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .get('/api/settings')
        .expect(200);

      expect(res.body).toHaveProperty('meshName');
      expect(databaseService.settings.getAllSettings).toHaveBeenCalled();
    });

    it('should return settings for unauthenticated user (optionalAuth)', async () => {
      const app = createApp(null);
      (databaseService as any).findUserByIdAsync.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/settings')
        .expect(200);

      expect(res.body).toHaveProperty('meshName');
    });

    it('should return 500 when database fails', async () => {
      const app = createApp(adminUser);
      (databaseService as any).settings.getAllSettings.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .get('/api/settings')
        .expect(500);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('POST /api/settings', () => {
    it('should save valid settings', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ meshName: 'NewMesh' })
        .expect(200);

      expect(databaseService.settings.setSettings).toHaveBeenCalled();
    });

    it('should return 401 when not authenticated', async () => {
      const app = createApp(null);
      (databaseService as any).findUserByIdAsync.mockResolvedValue(null);

      await request(app)
        .post('/api/settings')
        .send({ meshName: 'Test' })
        .expect(401);
    });

    it('should return 403 when lacking settings:write permission', async () => {
      const app = createApp({ id: 2, username: 'user', isActive: true, isAdmin: false });
      (databaseService as any).findUserByIdAsync.mockResolvedValue({
        id: 2, username: 'user', isActive: true, isAdmin: false
      });
      (databaseService as any).checkPermissionAsync.mockResolvedValue(false);
      (databaseService as any).getUserPermissionSetAsync.mockResolvedValue({
        settings: { read: true, write: false },
        isAdmin: false,
      });

      await request(app)
        .post('/api/settings')
        .send({ meshName: 'Test' })
        .expect(403);
    });

    it('should return 400 for invalid regex pattern (too long)', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ autoAckRegex: 'a'.repeat(101) })
        .expect(400);

      expect(res.body.error).toContain('too long');
    });

    it('should return 400 for complex regex pattern', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ autoAckRegex: '.*.*' })
        .expect(400);

      expect(res.body.error).toContain('complex');
    });

    it('should return 400 for invalid regex syntax', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ autoAckRegex: '[invalid' })
        .expect(400);

      expect(res.body.error).toContain('Invalid regex');
    });

    it('should return 400 for out-of-range inactiveNodeThresholdHours', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ inactiveNodeThresholdHours: '999' })
        .expect(400);

      expect(res.body.error).toContain('inactiveNodeThresholdHours');
    });

    it('should return 400 for zero inactiveNodeThresholdHours', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ inactiveNodeThresholdHours: '0' })
        .expect(400);

      expect(res.body.error).toContain('inactiveNodeThresholdHours');
    });

    it('should return 400 for out-of-range inactiveNodeCheckIntervalMinutes', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .post('/api/settings')
        .send({ inactiveNodeCheckIntervalMinutes: '2000' })
        .expect(400);

      expect(res.body.error).toContain('inactiveNodeCheckIntervalMinutes');
    });

    it('should filter out unknown settings keys', async () => {
      const app = createApp(adminUser);

      await request(app)
        .post('/api/settings')
        .send({ unknownSettingXYZ: 'value', meshName: 'Test' })
        .expect(200);

      // meshName is valid, unknownSettingXYZ should be filtered
      expect(databaseService.settings.setSettings).toHaveBeenCalled();
    });

    it('should return 500 when database fails', async () => {
      const app = createApp(adminUser);
      (databaseService as any).settings.setSettings.mockRejectedValue(new Error('DB error'));

      await request(app)
        .post('/api/settings')
        .send({ meshName: 'NewMesh' })
        .expect(500);
    });
  });

  describe('DELETE /api/settings', () => {
    it('should reset settings to defaults', async () => {
      const app = createApp(adminUser);

      const res = await request(app)
        .delete('/api/settings')
        .expect(200);

      expect(databaseService.settings.deleteAllSettings).toHaveBeenCalled();
    });

    it('should return 401 when not authenticated', async () => {
      const app = createApp(null);
      (databaseService as any).findUserByIdAsync.mockResolvedValue(null);

      await request(app)
        .delete('/api/settings')
        .expect(401);
    });

    it('should return 403 when lacking settings:write permission', async () => {
      const app = createApp({ id: 2, username: 'user', isActive: true, isAdmin: false });
      (databaseService as any).findUserByIdAsync.mockResolvedValue({
        id: 2, username: 'user', isActive: true, isAdmin: false
      });
      (databaseService as any).checkPermissionAsync.mockResolvedValue(false);
      (databaseService as any).getUserPermissionSetAsync.mockResolvedValue({
        settings: { read: true, write: false },
        isAdmin: false,
      });

      await request(app)
        .delete('/api/settings')
        .expect(403);
    });

    it('should return 500 when database fails', async () => {
      const app = createApp(adminUser);
      (databaseService as any).settings.deleteAllSettings.mockRejectedValue(new Error('DB error'));

      await request(app)
        .delete('/api/settings')
        .expect(500);
    });
  });
});

describe('validateTileUrl', () => {
  it('should accept valid tile URL with z, x, y placeholders', () => {
    expect(validateTileUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png')).toBe(true);
  });

  it('should accept valid tile URL with subdomains', () => {
    expect(validateTileUrl('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png')).toBe(true);
  });

  it('should reject URL missing z placeholder', () => {
    expect(validateTileUrl('https://tile.example.com/{x}/{y}.png')).toBe(false);
  });

  it('should reject URL missing x placeholder', () => {
    expect(validateTileUrl('https://tile.example.com/{z}/{y}.png')).toBe(false);
  });

  it('should reject URL missing y placeholder', () => {
    expect(validateTileUrl('https://tile.example.com/{z}/{x}.png')).toBe(false);
  });

  it('should reject non-http/https protocol', () => {
    expect(validateTileUrl('ftp://tile.example.com/{z}/{x}/{y}.png')).toBe(false);
  });

  it('should reject invalid URL', () => {
    expect(validateTileUrl('not-a-url/{z}/{x}/{y}')).toBe(false);
  });
});

describe('validateCustomTilesets', () => {
  const validTileset = {
    id: 'custom-test123',
    name: 'Test Tileset',
    url: 'https://tile.example.com/{z}/{x}/{y}.png',
    attribution: 'Test Attribution',
    maxZoom: 18,
    description: 'A test tileset',
    createdAt: 1000000,
    updatedAt: 1000000,
  };

  it('should accept valid tilesets array', () => {
    expect(validateCustomTilesets([validTileset])).toBe(true);
  });

  it('should accept empty array', () => {
    expect(validateCustomTilesets([])).toBe(true);
  });

  it('should reject non-array input', () => {
    expect(validateCustomTilesets('not-array' as any)).toBe(false);
  });

  it('should reject tileset with id not starting with "custom-"', () => {
    expect(validateCustomTilesets([{ ...validTileset, id: 'osm' }])).toBe(false);
  });

  it('should reject tileset with maxZoom > 22', () => {
    expect(validateCustomTilesets([{ ...validTileset, maxZoom: 23 }])).toBe(false);
  });

  it('should reject tileset with maxZoom < 1', () => {
    expect(validateCustomTilesets([{ ...validTileset, maxZoom: 0 }])).toBe(false);
  });

  it('should reject tileset with name too long (> 100 chars)', () => {
    expect(validateCustomTilesets([{ ...validTileset, name: 'a'.repeat(101) }])).toBe(false);
  });

  it('should reject tileset with invalid URL', () => {
    expect(validateCustomTilesets([{ ...validTileset, url: 'invalid-url' }])).toBe(false);
  });

  it('should reject tileset missing required fields', () => {
    const { name, ...incomplete } = validTileset;
    expect(validateCustomTilesets([incomplete as any])).toBe(false);
  });
});
