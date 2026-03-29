/**
 * GeoJSON Service Tests
 *
 * Tests manifest management, file storage, validation, and layer operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeoJsonService } from './geojsonService.js';

let tmpDir: string;
let service: GeoJsonService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-test-'));
  service = new GeoJsonService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Fixtures ---

const validFeatureCollection = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
      properties: { name: 'Test' },
    },
  ],
});

const validFeature = JSON.stringify({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties: {},
});

const validGeometry = JSON.stringify({
  type: 'Point',
  coordinates: [10, 20],
});

// --- Tests ---

describe('GeoJsonService', () => {
  describe('loadManifest', () => {
    it('returns empty manifest when no file exists', () => {
      const manifest = service.loadManifest();
      expect(manifest).toEqual({ layers: [] });
    });

    it('loads existing manifest from disk', () => {
      const data = { layers: [{ id: 'abc', name: 'Layer A', filename: 'abc.geojson', visible: true, style: { color: '#e74c3c', opacity: 0.7, weight: 2, fillOpacity: 0.3 }, createdAt: 1000, updatedAt: 1000 }] };
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(data));
      const manifest = service.loadManifest();
      expect(manifest.layers).toHaveLength(1);
      expect(manifest.layers[0].name).toBe('Layer A');
    });
  });

  describe('validateGeoJson', () => {
    it('accepts valid FeatureCollection', () => {
      expect(service.validateGeoJson(validFeatureCollection)).toBe(true);
    });

    it('accepts valid Feature', () => {
      expect(service.validateGeoJson(validFeature)).toBe(true);
    });

    it('accepts valid Geometry', () => {
      expect(service.validateGeoJson(validGeometry)).toBe(true);
    });

    it('rejects invalid JSON', () => {
      expect(service.validateGeoJson('not json at all{')).toBe(false);
    });

    it('rejects non-GeoJSON object', () => {
      expect(service.validateGeoJson(JSON.stringify({ foo: 'bar' }))).toBe(false);
    });

    it('rejects unknown GeoJSON type', () => {
      expect(service.validateGeoJson(JSON.stringify({ type: 'SomethingElse' }))).toBe(false);
    });
  });

  describe('addLayer', () => {
    it('stores the GeoJSON file and updates the manifest', () => {
      const layer = service.addLayer('my-overlay.geojson', validFeatureCollection);

      expect(layer.name).toBe('my-overlay');
      expect(layer.id).toBeTruthy();
      expect(layer.filename).toBe(`${layer.id}.geojson`);
      expect(layer.visible).toBe(true);
      expect(layer.style.opacity).toBe(0.7);

      // File should exist
      const filePath = path.join(tmpDir, layer.filename);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(validFeatureCollection);

      // Manifest should be updated
      const manifest = service.loadManifest();
      expect(manifest.layers).toHaveLength(1);
      expect(manifest.layers[0].id).toBe(layer.id);
    });

    it('strips extension from original filename for layer name', () => {
      const layer = service.addLayer('roads.json', validFeatureCollection);
      expect(layer.name).toBe('roads');
    });

    it('throws if content is not valid GeoJSON', () => {
      expect(() => service.addLayer('bad.geojson', 'not valid')).toThrow();
    });

    it('cycles through default color palette', () => {
      const colors = new Set<string>();
      for (let i = 0; i < 9; i++) {
        const layer = service.addLayer(`layer${i}.geojson`, validFeatureCollection);
        colors.add(layer.style.color);
      }
      // At least 8 distinct colors used across 9 layers (palette wraps)
      expect(colors.size).toBeGreaterThanOrEqual(8);
    });
  });

  describe('deleteLayer', () => {
    it('removes the file and manifest entry', () => {
      const layer = service.addLayer('delete-me.geojson', validFeatureCollection);
      const filePath = path.join(tmpDir, layer.filename);
      expect(fs.existsSync(filePath)).toBe(true);

      service.deleteLayer(layer.id);

      expect(fs.existsSync(filePath)).toBe(false);
      expect(service.loadManifest().layers).toHaveLength(0);
    });

    it('throws when layer id does not exist', () => {
      expect(() => service.deleteLayer('nonexistent-id')).toThrow();
    });
  });

  describe('updateLayer', () => {
    it('updates name and style', () => {
      const layer = service.addLayer('original.geojson', validFeatureCollection);
      const updated = service.updateLayer(layer.id, { name: 'Renamed', style: { color: '#ff0000', opacity: 0.5, weight: 3, fillOpacity: 0.1 } });

      expect(updated.name).toBe('Renamed');
      expect(updated.style.color).toBe('#ff0000');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(layer.updatedAt);

      // Persisted
      const manifest = service.loadManifest();
      expect(manifest.layers[0].name).toBe('Renamed');
    });

    it('updates visible flag', () => {
      const layer = service.addLayer('vis.geojson', validFeatureCollection);
      const updated = service.updateLayer(layer.id, { visible: false });
      expect(updated.visible).toBe(false);
    });

    it('throws when layer id does not exist', () => {
      expect(() => service.updateLayer('no-such-id', { name: 'X' })).toThrow();
    });
  });

  describe('discoverLayers', () => {
    it('finds untracked .geojson files and adds them to the manifest', () => {
      fs.writeFileSync(path.join(tmpDir, 'untracked.geojson'), validFeatureCollection);

      const discovered = service.discoverLayers();
      expect(discovered.length).toBeGreaterThanOrEqual(1);
      const names = discovered.map(l => l.name);
      expect(names).toContain('untracked');

      // Should now be in manifest
      const manifest = service.loadManifest();
      expect(manifest.layers.some(l => l.name === 'untracked')).toBe(true);
    });

    it('finds untracked .json files', () => {
      fs.writeFileSync(path.join(tmpDir, 'shapes.json'), validFeatureCollection);
      const discovered = service.discoverLayers();
      expect(discovered.map(l => l.name)).toContain('shapes');
    });

    it('does not duplicate already-tracked files', () => {
      const layer = service.addLayer('tracked.geojson', validFeatureCollection);
      service.discoverLayers();
      const manifest = service.loadManifest();
      expect(manifest.layers.filter(l => l.id === layer.id)).toHaveLength(1);
    });
  });

  describe('getLayerData', () => {
    it('returns raw file content for existing layer', () => {
      const layer = service.addLayer('data.geojson', validFeatureCollection);
      const content = service.getLayerData(layer.id);
      expect(content).toBe(validFeatureCollection);
    });

    it('throws when layer id does not exist', () => {
      expect(() => service.getLayerData('missing')).toThrow();
    });

    it('auto-removes orphaned layer when file is missing', () => {
      const layer = service.addLayer('orphan.geojson', validFeatureCollection);
      // Delete the backing file but leave manifest entry
      fs.unlinkSync(path.join(tmpDir, layer.filename));
      expect(() => service.getLayerData(layer.id)).toThrow(/removed from manifest/);
      // Manifest should no longer contain the layer
      const manifest = service.loadManifest();
      expect(manifest.layers.find(l => l.id === layer.id)).toBeUndefined();
    });
  });

  describe('getLayers', () => {
    it('returns all layers including discovered ones', () => {
      service.addLayer('tracked.geojson', validFeatureCollection);
      fs.writeFileSync(path.join(tmpDir, 'untracked.geojson'), validFeatureCollection);

      const layers = service.getLayers();
      expect(layers.length).toBeGreaterThanOrEqual(2);
    });
  });
});
