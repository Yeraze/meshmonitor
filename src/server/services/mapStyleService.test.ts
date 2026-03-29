import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MapStyleService } from './mapStyleService.js';

const VALID_STYLE = JSON.stringify({
  version: 8,
  sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'] } },
  layers: [{ id: 'background', type: 'raster', source: 'osm' }],
});

let tmpDir: string;
let service: MapStyleService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstyle-test-'));
  service = new MapStyleService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe('loadManifest', () => {
  it('returns empty manifest when no file exists', () => {
    const manifest = service.loadManifest();
    expect(manifest).toEqual({ styles: [] });
  });

  it('returns existing manifest from disk', () => {
    const data = { styles: [{ id: 'abc', name: 'Test', filename: 'abc.json', sourceType: 'upload', sourceUrl: null, createdAt: 1, updatedAt: 1 }] };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(data), 'utf-8');
    const manifest = service.loadManifest();
    expect(manifest.styles).toHaveLength(1);
    expect(manifest.styles[0].id).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// validateStyle
// ---------------------------------------------------------------------------

describe('validateStyle', () => {
  it('returns true for a valid MapLibre GL style', () => {
    expect(service.validateStyle(VALID_STYLE)).toBe(true);
  });

  it('returns false when version is missing', () => {
    const bad = JSON.stringify({ sources: {}, layers: [{ id: 'x', type: 'background' }] });
    expect(service.validateStyle(bad)).toBe(false);
  });

  it('returns false when version is not 8', () => {
    const bad = JSON.stringify({ version: 7, sources: {}, layers: [{ id: 'x', type: 'background' }] });
    expect(service.validateStyle(bad)).toBe(false);
  });

  it('returns false when layers is missing', () => {
    const bad = JSON.stringify({ version: 8, sources: {} });
    expect(service.validateStyle(bad)).toBe(false);
  });

  it('returns false when layers array is empty', () => {
    const bad = JSON.stringify({ version: 8, sources: {}, layers: [] });
    expect(service.validateStyle(bad)).toBe(false);
  });

  it('returns false when sources is missing', () => {
    const bad = JSON.stringify({ version: 8, layers: [{ id: 'x' }] });
    expect(service.validateStyle(bad)).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(service.validateStyle('not-json')).toBe(false);
  });

  it('returns false for non-object JSON (array)', () => {
    expect(service.validateStyle('[1,2,3]')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addStyle
// ---------------------------------------------------------------------------

describe('addStyle', () => {
  it('stores the file and adds manifest entry for upload', () => {
    const style = service.addStyle('My Style', VALID_STYLE, 'upload');
    expect(style.id).toBeTruthy();
    expect(style.name).toBe('My Style');
    expect(style.sourceType).toBe('upload');
    expect(style.sourceUrl).toBeNull();

    const filePath = path.join(tmpDir, style.filename);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(VALID_STYLE);

    const manifest = service.loadManifest();
    expect(manifest.styles).toHaveLength(1);
    expect(manifest.styles[0].id).toBe(style.id);
  });

  it('stores sourceUrl for url sourceType', () => {
    const url = 'https://example.com/style.json';
    const style = service.addStyle('URL Style', VALID_STYLE, 'url', url);
    expect(style.sourceType).toBe('url');
    expect(style.sourceUrl).toBe(url);
  });

  it('throws for invalid style content', () => {
    expect(() => service.addStyle('Bad', 'not json', 'upload')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteStyle
// ---------------------------------------------------------------------------

describe('deleteStyle', () => {
  it('removes file and manifest entry', () => {
    const style = service.addStyle('To Delete', VALID_STYLE, 'upload');
    const filePath = path.join(tmpDir, style.filename);
    expect(fs.existsSync(filePath)).toBe(true);

    service.deleteStyle(style.id);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(service.loadManifest().styles).toHaveLength(0);
  });

  it('throws for nonexistent id', () => {
    expect(() => service.deleteStyle('nonexistent-id')).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// updateStyle
// ---------------------------------------------------------------------------

describe('updateStyle', () => {
  it('changes name and updates updatedAt', () => {
    const style = service.addStyle('Original', VALID_STYLE, 'upload');
    const before = style.updatedAt;

    // Ensure time advances
    const updated = service.updateStyle(style.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);

    const manifest = service.loadManifest();
    expect(manifest.styles[0].name).toBe('Renamed');
  });

  it('throws for nonexistent id', () => {
    expect(() => service.updateStyle('nonexistent-id', { name: 'X' })).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// getStyleData
// ---------------------------------------------------------------------------

describe('getStyleData', () => {
  it('returns raw file content', () => {
    const style = service.addStyle('Data Test', VALID_STYLE, 'upload');
    const data = service.getStyleData(style.id);
    expect(data).toBe(VALID_STYLE);
  });

  it('throws for nonexistent id', () => {
    expect(() => service.getStyleData('no-such-id')).toThrow(/not found/);
  });

  it('auto-removes orphaned manifest entry when file is missing', () => {
    const style = service.addStyle('Orphan', VALID_STYLE, 'upload');
    // Delete backing file manually
    fs.unlinkSync(path.join(tmpDir, style.filename));

    expect(() => service.getStyleData(style.id)).toThrow(/file missing/);
    // Entry should be removed from manifest
    expect(service.loadManifest().styles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getStyles
// ---------------------------------------------------------------------------

describe('getStyles', () => {
  it('returns empty array when no styles exist', () => {
    expect(service.getStyles()).toEqual([]);
  });

  it('returns all styles from manifest', () => {
    service.addStyle('Style A', VALID_STYLE, 'upload');
    service.addStyle('Style B', VALID_STYLE, 'url', 'https://example.com/b.json');
    const styles = service.getStyles();
    expect(styles).toHaveLength(2);
    const names = styles.map(s => s.name);
    expect(names).toContain('Style A');
    expect(names).toContain('Style B');
  });
});
