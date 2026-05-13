/**
 * Settings Routes Unit Tests
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import settingsRoutes, {
  validateTileUrl,
  validateCustomTilesets,
  validateAppriseProbeUrl,
  MAX_APPRISE_PROBE_URL_LENGTH,
} from './settingsRoutes.js';
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

    // MM-SEC-1: secret-bearing keys must be stripped from non-admin responses.
    describe('secret stripping (MM-SEC-1)', () => {
      const populateSecrets = () => {
        (databaseService as any).settings.getAllSettings.mockResolvedValue({
          meshName: 'TestMesh',
          vapid_public_key: 'BPUBLIC',
          vapid_private_key: 'PRIVATE-must-not-leak',
          vapid_subject: 'mailto:admin@x',
          securityDigestAppriseUrl: 'mailto://user:pass@smtp/',
          analyticsConfig: '{"token":"sekret"}',
          custom_api_token: 'tok-fffff',
          some_secret: 'shh',
          some_private_key: 'pk',
        });
      };

      it('strips secrets for unauthenticated callers', async () => {
        populateSecrets();
        const app = createApp(null);
        (databaseService as any).findUserByIdAsync.mockResolvedValue(null);

        const res = await request(app).get('/api/settings').expect(200);

        expect(res.body.meshName).toBe('TestMesh');
        expect(res.body.vapid_public_key).toBe('BPUBLIC');
        expect(res.body).not.toHaveProperty('vapid_private_key');
        expect(res.body).not.toHaveProperty('securityDigestAppriseUrl');
        expect(res.body).not.toHaveProperty('analyticsConfig');
        // Tail-pattern denylist
        expect(res.body).not.toHaveProperty('custom_api_token');
        expect(res.body).not.toHaveProperty('some_secret');
        expect(res.body).not.toHaveProperty('some_private_key');
      });

      it('strips secrets for authenticated non-admin callers', async () => {
        populateSecrets();
        const nonAdmin = { id: 2, username: 'viewer', isActive: true, isAdmin: false };
        // optionalAuth re-resolves the user from the session via findUserByIdAsync;
        // mock that lookup so the middleware sees the non-admin identity.
        (databaseService as any).findUserByIdAsync.mockResolvedValue(nonAdmin);
        const app = createApp(nonAdmin);

        const res = await request(app).get('/api/settings').expect(200);

        expect(res.body).not.toHaveProperty('vapid_private_key');
        expect(res.body).not.toHaveProperty('securityDigestAppriseUrl');
        expect(res.body).not.toHaveProperty('analyticsConfig');
      });

      it('returns secrets for admin callers', async () => {
        populateSecrets();
        const app = createApp(adminUser);

        const res = await request(app).get('/api/settings').expect(200);

        expect(res.body.vapid_private_key).toBe('PRIVATE-must-not-leak');
        expect(res.body.securityDigestAppriseUrl).toBe('mailto://user:pass@smtp/');
        expect(res.body.analyticsConfig).toBe('{"token":"sekret"}');
        expect(res.body.custom_api_token).toBe('tok-fffff');
      });
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

    describe('appriseApiServerUrl (#3012)', () => {
      it('should accept a valid http URL', async () => {
        const app = createApp(adminUser);
        await request(app)
          .post('/api/settings')
          .send({ appriseApiServerUrl: 'http://apprise.example.com:8000' })
          .expect(200);
        expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
          expect.objectContaining({ appriseApiServerUrl: 'http://apprise.example.com:8000' })
        );
      });

      it('should accept a valid https URL', async () => {
        const app = createApp(adminUser);
        await request(app)
          .post('/api/settings')
          .send({ appriseApiServerUrl: 'https://apprise.example.com' })
          .expect(200);
      });

      it('should accept an empty / whitespace value (clears the override)', async () => {
        const app = createApp(adminUser);
        await request(app)
          .post('/api/settings')
          .send({ appriseApiServerUrl: '   ' })
          .expect(200);
        expect(databaseService.settings.setSettings).toHaveBeenCalledWith(
          expect.objectContaining({ appriseApiServerUrl: '' })
        );
      });

      it('should reject a non-http(s) scheme', async () => {
        const app = createApp(adminUser);
        const res = await request(app)
          .post('/api/settings')
          .send({ appriseApiServerUrl: 'file:///etc/passwd' })
          .expect(400);
        expect(res.body.error).toContain('http://');
      });

      it('should reject garbage that is not a URL', async () => {
        const app = createApp(adminUser);
        const res = await request(app)
          .post('/api/settings')
          .send({ appriseApiServerUrl: 'not a url' })
          .expect(400);
        expect(res.body.error).toContain('valid http(s) URL');
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
          .send({ appriseApiServerUrl: 'http://apprise.example.com:8000' })
          .expect(403);
      });
    });
  });

  describe('POST /api/settings/test-apprise (#3012)', () => {
    const fetchMock = vi.fn();
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      fetchMock.mockReset();
      globalThis.fetch = fetchMock as any;
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns ok:true when the Apprise server responds 200', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const app = createApp(adminUser);
      const res = await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'http://apprise.example.com:8000' })
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe(200);
      expect(typeof res.body.latencyMs).toBe('number');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('http://apprise.example.com:8000/health');
    });

    it('strips trailing slashes from the supplied URL before probing', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

      const app = createApp(adminUser);
      await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'http://apprise.example.com:8000///' })
        .expect(200);

      expect(fetchMock.mock.calls[0][0]).toBe('http://apprise.example.com:8000/health');
    });

    it('returns ok:false with status when the Apprise server returns a non-2xx', async () => {
      fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));

      const app = createApp(adminUser);
      const res = await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'http://apprise.example.com:8000' })
        .expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe(503);
      expect(res.body.error).toContain('503');
    });

    it('returns ok:false when fetch throws (network failure)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const app = createApp(adminUser);
      const res = await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'http://apprise.example.com:8000' })
        .expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('ECONNREFUSED');
    });

    it('falls back to the saved global setting when no URL is supplied', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
      (databaseService as any).settings.getSetting.mockResolvedValue('http://saved.example.com:8000');

      const app = createApp(adminUser);
      const res = await request(app)
        .post('/api/settings/test-apprise')
        .send({})
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toBe('http://saved.example.com:8000/health');
    });

    it('falls back to http://localhost:8000 when no URL and no saved setting', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
      (databaseService as any).settings.getSetting.mockResolvedValue(null);

      const app = createApp(adminUser);
      await request(app)
        .post('/api/settings/test-apprise')
        .send({})
        .expect(200);

      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/health');
    });

    it('rejects a non-http(s) scheme with 400', async () => {
      const app = createApp(adminUser);
      const res = await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'file:///etc/passwd' })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('http://');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects garbage that is not a URL with 400', async () => {
      const app = createApp(adminUser);
      const res = await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'not a url' })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Invalid URL');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 403 when lacking settings:write permission', async () => {
      const app = createApp({ id: 2, username: 'user', isActive: true, isAdmin: false });
      (databaseService as any).findUserByIdAsync.mockResolvedValue({
        id: 2, username: 'user', isActive: true, isAdmin: false,
      });
      (databaseService as any).checkPermissionAsync.mockResolvedValue(false);
      (databaseService as any).getUserPermissionSetAsync.mockResolvedValue({
        settings: { read: true, write: false },
        isAdmin: false,
      });

      await request(app)
        .post('/api/settings/test-apprise')
        .send({ url: 'http://apprise.example.com:8000' })
        .expect(403);

      expect(fetchMock).not.toHaveBeenCalled();
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

describe('validateAppriseProbeUrl', () => {
  it('accepts a bare http URL and builds /health', () => {
    const r = validateAppriseProbeUrl('http://localhost:8000');
    expect(r.ok).toBe(true);
    expect(r.probeUrl).toBe('http://localhost:8000/health');
  });

  it('accepts an https URL with a path prefix and preserves it', () => {
    const r = validateAppriseProbeUrl('https://apprise.example.com/api');
    expect(r.ok).toBe(true);
    expect(r.probeUrl).toBe('https://apprise.example.com/api/health');
  });

  it('strips multiple trailing slashes without regex backtracking', () => {
    const r = validateAppriseProbeUrl('http://localhost:8000/apprise-api/////');
    expect(r.ok).toBe(true);
    expect(r.probeUrl).toBe('http://localhost:8000/apprise-api/health');
  });

  it('accepts RFC1918 hosts (Docker compose / LAN deployments)', () => {
    const r = validateAppriseProbeUrl('http://192.168.1.50:8000');
    expect(r.ok).toBe(true);
    expect(r.probeUrl).toBe('http://192.168.1.50:8000/health');
  });

  it('rejects empty input', () => {
    expect(validateAppriseProbeUrl('')).toEqual({ ok: false, error: 'URL is required' });
  });

  it('rejects inputs longer than the cap', () => {
    const oversized = 'http://example.com/' + 'a'.repeat(MAX_APPRISE_PROBE_URL_LENGTH);
    const r = validateAppriseProbeUrl(oversized);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('URL is too long');
  });

  it('rejects non-http(s) protocols', () => {
    expect(validateAppriseProbeUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateAppriseProbeUrl('ftp://example.com').ok).toBe(false);
    expect(validateAppriseProbeUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects unparsable input', () => {
    expect(validateAppriseProbeUrl('not a url').ok).toBe(false);
    expect(validateAppriseProbeUrl('http://').ok).toBe(false);
  });

  it('blocks AWS/Azure IPv4 IMDS (169.254.169.254)', () => {
    const r = validateAppriseProbeUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Host is not permitted');
  });

  it('blocks the rest of the 169.254.0.0/16 link-local range', () => {
    expect(validateAppriseProbeUrl('http://169.254.0.1').ok).toBe(false);
    expect(validateAppriseProbeUrl('http://169.254.255.254').ok).toBe(false);
  });

  it('blocks GCP IMDS hostname (case-insensitive)', () => {
    expect(validateAppriseProbeUrl('http://metadata.google.internal/').ok).toBe(false);
    expect(validateAppriseProbeUrl('http://Metadata.Google.Internal/').ok).toBe(false);
  });

  it('blocks Azure IMDS hostname', () => {
    expect(validateAppriseProbeUrl('http://metadata.azure.com/').ok).toBe(false);
  });

  it('does not over-block similar-looking hosts', () => {
    expect(validateAppriseProbeUrl('http://metadata.google.internal.evil.com/').ok).toBe(true);
    expect(validateAppriseProbeUrl('http://169.254.169.254.nip.io/').ok).toBe(true);
    expect(validateAppriseProbeUrl('http://169.253.169.254/').ok).toBe(true);
  });
});
