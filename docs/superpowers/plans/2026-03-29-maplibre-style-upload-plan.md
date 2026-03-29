# Custom MapLibre Style Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to upload or fetch custom MapLibre GL style JSON files and switch between them via a map control dropdown when a vector tileset is active.

**Architecture:** A new `mapStyleService` manages style files and a manifest in `/data/styles/`. Routes expose upload, URL-fetch, and CRUD endpoints. A `MapStyleManager` component in Map Settings handles management. A dropdown control on the map switches the active style, passing it to `VectorTileLayer` via a new `styleJson` prop.

**Tech Stack:** Express routes, native Node.js `fetch()` for URL imports, MapLibre GL JS for style rendering, existing settings UI patterns.

**Spec:** `docs/superpowers/specs/2026-03-29-maplibre-style-upload-design.md`

---

### Task 1: MapStyle Service — Manifest & File Management

**Files:**
- Create: `src/server/services/mapStyleService.ts`
- Create: `src/server/services/mapStyleService.test.ts`

- [ ] **Step 1: Write failing tests for manifest and style operations**

```typescript
// src/server/services/mapStyleService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MapStyleService } from './mapStyleService.js';

const VALID_STYLE = JSON.stringify({
  version: 8,
  sources: { openmaptiles: { type: 'vector', url: 'https://example.com/tiles.json' } },
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#000' } }],
});

const INVALID_STYLE_NO_VERSION = JSON.stringify({
  sources: {},
  layers: [],
});

const INVALID_STYLE_NO_LAYERS = JSON.stringify({
  version: 8,
  sources: {},
});

describe('MapStyleService', () => {
  let service: MapStyleService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstyle-test-'));
    service = new MapStyleService(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadManifest', () => {
    it('returns empty styles when no manifest exists', () => {
      const manifest = service.loadManifest();
      expect(manifest.styles).toEqual([]);
    });

    it('loads existing manifest', () => {
      const manifest = {
        styles: [{
          id: 'test', name: 'Test', filename: 'test.json',
          sourceType: 'upload', sourceUrl: null,
          createdAt: Date.now(), updatedAt: Date.now(),
        }],
      };
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
      const loaded = service.loadManifest();
      expect(loaded.styles).toHaveLength(1);
      expect(loaded.styles[0].name).toBe('Test');
    });
  });

  describe('validateStyle', () => {
    it('accepts valid MapLibre style with version 8, sources, and layers', () => {
      expect(service.validateStyle(VALID_STYLE)).toBe(true);
    });

    it('rejects style missing version', () => {
      expect(service.validateStyle(INVALID_STYLE_NO_VERSION)).toBe(false);
    });

    it('rejects style missing layers', () => {
      expect(service.validateStyle(INVALID_STYLE_NO_LAYERS)).toBe(false);
    });

    it('rejects invalid JSON', () => {
      expect(service.validateStyle('not json')).toBe(false);
    });

    it('rejects non-object values', () => {
      expect(service.validateStyle('"just a string"')).toBe(false);
    });
  });

  describe('addStyle', () => {
    it('stores file and adds to manifest', () => {
      const style = service.addStyle('Dark Theme', VALID_STYLE, 'upload');
      expect(style.name).toBe('Dark Theme');
      expect(style.sourceType).toBe('upload');
      expect(style.sourceUrl).toBeNull();
      expect(fs.existsSync(path.join(tmpDir, style.filename))).toBe(true);
    });

    it('stores sourceUrl for URL-sourced styles', () => {
      const style = service.addStyle('Remote', VALID_STYLE, 'url', 'https://example.com/style.json');
      expect(style.sourceType).toBe('url');
      expect(style.sourceUrl).toBe('https://example.com/style.json');
    });
  });

  describe('deleteStyle', () => {
    it('removes file and manifest entry', () => {
      const style = service.addStyle('ToDelete', VALID_STYLE, 'upload');
      service.deleteStyle(style.id);
      expect(service.loadManifest().styles).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, style.filename))).toBe(false);
    });

    it('throws for non-existent style', () => {
      expect(() => service.deleteStyle('nonexistent')).toThrow();
    });
  });

  describe('updateStyle', () => {
    it('updates name', () => {
      const style = service.addStyle('Original', VALID_STYLE, 'upload');
      const updated = service.updateStyle(style.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
    });

    it('throws for non-existent style', () => {
      expect(() => service.updateStyle('nonexistent', { name: 'x' })).toThrow();
    });
  });

  describe('getStyleData', () => {
    it('returns raw style JSON content', () => {
      const style = service.addStyle('Data', VALID_STYLE, 'upload');
      const data = service.getStyleData(style.id);
      expect(JSON.parse(data).version).toBe(8);
    });

    it('auto-removes orphaned style when file is missing', () => {
      const style = service.addStyle('Orphan', VALID_STYLE, 'upload');
      fs.unlinkSync(path.join(tmpDir, style.filename));
      expect(() => service.getStyleData(style.id)).toThrow(/removed from manifest/);
      expect(service.loadManifest().styles).toHaveLength(0);
    });
  });

  describe('getStyles', () => {
    it('returns all styles', () => {
      service.addStyle('A', VALID_STYLE, 'upload');
      service.addStyle('B', VALID_STYLE, 'url', 'https://example.com');
      expect(service.getStyles()).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/services/mapStyleService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MapStyleService**

```typescript
// src/server/services/mapStyleService.ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

