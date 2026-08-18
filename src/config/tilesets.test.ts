import { describe, it, expect } from 'vitest';
import {
  TILESETS,
  getTilesetById,
  getAllTilesets,
  type CustomTileset,
} from './tilesets';

describe('tilesets — hybrid overlay support', () => {
  it('exposes the esriHybrid tileset with an ESRI reference-label overlayUrl', () => {
    const hybrid = TILESETS.esriHybrid;
    expect(hybrid).toBeDefined();
    expect(hybrid.name).toBe('Satellite + Labels');
    // Base is the same imagery as the plain satellite tileset...
    expect(hybrid.url).toContain('World_Imagery');
    // ...with a transparent reference overlay stacked on top.
    expect(hybrid.overlayUrl).toBeDefined();
    expect(hybrid.overlayUrl).toContain('World_Reference_Overlay');
    expect(hybrid.overlayUrl).toMatch(/\{z\}.*\{y\}.*\{x\}/); // ESRI z/y/x order
  });

  it('plain esriSatellite has no overlayUrl (kept as a distinct option)', () => {
    expect(TILESETS.esriSatellite.overlayUrl).toBeUndefined();
  });

  it('getTilesetById resolves esriHybrid with its overlayUrl intact', () => {
    const t = getTilesetById('esriHybrid');
    expect(t.id).toBe('esriHybrid');
    expect(t.overlayUrl).toContain('World_Reference_Overlay');
  });

  it('getTilesetById passes overlayUrl through for custom tilesets', () => {
    const custom: CustomTileset = {
      id: 'custom-hybrid',
      name: 'My Hybrid',
      url: 'https://base/{z}/{x}/{y}.png',
      overlayUrl: 'https://labels/{z}/{x}/{y}.png',
      attribution: '',
      maxZoom: 18,
      description: '',
      createdAt: 0,
      updatedAt: 0,
    };
    const resolved = getTilesetById('custom-hybrid', [custom]);
    expect(resolved.overlayUrl).toBe('https://labels/{z}/{x}/{y}.png');
    expect(getAllTilesets([custom]).find(t => t.id === 'custom-hybrid')?.overlayUrl)
      .toBe('https://labels/{z}/{x}/{y}.png');
  });
});
