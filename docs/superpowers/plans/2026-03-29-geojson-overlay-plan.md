# GeoJSON Overlay Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to upload GeoJSON files and display them as toggleable overlay layers on the map, with simplestyle-spec support and per-layer style overrides.

**Architecture:** A new `geojsonService` manages files and a manifest in `/data/geojson/`. Routes expose CRUD + upload endpoints. A `GeoJsonOverlay` component renders layers on the map. Layer toggles sit alongside the existing polar grid checkbox.

**Tech Stack:** Express routes, `express.raw()` for upload, react-leaflet `<GeoJSON>`, existing settings UI patterns.

**Spec:** `docs/superpowers/specs/2026-03-29-geojson-overlay-design.md`

---

### Task 1: GeoJSON Service — Manifest & File Management

**Files:**
- Create: `src/server/services/geojsonService.ts`
- Create: `src/server/services/geojsonService.test.ts`

- [ ] **Step 1: Write failing tests for manifest operations**

```typescript
// src/server/services/geojsonService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GeoJsonService } from './geojsonService.js';

describe('GeoJsonService', () => {
  let service: GeoJsonService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-test-'));
    service = new GeoJsonService(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadManifest', () => {
    it('should return empty layers when no manifest exists', () => {
      const manifest = service.loadManifest();
      expect(manifest.layers).toEqual([]);
    });

    it('should load existing manifest', () => {
      const manifest = { layers: [{ id: 'test', name: 'Test', filename: 'test.geojson', visible: true, style: { color: '#ff0000', opacity: 0.7, weight: 2, fillOpacity: 0.3 }, createdAt: Date.now(), updatedAt: Date.now() }] };
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
      const loaded = service.loadManifest();
      expect(loaded.layers).toHaveLength(1);
      expect(loaded.layers[0].name).toBe('Test');
    });
  });

  describe('validateGeoJson', () => {
    it('should accept a valid FeatureCollection', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] });
      expect(service.validateGeoJson(geojson)).toBe(true);
    });

    it('should accept a valid Feature', () => {
      const geojson = JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} });
      expect(service.validateGeoJson(geojson)).toBe(true);
    });

    it('should reject invalid JSON', () => {
      expect(service.validateGeoJson('not json')).toBe(false);
    });

    it('should reject non-GeoJSON objects', () => {
      expect(service.validateGeoJson(JSON.stringify({ name: 'not geojson' }))).toBe(false);
    });
  });

  describe('addLayer', () => {
    it('should store file and add to manifest', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      const layer = service.addLayer('test-points.geojson', geojson);
      expect(layer.name).toBe('test-points');
      expect(layer.filename).toMatch(/\.geojson$/);
      expect(layer.visible).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, layer.filename))).toBe(true);
    });
  });

  describe('deleteLayer', () => {
    it('should remove file and manifest entry', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      const layer = service.addLayer('test.geojson', geojson);
      service.deleteLayer(layer.id);
      const manifest = service.loadManifest();
      expect(manifest.layers).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, layer.filename))).toBe(false);
    });

    it('should throw for non-existent layer', () => {
      expect(() => service.deleteLayer('nonexistent')).toThrow();
    });
  });

  describe('updateLayer', () => {
    it('should update name and style', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      const layer = service.addLayer('test.geojson', geojson);
      const updated = service.updateLayer(layer.id, { name: 'Renamed', style: { color: '#00ff00', opacity: 0.5, weight: 3, fillOpacity: 0.2 } });
      expect(updated.name).toBe('Renamed');
      expect(updated.style.color).toBe('#00ff00');
    });
  });

  describe('discoverLayers', () => {
    it('should find untracked geojson files', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      fs.writeFileSync(path.join(tmpDir, 'discovered.geojson'), geojson);
      const layers = service.discoverLayers();
      expect(layers).toHaveLength(1);
      expect(layers[0].name).toBe('discovered');
    });

    it('should not duplicate already tracked files', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      service.addLayer('existing.geojson', geojson);
      service.discoverLayers();
      const manifest = service.loadManifest();
      expect(manifest.layers).toHaveLength(1);
    });
  });

  describe('getLayerData', () => {
    it('should return raw GeoJSON content', () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'test' } }] });
      const layer = service.addLayer('data.geojson', geojson);
      const data = service.getLayerData(layer.id);
      expect(JSON.parse(data).features[0].properties.name).toBe('test');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/services/geojsonService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GeoJsonService**

```typescript
// src/server/services/geojsonService.ts
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