export interface MapStyle {
  id: string;
  name: string;
  filename: string;
  sourceType: 'upload' | 'url';
  sourceUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MapStyleManifest {
  styles: MapStyle[];
}

const DEFAULT_STYLE_DIR = '/data/styles';
const MANIFEST_FILENAME = 'manifest.json';

export class MapStyleService {
  private readonly dataDir: string;
  private readonly manifestPath: string;

  constructor(dataDir: string = DEFAULT_STYLE_DIR) {
    this.dataDir = dataDir;
    this.manifestPath = path.join(dataDir, MANIFEST_FILENAME);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadManifest(): MapStyleManifest {
    try {
      if (fs.existsSync(this.manifestPath)) {
        return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
      }
    } catch (error) {
      logger.error('Failed to load map style manifest, returning empty:', error);
    }
    return { styles: [] };
  }

  private saveManifest(manifest: MapStyleManifest): void {
    this.ensureDir();
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  validateStyle(content: string): boolean {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
      if (parsed.version !== 8) return false;
      if (!Array.isArray(parsed.layers) || parsed.layers.length === 0) return false;
      if (typeof parsed.sources !== 'object' || parsed.sources === null) return false;
      return true;
    } catch {
      return false;
    }
  }

  addStyle(name: string, content: string, sourceType: 'upload' | 'url', sourceUrl?: string): MapStyle {
    if (!this.validateStyle(content)) {
      throw new Error('Invalid MapLibre style JSON');
    }
    this.ensureDir();
    const id = randomUUID();
    const filename = `${id}.json`;

    const style: MapStyle = {
      id,
      name,
      filename,
      sourceType,
      sourceUrl: sourceUrl ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    fs.writeFileSync(path.join(this.dataDir, filename), content);
    const manifest = this.loadManifest();
    manifest.styles.push(style);
    this.saveManifest(manifest);
    return style;
  }

  deleteStyle(id: string): void {
    const manifest = this.loadManifest();
    const index = manifest.styles.findIndex(s => s.id === id);
    if (index === -1) throw new Error(`Style not found: ${id}`);
    const style = manifest.styles[index];
    const filePath = path.join(this.dataDir, style.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    manifest.styles.splice(index, 1);
    this.saveManifest(manifest);
  }

  updateStyle(id: string, updates: { name?: string }): MapStyle {
    const manifest = this.loadManifest();
    const style = manifest.styles.find(s => s.id === id);
    if (!style) throw new Error(`Style not found: ${id}`);
    if (updates.name !== undefined) style.name = updates.name;
    style.updatedAt = Date.now();
    this.saveManifest(manifest);
    return style;
  }

  getStyleData(id: string): string {
    const manifest = this.loadManifest();
    const style = manifest.styles.find(s => s.id === id);
    if (!style) throw new Error(`Style not found: ${id}`);
    const filePath = path.join(this.dataDir, style.filename);
    if (!fs.existsSync(filePath)) {
      this.deleteStyle(id);
      throw new Error(`Style file missing, removed from manifest: ${style.filename}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  getStyles(): MapStyle[] {
    return this.loadManifest().styles;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/services/mapStyleService.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/services/mapStyleService.ts src/server/services/mapStyleService.test.ts
git commit -m "feat: add MapStyle service for style manifest and file management"
```

---

### Task 2: MapStyle API Routes

**Files:**
- Create: `src/server/routes/mapStyleRoutes.ts`
- Create: `src/server/routes/mapStyleRoutes.test.ts`
- Modify: `src/server/server.ts` (route registration)

- [ ] **Step 1: Write failing tests for routes**

```typescript
// src/server/routes/mapStyleRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MapStyleService } from '../services/mapStyleService.js';
import { createMapStyleRouter } from './mapStyleRoutes.js';
import databaseService from '../../services/database.js';

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

const VALID_STYLE = JSON.stringify({
  version: 8,
  sources: { tiles: { type: 'vector', url: 'https://example.com/tiles.json' } },
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#000' } }],
});

function createApp(service: MapStyleService) {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = defaultUser.id;
    req.session.username = defaultUser.username;
    next();
  });
  app.use('/', createMapStyleRouter(service));
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstyle-routes-test-'));
    service = new MapStyleService(tmpDir);
    app = createApp(service);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /styles', () => {
    it('returns empty array when no styles exist', async () => {
      const res = await request(app).get('/styles');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns styles after adding one', async () => {
      service.addStyle('Test', VALID_STYLE, 'upload');
      const res = await request(app).get('/styles');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe('POST /upload', () => {
    it('accepts valid style JSON and returns 201', async () => {
      const res = await request(app)
        .post('/upload')
        .set('X-Filename', 'dark.json')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(VALID_STYLE));
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('dark');
      expect(res.body.sourceType).toBe('upload');
    });

    it('rejects invalid style JSON with 400', async () => {
      const res = await request(app)
        .post('/upload')
        .set('X-Filename', 'bad.json')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('{"not": "a style"}'));
      expect(res.status).toBe(400);
    });

    it('rejects missing X-Filename with 400', async () => {
      const res = await request(app)
        .post('/upload')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(VALID_STYLE));
      expect(res.status).toBe(400);
    });
  });

  describe('POST /from-url', () => {
    it('rejects missing url field with 400', async () => {
      const res = await request(app)
        .post('/from-url')
        .set('Content-Type', 'application/json')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /styles/:id', () => {
    it('updates style name', async () => {
      const style = service.addStyle('Original', VALID_STYLE, 'upload');
      const res = await request(app)
        .put(`/styles/${style.id}`)
        .set('Content-Type', 'application/json')
        .send({ name: 'Updated' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('returns 404 for nonexistent', async () => {
      const res = await request(app)
        .put('/styles/nonexistent')
        .set('Content-Type', 'application/json')
        .send({ name: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /styles/:id', () => {
    it('removes style and returns 204', async () => {
      const style = service.addStyle('ToDelete', VALID_STYLE, 'upload');
      const res = await request(app).delete(`/styles/${style.id}`);
      expect(res.status).toBe(204);
    });
  });

  describe('GET /styles/:id/data', () => {
    it('returns raw style JSON', async () => {
      const style = service.addStyle('Data', VALID_STYLE, 'upload');
      const res = await request(app).get(`/styles/${style.id}/data`);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(8);
    });

    it('returns 404 for nonexistent', async () => {
      const res = await request(app).get('/styles/nonexistent/data');
      expect(res.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/routes/mapStyleRoutes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement routes**

```typescript
// src/server/routes/mapStyleRoutes.ts
import { Router, Request, Response } from 'express';
import express from 'express';
import path from 'path';
import { MapStyleService } from '../services/mapStyleService.js';
import { logger } from '../../utils/logger.js';
import { requirePermission } from '../auth/authMiddleware.js';

export function createMapStyleRouter(service: MapStyleService): Router {
  const router = Router();

  // GET /styles — list all styles
  router.get('/styles', (_req: Request, res: Response) => {
    try {
      return res.json(service.getStyles());
    } catch (error) {
      logger.error('[MapStyleRoutes] Error listing styles:', error);
      return res.status(500).json({ error: 'Failed to list styles' });
    }
  });

  // POST /upload — upload a style JSON file
  router.post(
    '/upload',
    requirePermission('settings', 'write'),
    express.raw({ type: '*/*', limit: '10mb' }),
    async (req: Request, res: Response) => {
      try {
        const filename = req.headers['x-filename'] as string | undefined;
        if (!filename) {
          return res.status(400).json({ error: 'Missing X-Filename header' });
        }
        const content = req.body instanceof Buffer ? req.body.toString('utf-8') : String(req.body);
        if (!service.validateStyle(content)) {
          return res.status(400).json({ error: 'Invalid MapLibre style JSON (requires version 8, sources, and layers)' });
        }
        const name = path.basename(filename, path.extname(filename));
        const style = service.addStyle(name, content, 'upload');
        logger.info(`[MapStyleRoutes] Style uploaded: ${style.name}`);
        return res.status(201).json(style);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[MapStyleRoutes] Error uploading style:', error);
        return res.status(400).json({ error: message });
      }
    }
  );

  // POST /from-url — fetch style JSON from a URL
  router.post(
    '/from-url',
    requirePermission('settings', 'write'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const { url, name } = req.body;
        if (!url || typeof url !== 'string') {
          return res.status(400).json({ error: 'Missing or invalid url field' });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let response: globalThis.Response;
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'MeshMonitor/1.0' },
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          return res.status(400).json({ error: `Failed to fetch style: HTTP ${response.status}` });
        }

        const content = await response.text();
        if (!service.validateStyle(content)) {
          return res.status(400).json({ error: 'Fetched content is not valid MapLibre style JSON' });
        }

        const styleName = name || new URL(url).pathname.split('/').pop()?.replace('.json', '') || 'Imported Style';
        const style = service.addStyle(styleName, content, 'url', url);
        logger.info(`[MapStyleRoutes] Style imported from URL: ${style.name} (${url})`);
        return res.status(201).json(style);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[MapStyleRoutes] Error importing style from URL:', error);
        return res.status(400).json({ error: message });
      }
    }
  );

  // PUT /styles/:id — update style metadata
  router.put(
    '/styles/:id',
    requirePermission('settings', 'write'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const updated = service.updateStyle(req.params.id, req.body);
        return res.json(updated);
      } catch (error: any) {
        if (error.message?.includes('not found')) return res.status(404).json({ error: 'Style not found' });
        logger.error('[MapStyleRoutes] Error updating style:', error);
        return res.status(500).json({ error: 'Failed to update style' });
      }
    }
  );

  // DELETE /styles/:id — delete style
  router.delete(
    '/styles/:id',
    requirePermission('settings', 'write'),
    async (req: Request, res: Response) => {
      try {
        service.deleteStyle(req.params.id);
        return res.status(204).send();
      } catch (error: any) {
        if (error.message?.includes('not found')) return res.status(404).json({ error: 'Style not found' });
        logger.error('[MapStyleRoutes] Error deleting style:', error);
        return res.status(500).json({ error: 'Failed to delete style' });
      }
    }
  );

  // GET /styles/:id/data — serve raw style JSON
  router.get('/styles/:id/data', (req: Request, res: Response) => {
    try {
      const data = service.getStyleData(req.params.id);
      res.setHeader('Content-Type', 'application/json');
      return res.send(data);
    } catch (error: any) {
      if (error.message?.includes('not found')) return res.status(404).json({ error: 'Style not found' });
      logger.error('[MapStyleRoutes] Error serving style data:', error);
      return res.status(500).json({ error: 'Failed to serve style data' });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/routes/mapStyleRoutes.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Register routes in server.ts**

In `src/server/server.ts`, add imports near the GeoJSON route imports:

```typescript
import { MapStyleService } from './services/mapStyleService.js';
import { createMapStyleRouter } from './routes/mapStyleRoutes.js';
```

Add route mount after the GeoJSON routes:

```typescript
// MapLibre style routes
const mapStyleDataDir = path.join(process.env.DATA_DIR || '/data', 'styles');
const mapStyleService = new MapStyleService(mapStyleDataDir);
const mapStyleRouter = createMapStyleRouter(mapStyleService);
apiRouter.use('/map-styles', mapStyleRouter);
```

- [ ] **Step 6: Run full test suite and TypeScript check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Clean compile, all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/server/services/mapStyleService.ts src/server/services/mapStyleService.test.ts \
  src/server/routes/mapStyleRoutes.ts src/server/routes/mapStyleRoutes.test.ts src/server/server.ts
git commit -m "feat: add MapStyle API routes with upload, URL fetch, and CRUD"
```

---

### Task 3: VectorTileLayer — Accept Custom Style Prop

**Files:**
- Modify: `src/components/VectorTileLayer.tsx`

- [ ] **Step 1: Add styleJson prop to VectorTileLayer**

In `src/components/VectorTileLayer.tsx`, update the props interface to accept an optional style:

```typescript
interface VectorTileLayerProps {
  url: string;
  attribution?: string;
  maxZoom?: number;
  styleJson?: Record<string, unknown>;  // Custom MapLibre GL style JSON
}
```

- [ ] **Step 2: Use styleJson when provided, fall back to default**

Find where the hardcoded style object is defined (the large object with `version: 8`, `sources`, `layers`). Wrap it so the custom style is used when available:

```typescript
// Before: const style = { version: 8, sources: { ... }, layers: [ ... ] };
// After:
const defaultStyle = { version: 8, sources: { /* existing hardcoded style */ }, layers: [ /* existing layers */ ] };

// If custom style provided, patch its sources to use the active tileset URL
let style: Record<string, unknown>;
if (styleJson) {
  const patched = JSON.parse(JSON.stringify(styleJson));
  // Patch all vector sources to use the current tileset URL
  if (patched.sources && typeof patched.sources === 'object') {
    for (const [key, source] of Object.entries(patched.sources)) {
      if (source && typeof source === 'object' && (source as any).type === 'vector') {
        (source as any).tiles = [url];
        delete (source as any).url; // Remove TileJSON URL in favor of direct tiles
      }
    }
  }
  style = patched;
} else {
  style = defaultStyle;
}
```

- [ ] **Step 3: Handle style changes by recreating the layer**

The MapLibre GL layer needs to be recreated when the style changes. Ensure the `useEffect` that creates the layer includes `styleJson` in its dependency array, and properly cleans up the old layer before creating a new one. The component should already have cleanup logic — verify it removes the old MapLibre layer on re-render.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/components/VectorTileLayer.tsx
git commit -m "feat: VectorTileLayer accepts custom styleJson with source patching"
```

---

### Task 4: MapStyleManager Settings UI

**Files:**
- Create: `src/components/MapStyleManager.tsx`
- Modify: `src/components/SettingsTab.tsx`

- [ ] **Step 1: Create MapStyleManager component**

Create `src/components/MapStyleManager.tsx` following the `GeoJsonLayerManager.tsx` pattern:

- Import `useCsrfFetch` and `api` from existing hooks/services (check how GeoJsonLayerManager imports them)
- State: `styles` array, `uploading` boolean, `urlInput` string, `urlName` string
- `fetchStyles()` — GET `/api/map-styles/styles`
- `handleUpload(file)` — POST `/api/map-styles/upload` with `application/octet-stream` and `X-Filename` header, using `file.arrayBuffer()` for body
- `handleFetchUrl()` — POST `/api/map-styles/from-url` with JSON body `{ url, name }`
- `handleUpdate(id, updates)` — PUT `/api/map-styles/styles/:id`
- `handleDelete(id, name)` — DELETE with confirm dialog
- UI: upload button (`.json` accept), URL input + name field + fetch button, style list with editable name + source badge + delete button

- [ ] **Step 2: Add to SettingsTab.tsx**

Import `MapStyleManager` and add it in the map settings section, after `GeoJsonLayerManager`:

```typescript
import MapStyleManager from './MapStyleManager.js';
```

```tsx
<MapStyleManager />
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add src/components/MapStyleManager.tsx src/components/SettingsTab.tsx
git commit -m "feat: add MapStyle manager UI in Map Settings"
```

---

### Task 5: Map Style Picker Control + NodesTab Integration

**Files:**
- Modify: `src/components/NodesTab.tsx`

- [ ] **Step 1: Add state for map styles**

In NodesTab.tsx, add state and fetch for styles:

```typescript
import type { MapStyle } from '../server/services/mapStyleService.js';

const [mapStyles, setMapStyles] = useState<MapStyle[]>([]);
const [activeStyleId, setActiveStyleId] = useState<string | null>(null);
const [activeStyleJson, setActiveStyleJson] = useState<Record<string, unknown> | null>(null);
```

Add useEffect to fetch styles on mount (same pattern as geoJsonLayers fetch):

```typescript
useEffect(() => {
  api.getBaseUrl().then(baseUrl => {
    fetch(`${baseUrl}/api/map-styles/styles`)
      .then(res => res.ok ? res.json() : [])
      .then(setMapStyles)
      .catch(() => setMapStyles([]));
  });
}, []);
```

- [ ] **Step 2: Add style picker dropdown on map controls**

Near the GeoJSON layer toggles, add a style picker that only shows when a vector tileset is active:

```tsx
{getTilesetById(activeTileset, customTilesets).isVector && mapStyles.length > 0 && (
  <select
    className="map-control-item"
    value={activeStyleId ?? ''}
    onChange={async (e) => {
      const styleId = e.target.value || null;
      setActiveStyleId(styleId);
      if (styleId) {
        try {
          const baseUrl = await api.getBaseUrl();
          const res = await fetch(`${baseUrl}/api/map-styles/styles/${styleId}/data`);
          if (res.ok) setActiveStyleJson(await res.json());
        } catch (err) {
          console.error('Failed to fetch style:', err);
        }
      } else {
        setActiveStyleJson(null);
      }
    }}
  >
    <option value="">Default Style</option>
    {mapStyles.map(s => (
      <option key={s.id} value={s.id}>{s.name}</option>
    ))}
  </select>
)}
```

- [ ] **Step 3: Pass styleJson to VectorTileLayer**

Update the VectorTileLayer rendering to pass the active style:

```tsx
<VectorTileLayer
  url={getTilesetById(activeTileset, customTilesets).url}
  attribution={getTilesetById(activeTileset, customTilesets).attribution}
  maxZoom={getTilesetById(activeTileset, customTilesets).maxZoom}
  styleJson={activeStyleJson ?? undefined}
/>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/components/NodesTab.tsx
git commit -m "feat: add map style picker dropdown and pass custom style to VectorTileLayer"
```

---

### Task 6: Integration Testing & Build Verification

**Files:**
- No new files — verification task

- [ ] **Step 1: Run full unit test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: TypeScript strict compile**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Docker build verification**

Build the Docker image and verify it succeeds.

- [ ] **Step 4: Manual smoke test**

1. Start container
2. Navigate to Map Settings, verify "Map Styles" section appears
3. Upload a MapLibre style JSON file
4. Provide a style URL and fetch
5. Switch to a vector tileset on the map
6. Use the style picker dropdown to switch between Default and custom styles
7. Verify the map re-renders with the new style
8. Delete a style and verify it's removed from the picker

- [ ] **Step 5: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix: address smoke test findings for MapLibre style upload"
```
