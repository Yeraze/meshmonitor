/**
 * GeoJSON Service
 *
 * Manages GeoJSON overlay layers stored on disk.
 * Handles manifest CRUD, file storage, validation, and auto-discovery.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GEOJSON_DIR = '/data/geojson';
const MANIFEST_FILENAME = 'manifest.json';

const DEFAULT_COLOR_PALETTE = [
  '#e74c3c',
  '#3498db',
  '#2ecc71',
  '#f39c12',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
  '#34495e',
];

const VALID_GEOJSON_TYPES = new Set([
  'FeatureCollection',
  'Feature',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GeoJsonService {
  private readonly dataDir: string;
  private readonly manifestPath: string;

  constructor(dataDir: string = DEFAULT_GEOJSON_DIR) {
    this.dataDir = dataDir;
    this.manifestPath = path.join(dataDir, MANIFEST_FILENAME);
  }

  // ---- Directory management ------------------------------------------------

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // ---- Manifest ------------------------------------------------------------

  loadManifest(): GeoJsonManifest {
    try {
      if (!fs.existsSync(this.manifestPath)) {
        return { layers: [] };
      }
      const raw = fs.readFileSync(this.manifestPath, 'utf-8');
      return JSON.parse(raw) as GeoJsonManifest;
    } catch (err) {
      logger.warn('GeoJsonService: failed to load manifest, returning empty', err);
      return { layers: [] };
    }
  }

  private saveManifest(manifest: GeoJsonManifest): void {
    this.ensureDir();
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  // ---- Validation ----------------------------------------------------------

  validateGeoJson(content: string): boolean {
    try {
      const obj = JSON.parse(content);
      if (typeof obj !== 'object' || obj === null) return false;
      return VALID_GEOJSON_TYPES.has(obj.type);
    } catch {
      return false;
    }
  }

  // ---- Layer operations ----------------------------------------------------

  addLayer(originalFilename: string, content: string): GeoJsonLayer {
    if (!this.validateGeoJson(content)) {
      throw new Error(`Invalid GeoJSON content for file: ${originalFilename}`);
    }

    this.ensureDir();

    const manifest = this.loadManifest();
    const id = randomUUID();
    const filename = `${id}.geojson`;
    const name = path.basename(originalFilename, path.extname(originalFilename));
    const now = Date.now();

    // Pick color from palette based on current layer count
    const colorIndex = manifest.layers.length % DEFAULT_COLOR_PALETTE.length;
    const color = DEFAULT_COLOR_PALETTE[colorIndex];

    const layer: GeoJsonLayer = {
      id,
      name,
      filename,
      visible: true,
      style: {
        color,
        opacity: 0.7,
        weight: 2,
        fillOpacity: 0.3,
      },
      createdAt: now,
      updatedAt: now,
    };

    // Write GeoJSON file
    fs.writeFileSync(path.join(this.dataDir, filename), content, 'utf-8');

    // Update manifest
    manifest.layers.push(layer);
    this.saveManifest(manifest);

    logger.info(`GeoJsonService: added layer "${name}" (${id})`);
    return layer;
  }

  deleteLayer(id: string): void {
    const manifest = this.loadManifest();
    const index = manifest.layers.findIndex(l => l.id === id);

    if (index === -1) {
      throw new Error(`GeoJSON layer not found: ${id}`);
    }

    const layer = manifest.layers[index];
    const filePath = path.join(this.dataDir, layer.filename);

    // Remove file if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from manifest
    manifest.layers.splice(index, 1);
    this.saveManifest(manifest);

    logger.info(`GeoJsonService: deleted layer "${layer.name}" (${id})`);
  }

  updateLayer(
    id: string,
    updates: Partial<Pick<GeoJsonLayer, 'name' | 'visible' | 'style'>>
  ): GeoJsonLayer {
    const manifest = this.loadManifest();
    const index = manifest.layers.findIndex(l => l.id === id);

    if (index === -1) {
      throw new Error(`GeoJSON layer not found: ${id}`);
    }

    const layer = manifest.layers[index];

    if (updates.name !== undefined) layer.name = updates.name;
    if (updates.visible !== undefined) layer.visible = updates.visible;
    if (updates.style !== undefined) layer.style = { ...layer.style, ...updates.style };
    layer.updatedAt = Date.now();

    manifest.layers[index] = layer;
    this.saveManifest(manifest);

    logger.info(`GeoJsonService: updated layer "${layer.name}" (${id})`);
    return layer;
  }

  discoverLayers(): GeoJsonLayer[] {
    this.ensureDir();

    const manifest = this.loadManifest();
    const trackedFilenames = new Set(manifest.layers.map(l => l.filename));
    const discovered: GeoJsonLayer[] = [];

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dataDir);
    } catch (err) {
      logger.warn('GeoJsonService: failed to read data directory', err);
      return [];
    }

    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (ext !== '.geojson' && ext !== '.json') continue;
      if (entry === MANIFEST_FILENAME) continue;
      if (trackedFilenames.has(entry)) continue;

      // Try to read and validate
      const filePath = path.join(this.dataDir, entry);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      if (!this.validateGeoJson(content)) continue;

      const id = randomUUID();
      const name = path.basename(entry, ext);
      const now = Date.now();
      const colorIndex = (manifest.layers.length + discovered.length) % DEFAULT_COLOR_PALETTE.length;

      // Rename the file to use the UUID naming convention
      const newFilename = `${id}.geojson`;
      try {
        fs.renameSync(filePath, path.join(this.dataDir, newFilename));
      } catch {
        // If rename fails, keep original filename
      }

      const layer: GeoJsonLayer = {
        id,
        name,
        filename: newFilename,
        visible: true,
        style: {
          color: DEFAULT_COLOR_PALETTE[colorIndex],
          opacity: 0.7,
          weight: 2,
          fillOpacity: 0.3,
        },
        createdAt: now,
        updatedAt: now,
      };

      manifest.layers.push(layer);
      discovered.push(layer);
      logger.info(`GeoJsonService: discovered layer "${name}" (${id})`);
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
      throw new Error(`GeoJSON layer not found: ${id}`);
    }

    const filePath = path.join(this.dataDir, layer.filename);
    return fs.readFileSync(filePath, 'utf-8');
  }

  getLayers(): GeoJsonLayer[] {
    this.discoverLayers();
    return this.loadManifest().layers;
  }
}

// ---------------------------------------------------------------------------
// Singleton export (uses default data dir)
// ---------------------------------------------------------------------------

const geojsonService = new GeoJsonService();
export default geojsonService;
