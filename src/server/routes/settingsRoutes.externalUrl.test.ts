/**
 * externalUrl setting (#4437, WP2).
 *
 * A new global, admin-only setting: the absolute origin this MeshMonitor
 * install is reachable at, used by securityDigestService's detailsLink()
 * to build the "View details" link in security digests. See
 * docs/internal/dev-notes/EPIC_FOLLOWUP_FIXES_SPEC.md §3.
 *
 * Split from settingsRoutes.test.ts per the file-ownership table (WP2 owns
 * this new file; WP1 owns securityDigestService.appriseEndpoint.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import settingsRoutes from './settingsRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getAllSettings: vi.fn(),
      setSettings: vi.fn(),
      getSetting: vi.fn(),
      deleteAllSettings: vi.fn(),
      setSourceSettings: vi.fn(),
      getSettingForSource: vi.fn(),
    },
    auditLogAsync: vi.fn(),
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

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

const createApp = (user: any = null): Express => {
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

describe('settingsRoutes — externalUrl (#4437)', () => {
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
    mockDb.settings.setSourceSettings.mockResolvedValue(undefined);
    mockDb.settings.getSettingForSource.mockResolvedValue(null);
    mockDb.auditLogAsync.mockResolvedValue(undefined);
  });

  it('accepts a valid https URL with no trailing slash unchanged', async () => {
    const app = createApp(adminUser);
    await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'https://mesh.example.com' })
      .expect(200);
    expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ externalUrl: 'https://mesh.example.com' })
    );
  });

  it('accepts a valid http URL', async () => {
    const app = createApp(adminUser);
    await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'http://mesh.internal:8080' })
      .expect(200);
    expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ externalUrl: 'http://mesh.internal:8080' })
    );
  });

  // The trap CLAUDE.md and the spec both flag: detailsLink() emits
  // `${baseUrl}/security` verbatim, so a trailing slash left in storage
  // would ship a doubled `//security` in every digest.
  it('strips a single trailing slash before storing', async () => {
    const app = createApp(adminUser);
    await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'https://mesh.example.com/' })
      .expect(200);
    expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ externalUrl: 'https://mesh.example.com' })
    );
  });

  it('strips ALL trailing slashes, not just one', async () => {
    const app = createApp(adminUser);
    await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'https://mesh.example.com///' })
      .expect(200);
    expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ externalUrl: 'https://mesh.example.com' })
    );
  });

  it('preserves a base-path prefix while stripping its trailing slash', async () => {
    const app = createApp(adminUser);
    await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'https://mesh.example.com/meshmonitor/' })
      .expect(200);
    expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ externalUrl: 'https://mesh.example.com/meshmonitor' })
    );
  });

  it('accepts an empty / whitespace value (clears the override, keeps detailsLink() omitting the line)', async () => {
    const app = createApp(adminUser);
    await request(app)
      .post('/api/settings')
      .send({ externalUrl: '   ' })
      .expect(200);
    expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ externalUrl: '' })
    );
  });

  it('rejects a non-http(s) scheme', async () => {
    const app = createApp(adminUser);
    const res = await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'ftp://mesh.example.com' })
      .expect(400);
    expect(res.body.error).toContain('http://');
  });

  it('rejects garbage that is not a URL', async () => {
    const app = createApp(adminUser);
    const res = await request(app)
      .post('/api/settings')
      .send({ externalUrl: 'not a url' })
      .expect(400);
    expect(res.body.error).toContain('valid http(s) URL');
  });

  it('rejects a non-string value (coerced to a string that fails URL parsing)', async () => {
    const app = createApp(adminUser);
    const res = await request(app)
      .post('/api/settings')
      .send({ externalUrl: 12345 })
      .expect(400);
    expect(res.body.error).toContain('valid http(s) URL');
  });

  it('returns 403 when lacking settings:write permission', async () => {
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
      .send({ externalUrl: 'https://mesh.example.com' })
      .expect(403);
  });
});
