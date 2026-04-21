/**
 * MapStyle Routes Tests
 *
 * Uses a real MapStyleService with a temp directory (no mocking of the service).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MapStyleService } from '../services/mapStyleService.js';
import { createMapStyleRouter } from './mapStyleRoutes.js';
import databaseService from '../../services/database.js';

// Mock DNS lookup so the SSRF guard treats the fake tileserver hostname as public.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

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

// Minimal valid MapLibre GL style
const VALID_STYLE = JSON.stringify({
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
    },
  ],
});

function createApp(service: MapStyleService) {
  const app = express();
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Inject authenticated session
  app.use((req, _res, next) => {
    req.session.userId = defaultUser.id;
    req.session.username = defaultUser.username;
    next();
  });
  const router = createMapStyleRouter(service);
  app.use('/', router);
  return app;
}

describe('MapStyle Routes', () => {
  let tmpDir: string;
  let service: MapStyleService;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabase.findUserByIdAsync.mockResolvedValue(defaultUser);
    mockDatabase.findUserByUsernameAsync.mockResolvedValue(null);
    mockDatabase.checkPermissionAsync.mockResolvedValue(true);
    mockDatabase.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstyle-test-'));
    service = new MapStyleService(tmpDir);
    app = createApp(service);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- GET /styles ----------------------------------------------------------

  describe('GET /styles', () => {
    it('returns empty array when no styles exist', async () => {
      const res = await request(app).get('/styles');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns styles after upload', async () => {
      service.addStyle('mystyle', VALID_STYLE, 'upload');
      const res = await request(app).get('/styles');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('mystyle');
    });
  });

  // ---- POST /upload ---------------------------------------------------------

  describe('POST /upload', () => {
    it('accepts valid style and returns 201', async () => {
      const res = await request(app)
        .post('/upload')
        .set('X-Filename', 'mymap.json')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(VALID_STYLE));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'mymap',
        sourceType: 'upload',
      });
      expect(res.body.id).toBeTruthy();
    });

    it('rejects invalid style content with 400', async () => {
      const res = await request(app)
        .post('/upload')
        .set('X-Filename', 'bad.json')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('{"not": "a maplibre style"}'));

      expect(res.status).toBe(400);
    });

    it('rejects missing X-Filename header with 400', async () => {
      const res = await request(app)
        .post('/upload')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(VALID_STYLE));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/filename/i);
    });
  });

  // ---- POST /from-url -------------------------------------------------------

  describe('POST /from-url', () => {
    it('returns 400 when url is missing', async () => {
      const res = await request(app)
        .post('/from-url')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/url/i);
    });
  });

  // ---- PUT /styles/:id ------------------------------------------------------

  describe('PUT /styles/:id', () => {
    it('updates style metadata', async () => {
      const style = service.addStyle('original', VALID_STYLE, 'upload');

      const res = await request(app)
        .put(`/styles/${style.id}`)
        .set('Content-Type', 'application/json')
        .send({ name: 'renamed' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('renamed');
    });

    it('returns 404 for nonexistent style', async () => {
      const res = await request(app)
        .put('/styles/nonexistent-id')
        .set('Content-Type', 'application/json')
        .send({ name: 'foo' });

      expect(res.status).toBe(404);
    });
  });

  // ---- DELETE /styles/:id ---------------------------------------------------

  describe('DELETE /styles/:id', () => {
    it('removes style and returns 204', async () => {
      const style = service.addStyle('todelete', VALID_STYLE, 'upload');

      const res = await request(app).delete(`/styles/${style.id}`);
      expect(res.status).toBe(204);

      // Verify it's gone
      const listRes = await request(app).get('/styles');
      expect(listRes.body).toHaveLength(0);
    });

    it('returns 404 for nonexistent style', async () => {
      const res = await request(app).delete('/styles/nonexistent-id');
      expect(res.status).toBe(404);
    });
  });

  // ---- GET /styles/:id/data -------------------------------------------------

  describe('GET /styles/:id/data', () => {
    it('returns raw style JSON with correct content type', async () => {
      const style = service.addStyle('data', VALID_STYLE, 'upload');

      const res = await request(app).get(`/styles/${style.id}/data`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const parsed = JSON.parse(res.text);
      expect(parsed.version).toBe(8);
    });

    it('returns 404 for nonexistent style', async () => {
      const res = await request(app).get('/styles/nonexistent-id/data');
      expect(res.status).toBe(404);
    });
  });

  // ---- POST /generate-from-tileserver ---------------------------------------

  describe('POST /generate-from-tileserver', () => {
    let fetchSpy: MockInstance;

    const VALID_TILEJSON = {
      tilejson: '2.2.0',
      name: 'My Custom Tiles',
      attribution: '&copy; OSM Contributors',
      minzoom: 0,
      maxzoom: 14,
      tiles: ['http://tileserver:8080/data/v3/{z}/{x}/{y}.pbf'],
      vector_layers: [
        { id: 'water', geometry_type: 'polygon' },
        { id: 'building', geometry_type: 'polygon' },
        { id: 'transportation', geometry_type: 'line' },
        { id: 'place', geometry_type: 'point' },
        { id: 'landuse' }, // no geometry_type — unknown
      ],
    };

    beforeEach(() => {
      fetchSpy = vi.spyOn(global, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('returns 400 when tileJsonUrl is missing', async () => {
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tileJsonUrl/i);
    });

    it('returns 400 for an invalid URL', async () => {
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'not-a-url' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
    });

    it('returns 400 for non-http protocol', async () => {
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'ftp://tileserver/data.json' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/http/i);
    });

    it('returns 400 when remote fetch fails with non-200 status', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/HTTP 404/);
    });

    it('returns 400 when remote fetch throws a network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ECONNREFUSED/);
    });

    it('returns 400 when TileJSON has no tiles array', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ vector_layers: [{ id: 'water' }] }), { status: 200 })
      );
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tiles/i);
    });

    it('returns 400 when TileJSON has no vector_layers', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tiles: ['http://tileserver/tiles/{z}/{x}/{y}.png'] }),
          { status: 200 }
        )
      );
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/vector_layers/i);
    });

    it('returns 200 with a valid MapLibre GL v8 style for a well-formed TileJSON', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_TILEJSON), { status: 200 })
      );
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });

      expect(res.status).toBe(200);
      expect(res.body.filename).toMatch(/\.json$/);
      const style = res.body.style;
      expect(style.version).toBe(8);
      expect(typeof style.sources).toBe('object');
      expect(Array.isArray(style.layers)).toBe(true);
      expect(style.layers.length).toBeGreaterThan(0);
    });

    it('uses provided name in the generated style and filename', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_TILEJSON), { status: 200 })
      );
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json', name: 'My Map Style' });

      expect(res.status).toBe(200);
      expect(res.body.style.name).toBe('My Map Style');
      expect(res.body.filename).toContain('my_map_style');
    });

    it('generates layers for each vector layer in TileJSON', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_TILEJSON), { status: 200 })
      );
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });

      expect(res.status).toBe(200);
      const layers: { 'source-layer': string }[] = res.body.style.layers;
      const sourceLayers = new Set(layers.map(l => l['source-layer']));
      // All 5 vector layers should have at least one MapLibre layer
      for (const vl of VALID_TILEJSON.vector_layers) {
        expect(sourceLayers).toContain(vl.id);
      }
    });

    it('uses correct layer types per geometry hint', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_TILEJSON), { status: 200 })
      );
      const res = await request(app)
        .post('/generate-from-tileserver')
        .set('Content-Type', 'application/json')
        .send({ tileJsonUrl: 'http://tileserver:8080/data/v3.json' });

      expect(res.status).toBe(200);
      const layers: { id: string; type: string; 'source-layer': string }[] = res.body.style.layers;

      // point → circle
      const placeLayers = layers.filter(l => l['source-layer'] === 'place');
      expect(placeLayers).toHaveLength(1);
      expect(placeLayers[0].type).toBe('circle');

      // line → line
      const transportLayers = layers.filter(l => l['source-layer'] === 'transportation');
      expect(transportLayers).toHaveLength(1);
      expect(transportLayers[0].type).toBe('line');

      // polygon → fill + line
      const waterLayers = layers.filter(l => l['source-layer'] === 'water');
      expect(waterLayers).toHaveLength(2);
      expect(waterLayers.map(l => l.type).sort()).toEqual(['fill', 'line']);

      // unknown → fill + line
      const landuseLayers = layers.filter(l => l['source-layer'] === 'landuse');
      expect(landuseLayers).toHaveLength(2);
      expect(landuseLayers.map(l => l.type).sort()).toEqual(['fill', 'line']);
    });
  });
});
