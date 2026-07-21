import { describe, it, expect } from 'vitest';
import { expandSubdomains, resolve3DBasemap, buildTerrainTileUrl } from './basemap3d';
import { TILESETS, type CustomTileset } from './tilesets';

describe('expandSubdomains', () => {
  it('expands {s} into a,b,c subdomain URLs', () => {
    const result = expandSubdomains('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(result).toEqual([
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ]);
  });

  it('returns a single-element array when {s} is absent', () => {
    const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    expect(expandSubdomains(url)).toEqual([url]);
  });
});

describe('resolve3DBasemap', () => {
  it('passes a predefined raster tileset through unchanged (osm)', () => {
    const result = resolve3DBasemap('osm', []);
    expect(result.usedFallback).toBe(false);
    expect(result.attribution).toBe(TILESETS.osm.attribution);
    expect(result.maxZoom).toBe(TILESETS.osm.maxZoom);
    expect(result.tiles).toEqual([
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ]);
  });

  it('passes a predefined raster tileset without {s} through unchanged (esriSatellite)', () => {
    const result = resolve3DBasemap('esriSatellite', []);
    expect(result.usedFallback).toBe(false);
    expect(result.tiles).toEqual([TILESETS.esriSatellite.url]);
  });

  it('falls back to osm for a custom vector-only tileset', () => {
    const custom: CustomTileset[] = [
      {
        id: 'custom-vector',
        name: 'Vector Style',
        url: 'https://example.com/tiles/{z}/{x}/{y}.pbf',
        attribution: 'Example',
        maxZoom: 18,
        description: 'A vector tileset',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = resolve3DBasemap('custom-vector', custom);
    expect(result.usedFallback).toBe(true);
    expect(result.attribution).toBe(TILESETS.osm.attribution);
    expect(result.maxZoom).toBe(TILESETS.osm.maxZoom);
    expect(result.tiles[0]).toContain('tile.openstreetmap.org');
  });

  it('falls back to osm for a custom tileset explicitly flagged isVector', () => {
    const custom: CustomTileset[] = [
      {
        id: 'custom-flagged',
        name: 'Flagged',
        url: 'https://example.com/tiles/{z}/{x}/{y}',
        attribution: 'Example',
        maxZoom: 18,
        description: 'Flagged vector without a matching extension',
        createdAt: 1,
        updatedAt: 1,
        isVector: true,
      },
    ];
    const result = resolve3DBasemap('custom-flagged', custom);
    expect(result.usedFallback).toBe(true);
  });

  it('passes a custom raster tileset through unchanged', () => {
    const custom: CustomTileset[] = [
      {
        id: 'custom-raster',
        name: 'Raster Style',
        url: 'https://example.com/tiles/{z}/{x}/{y}.png',
        attribution: 'Example Attribution',
        maxZoom: 16,
        description: 'A raster tileset',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = resolve3DBasemap('custom-raster', custom);
    expect(result.usedFallback).toBe(false);
    expect(result.attribution).toBe('Example Attribution');
    expect(result.maxZoom).toBe(16);
    expect(result.tiles).toEqual(['https://example.com/tiles/{z}/{x}/{y}.png']);
  });

  it('falls back to the default tileset (osm) for an unknown tileset id', () => {
    const result = resolve3DBasemap('does-not-exist', []);
    expect(result.usedFallback).toBe(false);
    expect(result.attribution).toBe(TILESETS.osm.attribution);
  });
});

describe('buildTerrainTileUrl', () => {
  it('builds the tile URL template with an empty base path (root deployment)', () => {
    expect(buildTerrainTileUrl('')).toBe('/api/elevation/tiles/{z}/{x}/{y}');
  });

  it('joins a base path without a trailing slash', () => {
    expect(buildTerrainTileUrl('/meshmonitor')).toBe('/meshmonitor/api/elevation/tiles/{z}/{x}/{y}');
  });

  it('normalizes a base path with a trailing slash', () => {
    expect(buildTerrainTileUrl('/meshmonitor/')).toBe('/meshmonitor/api/elevation/tiles/{z}/{x}/{y}');
  });
});