export interface LayerStyle {
  color: string;
  opacity: number;
  weight: number;
  fillOpacity: number;
}

export interface GeoJsonLayer {
  id: string;
  name: string;
  filename: string;
  visible: boolean;
  style: LayerStyle;
  createdAt: number;
  updatedAt: number;
}

export interface GeoJsonManifest {
  layers: GeoJsonLayer[];
}

const DEFAULT_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];

export class GeoJsonService {
  private dataDir: string;
  private manifestPath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.manifestPath = path.join(dataDir, 'manifest.json');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  loadManifest(): GeoJsonManifest {
    try {
      if (fs.existsSync(this.manifestPath)) {
        const data = fs.readFileSync(this.manifestPath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to load GeoJSON manifest, rebuilding:', error);
    }
    return { layers: [] };
  }

  private saveManifest(manifest: GeoJsonManifest): void {
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  validateGeoJson(content: string): boolean {
    try {
      const parsed = JSON.parse(content);
      const validTypes = ['FeatureCollection', 'Feature', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'];
      return typeof parsed === 'object' && parsed !== null && validTypes.includes(parsed.type);
    } catch {
      return false;
    }
  }

  addLayer(originalFilename: string, content: string): GeoJsonLayer {
    const manifest = this.loadManifest();
    const id = randomUUID();
    const ext = '.geojson';
    const storedFilename = `${id}${ext}`;
    const name = path.basename(originalFilename, path.extname(originalFilename));
    const colorIndex = manifest.layers.length % DEFAULT_COLORS.length;

    const layer: GeoJsonLayer = {
      id,
      name,
      filename: storedFilename,
      visible: true,
      style: {
        color: DEFAULT_COLORS[colorIndex],
        opacity: 0.7,
        weight: 2,
        fillOpacity: 0.3,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    fs.writeFileSync(path.join(this.dataDir, storedFilename), content);
    manifest.layers.push(layer);
    this.saveManifest(manifest);
    return layer;
  }

  deleteLayer(id: string): void {
    const manifest = this.loadManifest();
    const index = manifest.layers.findIndex(l => l.id === id);
    if (index === -1) {
      throw new Error(`Layer ${id} not found`);
    }
    const layer = manifest.layers[index];
    const filePath = path.join(this.dataDir, layer.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    manifest.layers.splice(index, 1);
    this.saveManifest(manifest);
  }

  updateLayer(id: string, updates: Partial<Pick<GeoJsonLayer, 'name' | 'visible' | 'style'>>): GeoJsonLayer {
    const manifest = this.loadManifest();
    const layer = manifest.layers.find(l => l.id === id);
    if (!layer) {
      throw new Error(`Layer ${id} not found`);
    }
    if (updates.name !== undefined) layer.name = updates.name;
    if (updates.visible !== undefined) layer.visible = updates.visible;
    if (updates.style !== undefined) layer.style = { ...layer.style, ...updates.style };
    layer.updatedAt = Date.now();
    this.saveManifest(manifest);
    return layer;
  }

  discoverLayers(): GeoJsonLayer[] {
    const manifest = this.loadManifest();
    const trackedFiles = new Set(manifest.layers.map(l => l.filename));
    const discovered: GeoJsonLayer[] = [];

    const files = fs.readdirSync(this.dataDir).filter(f =>
      (f.endsWith('.geojson') || f.endsWith('.json')) && f !== 'manifest.json' && !trackedFiles.has(f)
    );

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.dataDir, file), 'utf-8');
        if (this.validateGeoJson(content)) {
          const name = path.basename(file, path.extname(file));
          const colorIndex = (manifest.layers.length + discovered.length) % DEFAULT_COLORS.length;
          const layer: GeoJsonLayer = {
            id: randomUUID(),
            name,
            filename: file,
            visible: true,
            style: { color: DEFAULT_COLORS[colorIndex], opacity: 0.7, weight: 2, fillOpacity: 0.3 },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          discovered.push(layer);
          manifest.layers.push(layer);
        }
      } catch {
        logger.warn(`Skipping invalid GeoJSON file: ${file}`);
      }
    }

    if (discovered.length > 0) {
      this.saveManifest(manifest);
    }
    return discovered;
  }

  getLayerData(id: string): string {
    const manifest = this.loadManifest();
    const layer = manifest.layers.find(l => l.id === id);
    if (!layer) {
      throw new Error(`Layer ${id} not found`);
    }
    const filePath = path.join(this.dataDir, layer.filename);
    if (!fs.existsSync(filePath)) {
      this.deleteLayer(id);
      throw new Error(`Layer file missing: ${layer.filename}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  getLayers(): GeoJsonLayer[] {
    this.discoverLayers();
    return this.loadManifest().layers;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/services/geojsonService.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/services/geojsonService.ts src/server/services/geojsonService.test.ts
git commit -m "feat: add GeoJSON service for manifest and file management (#2487)"
```

---

### Task 2: GeoJSON API Routes

**Files:**
- Create: `src/server/routes/geojsonRoutes.ts`
- Create: `src/server/routes/geojsonRoutes.test.ts`
- Modify: `src/server/server.ts` (route registration, ~line 842)

- [ ] **Step 1: Write failing tests for routes**

```typescript
// src/server/routes/geojsonRoutes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGeoJsonRouter } from './geojsonRoutes.js';
import { GeoJsonService } from '../services/geojsonService.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('GeoJSON Routes', () => {
  let app: express.Application;
  let service: GeoJsonService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-routes-test-'));
    service = new GeoJsonService(tmpDir);

    app = express();
    app.use(express.json());
    // Skip auth middleware for tests
    app.use('/api/geojson', createGeoJsonRouter(service));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/geojson/layers', () => {
    it('should return empty array when no layers', async () => {
      const res = await request(app).get('/api/geojson/layers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return layers after upload', async () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      service.addLayer('test.geojson', geojson);
      const res = await request(app).get('/api/geojson/layers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('test');
    });
  });

  describe('POST /api/geojson/upload', () => {
    it('should accept valid GeoJSON', async () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] });
      const res = await request(app)
        .post('/api/geojson/upload')
        .set('Content-Type', 'application/octet-stream')
        .set('X-Filename', 'points.geojson')
        .send(Buffer.from(geojson));
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('points');
    });

    it('should reject invalid GeoJSON', async () => {
      const res = await request(app)
        .post('/api/geojson/upload')
        .set('Content-Type', 'application/octet-stream')
        .set('X-Filename', 'bad.geojson')
        .send(Buffer.from('not json'));
      expect(res.status).toBe(400);
    });

    it('should reject missing filename', async () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      const res = await request(app)
        .post('/api/geojson/upload')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(geojson));
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/geojson/layers/:id', () => {
    it('should update layer metadata', async () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      const layer = service.addLayer('test.geojson', geojson);
      const res = await request(app)
        .put(`/api/geojson/layers/${layer.id}`)
        .send({ name: 'Updated', style: { color: '#00ff00' } });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('should return 404 for non-existent layer', async () => {
      const res = await request(app)
        .put('/api/geojson/layers/nonexistent')
        .send({ name: 'test' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/geojson/layers/:id', () => {
    it('should delete layer', async () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
      const layer = service.addLayer('test.geojson', geojson);
      const res = await request(app).delete(`/api/geojson/layers/${layer.id}`);
      expect(res.status).toBe(204);
    });
  });

  describe('GET /api/geojson/layers/:id/data', () => {
    it('should return raw GeoJSON', async () => {
      const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} }] });
      const layer = service.addLayer('data.geojson', geojson);
      const res = await request(app).get(`/api/geojson/layers/${layer.id}/data`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/geo\+json|json/);
      expect(res.body.features[0].geometry.coordinates).toEqual([1, 2]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/routes/geojsonRoutes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement routes**

```typescript
// src/server/routes/geojsonRoutes.ts
import express from 'express';
import path from 'path';
import { logger } from '../../utils/logger.js';
import type { GeoJsonService } from '../services/geojsonService.js';

export function createGeoJsonRouter(service: GeoJsonService): express.Router {
  const router = express.Router();

  // GET /layers — list all layers (triggers auto-discovery)
  router.get('/layers', (_req, res) => {
    try {
      const layers = service.getLayers();
      res.json(layers);
    } catch (error) {
      logger.error('Error listing GeoJSON layers:', error);
      res.status(500).json({ error: 'Failed to list layers' });
    }
  });

  // POST /upload — upload a new GeoJSON file
  router.post('/upload', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    try {
      const filename = req.headers['x-filename'] as string;
      if (!filename) {
        res.status(400).json({ error: 'Missing X-Filename header' });
        return;
      }
      const sanitizedFilename = path.basename(filename);
      const content = req.body.toString('utf-8');

      if (!service.validateGeoJson(content)) {
        res.status(400).json({ error: 'Invalid GeoJSON file' });
        return;
      }

      const layer = service.addLayer(sanitizedFilename, content);
      logger.info(`GeoJSON layer uploaded: ${layer.name} (${sanitizedFilename})`);
      res.status(201).json(layer);
    } catch (error) {
      logger.error('Error uploading GeoJSON:', error);
      res.status(500).json({ error: 'Failed to upload layer' });
    }
  });

  // PUT /layers/:id — update layer metadata
  router.put('/layers/:id', express.json(), (req, res) => {
    try {
      const updated = service.updateLayer(req.params.id, req.body);
      res.json(updated);
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ error: 'Layer not found' });
      } else {
        logger.error('Error updating GeoJSON layer:', error);
        res.status(500).json({ error: 'Failed to update layer' });
      }
    }
  });

  // DELETE /layers/:id — delete layer and file
  router.delete('/layers/:id', (req, res) => {
    try {
      service.deleteLayer(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ error: 'Layer not found' });
      } else {
        logger.error('Error deleting GeoJSON layer:', error);
        res.status(500).json({ error: 'Failed to delete layer' });
      }
    }
  });

  // GET /layers/:id/data — serve raw GeoJSON
  router.get('/layers/:id/data', (req, res) => {
    try {
      const data = service.getLayerData(req.params.id);
      res.setHeader('Content-Type', 'application/geo+json');
      res.send(data);
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ error: 'Layer not found' });
      } else {
        logger.error('Error serving GeoJSON data:', error);
        res.status(500).json({ error: 'Failed to serve layer data' });
      }
    }
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/routes/geojsonRoutes.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Register routes in server.ts**

In `src/server/server.ts`, add the import near the other route imports (~line 739):

```typescript
import { createGeoJsonRouter } from './routes/geojsonRoutes.js';
import { GeoJsonService } from './services/geojsonService.js';
```

Add the route mount after the firmware routes (~line 842). Wrap with auth and permission middleware matching the existing pattern:

```typescript
// GeoJSON overlay routes
const geojsonDataDir = path.join(process.env.DATA_DIR || './data', 'geojson');
const geojsonService = new GeoJsonService(geojsonDataDir);
apiRouter.use('/geojson', geojsonRoutes);
```

Where `geojsonRoutes` is created via:
```typescript
const geojsonRoutes = createGeoJsonRouter(geojsonService);
```

Note: Auth middleware is already applied globally to the apiRouter. Add `requirePermission` in the route file for write operations, matching the existing pattern from settingsRoutes.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/geojsonRoutes.ts src/server/routes/geojsonRoutes.test.ts src/server/server.ts
git commit -m "feat: add GeoJSON API routes for upload, CRUD, and data serving (#2487)"
```

---

### Task 3: GeoJSON Overlay Map Component

**Files:**
- Create: `src/components/GeoJsonOverlay.tsx`
- Modify: `src/components/NodesTab.tsx` (~line 2103, after PolarGridOverlay)

- [ ] **Step 1: Create the GeoJsonOverlay component**

```tsx
// src/components/GeoJsonOverlay.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';

interface GeoJsonOverlayProps {
  layers: GeoJsonLayer[];
}

// Simplestyle-spec property mapping
function getFeatureStyle(feature: any, layerStyle: GeoJsonLayer['style']): L.PathOptions {
  const props = feature?.properties || {};
  return {
    color: props['stroke'] || layerStyle.color,
    weight: props['stroke-width'] || layerStyle.weight,
    opacity: props['stroke-opacity'] || layerStyle.opacity,
    fillColor: props['fill'] || layerStyle.color,
    fillOpacity: props['fill-opacity'] || layerStyle.fillOpacity,
  };
}

function pointToLayer(feature: any, latlng: L.LatLng, layerStyle: GeoJsonLayer['style']): L.Layer {
  const props = feature?.properties || {};
  const color = props['marker-color'] || layerStyle.color;
  const size = props['marker-size'] === 'large' ? 10 : props['marker-size'] === 'small' ? 4 : 7;
  return L.circleMarker(latlng, {
    radius: size,
    fillColor: color,
    color: '#fff',
    weight: 2,
    opacity: layerStyle.opacity,
    fillOpacity: 0.8,
  });
}

function onEachFeature(feature: any, layer: L.Layer): void {
  const props = feature?.properties || {};
  const title = props.title || props.name || props.Name || props.TITLE || props.NAME;
  const description = props.description || props.Description || props.DESCRIPTION;
  if (title || description) {
    const popup = [title && `<strong>${title}</strong>`, description].filter(Boolean).join('<br/>');
    layer.bindPopup(popup);
  }
  if (title) {
    layer.bindTooltip(title, { permanent: false, direction: 'top' });
  }
}

const GeoJsonLayerComponent: React.FC<{ layer: GeoJsonLayer }> = ({ layer }) => {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/geojson/layers/${layer.id}/data`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch');
        return res.json();
      })
      .then(setData)
      .catch(err => console.error(`Failed to load GeoJSON layer ${layer.name}:`, err));
  }, [layer.id, layer.name]);

  const style = useCallback((feature: any) => getFeatureStyle(feature, layer.style), [layer.style]);
  const ptl = useCallback((feature: any, latlng: L.LatLng) => pointToLayer(feature, latlng, layer.style), [layer.style]);

  if (!data) return null;

  return (
    <GeoJSON
      key={`${layer.id}-${layer.updatedAt}`}
      data={data}
      style={style}
      pointToLayer={ptl}
      onEachFeature={onEachFeature}
    />
  );
};

const GeoJsonOverlay: React.FC<GeoJsonOverlayProps> = ({ layers }) => {
  return (
    <>
      {layers.filter(l => l.visible).map(layer => (
        <GeoJsonLayerComponent key={layer.id} layer={layer} />
      ))}
    </>
  );
};

export default GeoJsonOverlay;
```

- [ ] **Step 2: Add GeoJSON overlay to NodesTab.tsx**

In `src/components/NodesTab.tsx`, add the import at the top with other component imports:

```typescript
import GeoJsonOverlay from './GeoJsonOverlay.js';
```

Add state for GeoJSON layers near the other state declarations (~line 260):

```typescript
const [geoJsonLayers, setGeoJsonLayers] = useState<any[]>([]);
```

Add a useEffect to fetch layers on mount:

```typescript
useEffect(() => {
  fetch('/api/geojson/layers')
    .then(res => res.ok ? res.json() : [])
    .then(setGeoJsonLayers)
    .catch(() => setGeoJsonLayers([]));
}, []);
```

Insert the component inside MapContainer after PolarGridOverlay (~line 2103):

```tsx
{geoJsonLayers.length > 0 && (
  <GeoJsonOverlay layers={geoJsonLayers} />
)}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add src/components/GeoJsonOverlay.tsx src/components/NodesTab.tsx
git commit -m "feat: add GeoJSON overlay map component with simplestyle-spec support (#2487)"
```

---

### Task 4: Map Layer Toggle Controls

**Files:**
- Modify: `src/components/NodesTab.tsx` (~line 1756, near polar grid toggle)

- [ ] **Step 1: Add layer toggle UI alongside polar grid toggle**

In `src/components/NodesTab.tsx`, find the polar grid toggle area (~line 1756). After the polar grid label, add toggles for each GeoJSON layer:

```tsx
{geoJsonLayers.map(layer => (
  <label key={layer.id} className="map-control-item">
    <input
      type="checkbox"
      checked={layer.visible}
      onChange={(e) => {
        const newLayers = geoJsonLayers.map(l =>
          l.id === layer.id ? { ...l, visible: e.target.checked } : l
        );
        setGeoJsonLayers(newLayers);
        // Persist visibility to backend
        fetch(`/api/geojson/layers/${layer.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visible: e.target.checked }),
        }).catch(err => console.error('Failed to update layer visibility:', err));
      }}
    />
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: layer.style.color,
      }} />
      {layer.name}
    </span>
  </label>
))}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/components/NodesTab.tsx
git commit -m "feat: add GeoJSON layer toggle controls on map (#2487)"
```

---

### Task 5: Map Settings GeoJSON Management UI

**Files:**
- Create: `src/components/GeoJsonLayerManager.tsx`
- Modify: `src/components/SettingsTab.tsx` (~line 1195, in map settings section)

- [ ] **Step 1: Create the GeoJsonLayerManager component**

```tsx
// src/components/GeoJsonLayerManager.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { GeoJsonLayer, LayerStyle } from '../server/services/geojsonService.js';

