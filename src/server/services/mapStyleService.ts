/**
 * MapStyle Service
 *
 * Manages MapLibre GL style JSON files stored on disk.
 * Handles manifest CRUD, file storage, and validation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STYLES_DIR = '/data/styles';
const MANIFEST_FILENAME = 'manifest.json';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MapStyleService {
  private readonly dataDir: string;
  private readonly manifestPath: string;

  constructor(dataDir: string = DEFAULT_STYLES_DIR) {
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

  loadManifest(): MapStyleManifest {
    try {
      if (!fs.existsSync(this.manifestPath)) {
        return { styles: [] };
      }
      const raw = fs.readFileSync(this.manifestPath, 'utf-8');
      return JSON.parse(raw) as MapStyleManifest;
    } catch (err) {
      logger.warn('MapStyleService: failed to load manifest, returning empty', err);
      return { styles: [] };
    }
  }

  private saveManifest(manifest: MapStyleManifest): void {
    this.ensureDir();
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  // ---- Validation ----------------------------------------------------------

  validateStyle(content: string): boolean {
    try {
      const obj = JSON.parse(content);
      if (typeof obj !== 'object' || obj === null) return false;
      if (obj.version !== 8) return false;
      if (typeof obj.sources !== 'object' || obj.sources === null) return false;
      if (!Array.isArray(obj.layers) || obj.layers.length < 1) return false;
      return true;
    } catch {
      return false;
    }
  }

  // ---- Style operations ----------------------------------------------------

  addStyle(
    name: string,
    content: string,
    sourceType: 'upload' | 'url',
    sourceUrl?: string
  ): MapStyle {
    if (!this.validateStyle(content)) {
      throw new Error(`Invalid MapLibre GL style content for: ${name}`);
    }

    this.ensureDir();

    const manifest = this.loadManifest();
    const id = randomUUID();
    const filename = `${id}.json`;
    const now = Date.now();

    const style: MapStyle = {
      id,
      name,
      filename,
      sourceType,
      sourceUrl: sourceUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };

    // Write style file
    fs.writeFileSync(path.join(this.dataDir, filename), content, 'utf-8');

    // Update manifest
    manifest.styles.push(style);
    this.saveManifest(manifest);

    logger.info(`MapStyleService: added style "${name}" (${id})`);
    return style;
  }

  deleteStyle(id: string): void {
    const manifest = this.loadManifest();
    const index = manifest.styles.findIndex(s => s.id === id);

    if (index === -1) {
      throw new Error(`Map style not found: ${id}`);
    }

    const style = manifest.styles[index];
    const filePath = path.join(this.dataDir, style.filename);

    // Remove file if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from manifest
    manifest.styles.splice(index, 1);
    this.saveManifest(manifest);

    logger.info(`MapStyleService: deleted style "${style.name}" (${id})`);
  }

  updateStyle(id: string, updates: { name?: string }): MapStyle {
    const manifest = this.loadManifest();
    const index = manifest.styles.findIndex(s => s.id === id);

    if (index === -1) {
      throw new Error(`Map style not found: ${id}`);
    }

    const style = manifest.styles[index];

    if (updates.name !== undefined) style.name = updates.name;
    style.updatedAt = Date.now();

    manifest.styles[index] = style;
    this.saveManifest(manifest);

    logger.info(`MapStyleService: updated style "${style.name}" (${id})`);
    return style;
  }

  getStyleData(id: string): string {
    const manifest = this.loadManifest();
    const style = manifest.styles.find(s => s.id === id);

    if (!style) {
      throw new Error(`Map style not found: ${id}`);
    }

    const filePath = path.join(this.dataDir, style.filename);
    if (!fs.existsSync(filePath)) {
      // Auto-remove orphaned manifest entry when backing file is missing
      this.deleteStyle(id);
      throw new Error(`Map style file missing, removed from manifest: ${style.filename}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  getStyles(): MapStyle[] {
    return this.loadManifest().styles;
  }
}

// ---------------------------------------------------------------------------
// Singleton export (uses default data dir)
// ---------------------------------------------------------------------------

const mapStyleService = new MapStyleService();
export default mapStyleService;
