/**
 * GeoJSON Routes Tests
 *
 * Uses a real GeoJsonService with a temp directory (no mocking of the service).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeoJsonService } from '../services/geojsonService.js';
import { createGeoJsonRouter } from './geojsonRoutes.js';
import databaseService from '../../services/database.js';

// Mock DatabaseService for authMiddleware's requirePermission
vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

const mockDatabase = databaseService as unknown as {
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
};

const defaultUser = { id: 1, username: 'admin', isAdmin: true, isActive: true };

const VALID_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { name: 'Test Point' },
    },
  ],
});

function createApp(service: GeoJsonService) {
  const app = express();
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Inject authenticated session
  app.use((req, _res, next) => {
    req.session.userId = defaultUser.id;
    req.session.username = defaultUser.username;
    next();
  });
  const router = createGeoJsonRouter(service);
  app.use('/', router);
  return app;
}

describe('GeoJSON Routes', () => {
  let tmpDir: string;
  let service: GeoJsonService;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabase.findUserByIdAsync.mockResolvedValue(defaultUser);
    mockDatabase.findUserByUsernameAsync.mockResolvedValue(null);
    mockDatabase.checkPermissionAsync.mockResolvedValue(true);
    mockDatabase.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-test-'));
    service = new GeoJsonService(tmpDir);
    app = createApp(service);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- GET /layers --------------------------------------------------------

  describe('GET /layers', () => {
    it('returns empty array when no layers exist', async () => {
      const res = await request(app).get('/layers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns layers after upload', async () => {
      service.addLayer('test.geojson', VALID_GEOJSON);
      const res = await request(app).get('/layers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('test');
    });
  });

  // ---- POST /upload -------------------------------------------------------

  describe('POST /upload', () => {
    it('accepts valid GeoJSON and returns 201 with layer object', async () => {
      const res = await request(app)
        .post('/upload')
        .set('X-Filename', 'mymap.geojson')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(VALID_GEOJSON));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'mymap',
        visible: true,
      });
      expect(res.body.id).toBeTruthy();
    });

    it('rejects invalid GeoJSON with 400', async () => {
      const res = await request(app)
        .post('/upload')
        .set('X-Filename', 'bad.geojson')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('{"not": "geojson"}'));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid.*geojson/i);
    });

    it('rejects missing X-Filename header with 400', async () => {
      const res = await request(app)
        .post('/upload')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(VALID_GEOJSON));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/filename/i);
    });
  });

  // ---- PUT /layers/:id ----------------------------------------------------

  describe('PUT /layers/:id', () => {
    it('updates layer metadata', async () => {
      const layer = service.addLayer('original.geojson', VALID_GEOJSON);

      const res = await request(app)
        .put(`/layers/${layer.id}`)
        .set('Content-Type', 'application/json')
        .send({ name: 'renamed', visible: false });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('renamed');
      expect(res.body.visible).toBe(false);
    });

    it('returns 404 for nonexistent layer', async () => {
      const res = await request(app)
        .put('/layers/nonexistent-id')
        .set('Content-Type', 'application/json')
        .send({ name: 'foo' });

      expect(res.status).toBe(404);
    });
  });

  // ---- DELETE /layers/:id -------------------------------------------------

  describe('DELETE /layers/:id', () => {
    it('removes layer and returns 204', async () => {
      const layer = service.addLayer('todelete.geojson', VALID_GEOJSON);

      const res = await request(app).delete(`/layers/${layer.id}`);
      expect(res.status).toBe(204);

      // Verify it's gone
      const listRes = await request(app).get('/layers');
      expect(listRes.body).toHaveLength(0);
    });

    it('returns 404 for nonexistent layer', async () => {
      const res = await request(app).delete('/layers/nonexistent-id');
      expect(res.status).toBe(404);
    });
  });

  // ---- GET /layers/:id/data -----------------------------------------------

  describe('GET /layers/:id/data', () => {
    it('returns raw GeoJSON with correct content type', async () => {
      const layer = service.addLayer('data.geojson', VALID_GEOJSON);

      const res = await request(app).get(`/layers/${layer.id}/data`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/geo\+json/);
      const parsed = JSON.parse(res.text);
      expect(parsed.type).toBe('FeatureCollection');
    });

    it('returns 404 for nonexistent layer', async () => {
      const res = await request(app).get('/layers/nonexistent-id/data');
      expect(res.status).toBe(404);
    });
  });
});