const GeoJsonLayerManager: React.FC = () => {
  const { t } = useTranslation();
  const [layers, setLayers] = useState<GeoJsonLayer[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchLayers = useCallback(() => {
    fetch('/api/geojson/layers')
      .then(res => res.ok ? res.json() : [])
      .then(setLayers)
      .catch(() => setLayers([]));
  }, []);

  useEffect(() => { fetchLayers(); }, [fetchLayers]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch('/api/geojson/upload', {
        method: 'POST',
        headers: { 'X-Filename': file.name },
        body: buffer,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Upload failed');
      }
      fetchLayers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleUpdate = async (id: string, updates: Partial<Pick<GeoJsonLayer, 'name' | 'visible' | 'style'>>) => {
    try {
      const res = await fetch(`/api/geojson/layers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) fetchLayers();
    } catch (err) {
      console.error('Failed to update layer:', err);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete layer "${name}"?`)) return;
    try {
      await fetch(`/api/geojson/layers/${id}`, { method: 'DELETE' });
      fetchLayers();
    } catch (err) {
      console.error('Failed to delete layer:', err);
    }
  };

  return (
    <div className="setting-item">
      <label>
        GeoJSON Overlays
        <span className="setting-description">
          Upload .geojson files to display as map overlays. Files placed in /data/geojson/ are auto-discovered.
        </span>
      </label>

      <div style={{ marginTop: '8px' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".geojson,.json"
          onChange={handleUpload}
          style={{ display: 'none' }}
        />
        <button
          className="settings-button settings-button-primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading...' : 'Upload GeoJSON'}
        </button>
        {error && <span style={{ color: 'var(--ctp-red)', marginLeft: '8px', fontSize: '0.85rem' }}>{error}</span>}
      </div>

      {layers.length === 0 && (
        <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '8px' }}>
          No GeoJSON layers. Upload a file or place .geojson files in /data/geojson/
        </p>
      )}

      {layers.map(layer => (
        <div key={layer.id} style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px',
          marginTop: '8px', background: 'var(--ctp-surface0)', borderRadius: '6px',
          flexWrap: 'wrap',
        }}>
          <input
            type="checkbox"
            checked={layer.visible}
            onChange={(e) => handleUpdate(layer.id, { visible: e.target.checked })}
            title="Toggle visibility"
          />
          <input
            type="color"
            value={layer.style.color}
            onChange={(e) => handleUpdate(layer.id, { style: { ...layer.style, color: e.target.value } })}
            style={{ width: '30px', height: '24px', border: 'none', cursor: 'pointer' }}
            title="Layer color"
          />
          <input
            type="text"
            value={layer.name}
            onChange={(e) => handleUpdate(layer.id, { name: e.target.value })}
            style={{ flex: 1, minWidth: '120px', padding: '4px 8px', background: 'var(--ctp-base)', color: 'var(--ctp-text)', border: '1px solid var(--ctp-surface2)', borderRadius: '4px' }}
          />
          <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Opacity
            <input
              type="range"
              min="0" max="1" step="0.1"
              value={layer.style.opacity}
              onChange={(e) => handleUpdate(layer.id, { style: { ...layer.style, opacity: parseFloat(e.target.value) } })}
              style={{ width: '60px' }}
            />
          </label>
          <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Weight
            <input
              type="number"
              min="1" max="10"
              value={layer.style.weight}
              onChange={(e) => handleUpdate(layer.id, { style: { ...layer.style, weight: parseInt(e.target.value) || 2 } })}
              style={{ width: '50px', padding: '2px 4px', background: 'var(--ctp-base)', color: 'var(--ctp-text)', border: '1px solid var(--ctp-surface2)', borderRadius: '4px' }}
            />
          </label>
          <button
            onClick={() => handleDelete(layer.id, layer.name)}
            className="settings-button"
            style={{ color: 'var(--ctp-red)', padding: '4px 8px' }}
            title="Delete layer"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};

export default GeoJsonLayerManager;
```

- [ ] **Step 2: Add to SettingsTab.tsx**

In `src/components/SettingsTab.tsx`, add the import:

```typescript
import GeoJsonLayerManager from './GeoJsonLayerManager.js';
```

Insert after the neighborInfoMinZoom setting (~line 1195) and before the admin-only sections:

```tsx
<GeoJsonLayerManager />
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add src/components/GeoJsonLayerManager.tsx src/components/SettingsTab.tsx
git commit -m "feat: add GeoJSON layer management UI in Map Settings (#2487)"
```

---

### Task 6: CSRF and Permission Integration

**Files:**
- Modify: `src/components/GeoJsonLayerManager.tsx` (add CSRF headers)
- Modify: `src/components/NodesTab.tsx` (add CSRF headers to visibility toggle)
- Modify: `src/server/routes/geojsonRoutes.ts` (add permission middleware)

- [ ] **Step 1: Add requirePermission to write routes**

In `src/server/routes/geojsonRoutes.ts`, import the permission middleware. Check how other routes import it (e.g., from settingsRoutes.ts) and apply `requirePermission('settings', 'write')` to POST upload, PUT update, and DELETE endpoints. Read-only endpoints (GET layers, GET data) need `requirePermission('settings', 'read')`.

- [ ] **Step 2: Add CSRF token to frontend fetch calls**

In `GeoJsonLayerManager.tsx`, get the CSRF token from the existing pattern used elsewhere in the app. Add `X-CSRF-Token` header to all POST/PUT/DELETE fetch calls. Check how other components handle this (e.g., SettingsTab.tsx) and follow the same pattern.

In `NodesTab.tsx`, add the CSRF header to the visibility toggle PUT call.

- [ ] **Step 3: Add BASE_URL handling to fetch calls**

Check if the app uses a BASE_URL prefix for API calls. If so (the CLAUDE.md says BASE_URL is `/meshmonitor`), ensure all `/api/geojson/...` fetch calls use the correct prefix. Follow the pattern used by other API calls in the same components.

- [ ] **Step 4: Verify TypeScript compiles and run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Clean compile, all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/components/GeoJsonLayerManager.tsx src/components/NodesTab.tsx src/server/routes/geojsonRoutes.ts
git commit -m "feat: add CSRF, permissions, and BASE_URL support to GeoJSON routes (#2487)"
```

---

### Task 7: Integration Testing and Build Verification

**Files:**
- No new files — verification task

- [ ] **Step 1: Run full unit test suite**

Run: `npx vitest run`
Expected: All tests PASS (including new geojsonService and geojsonRoutes tests)

- [ ] **Step 2: TypeScript strict compile**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Docker build verification**

Run: `COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build meshmonitor-sqlite`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

1. Start container: `COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d meshmonitor-sqlite`
2. Navigate to Map Settings, verify "GeoJSON Overlays" section appears
3. Upload a test GeoJSON file (create a simple one with a few points)
4. Verify layer appears in the layer list with style controls
5. Navigate to the map, verify the overlay renders
6. Toggle visibility via the map control checkbox
7. Change layer color in settings, verify map updates

- [ ] **Step 5: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix: address smoke test findings for GeoJSON overlay (#2487)"
```
