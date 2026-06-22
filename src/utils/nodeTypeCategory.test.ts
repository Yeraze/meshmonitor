import { describe, it, expect } from 'vitest';
import {
  getNodeTypeCategory,
  nodePassesTypeFilter,
  categoriesForProtocols,
  categoryGlyphFamily,
  sourceTypeProtocol,
  isMeshCoreNode,
  MESHCORE_CATEGORIES,
  MESHTASTIC_CATEGORIES,
  NODE_TYPE_CATEGORIES,
} from './nodeTypeCategory';

describe('getNodeTypeCategory', () => {
  describe('MeshCore nodes (by advType)', () => {
    it('maps advType 1 to companion', () => {
      expect(getNodeTypeCategory({ isMeshCore: true, advType: 1 })).toBe('companion');
    });
    it('maps advType 2 to repeater', () => {
      expect(getNodeTypeCategory({ isMeshCore: true, advType: 2 })).toBe('repeater');
    });
    it('maps advType 3 to roomServer', () => {
      expect(getNodeTypeCategory({ isMeshCore: true, advType: 3 })).toBe('roomServer');
    });
    it('maps advType 4 (Observer/Sensor) to sensor', () => {
      expect(getNodeTypeCategory({ isMeshCore: true, advType: 4 })).toBe('sensor');
    });
    it('maps advType 0/unknown to standard', () => {
      expect(getNodeTypeCategory({ isMeshCore: true, advType: 0 })).toBe('standard');
      expect(getNodeTypeCategory({ isMeshCore: true, advType: 99 })).toBe('standard');
    });
    it('treats a numeric advType as MeshCore even without isMeshCore', () => {
      expect(getNodeTypeCategory({ advType: 2 })).toBe('repeater');
    });
  });

  describe('Meshtastic nodes (by role) — granular categories (issue #3610)', () => {
    it('maps ROUTER role (2) to its own mtRouter category', () => {
      expect(getNodeTypeCategory({ user: { role: 2 } })).toBe('mtRouter');
    });
    it('parses a stringified role', () => {
      expect(getNodeTypeCategory({ user: { role: '2' } })).toBe('mtRouter');
    });
    it('reads a top-level role fallback', () => {
      expect(getNodeTypeCategory({ role: 2 })).toBe('mtRouter');
    });
    it('distinguishes CLIENT, CLIENT_MUTE, TRACKER, SENSOR, etc.', () => {
      expect(getNodeTypeCategory({ user: { role: 0 } })).toBe('mtClient');
      expect(getNodeTypeCategory({ user: { role: 1 } })).toBe('mtClientMute');
      expect(getNodeTypeCategory({ user: { role: 3 } })).toBe('mtRouterClient');
      expect(getNodeTypeCategory({ user: { role: 4 } })).toBe('mtRepeater');
      expect(getNodeTypeCategory({ user: { role: 5 } })).toBe('mtTracker');
      expect(getNodeTypeCategory({ user: { role: 6 } })).toBe('mtSensor');
      expect(getNodeTypeCategory({ user: { role: 7 } })).toBe('mtTak');
      expect(getNodeTypeCategory({ user: { role: 8 } })).toBe('mtClientHidden');
      expect(getNodeTypeCategory({ user: { role: 9 } })).toBe('mtLostAndFound');
      expect(getNodeTypeCategory({ user: { role: 10 } })).toBe('mtTakTracker');
      expect(getNodeTypeCategory({ user: { role: 11 } })).toBe('mtRouterLate');
      expect(getNodeTypeCategory({ user: { role: 12 } })).toBe('mtClientBase');
    });
    it('falls back to mtClient (default role) for missing/garbage role', () => {
      expect(getNodeTypeCategory({})).toBe('mtClient');
      expect(getNodeTypeCategory({ user: { role: null } })).toBe('mtClient');
      expect(getNodeTypeCategory({ user: { role: 'nonsense' } })).toBe('mtClient');
      expect(getNodeTypeCategory({ user: { role: 99 } })).toBe('mtClient');
    });
  });

  it('every result is a known category', () => {
    const samples = [
      { isMeshCore: true, advType: 1 },
      { isMeshCore: true, advType: 4 },
      { user: { role: 2 } },
      { user: { role: 5 } },
      {},
    ];
    for (const s of samples) {
      expect(NODE_TYPE_CATEGORIES).toContain(getNodeTypeCategory(s));
    }
  });
});

describe('isMeshCoreNode', () => {
  it('detects MeshCore by isMeshCore flag or numeric advType', () => {
    expect(isMeshCoreNode({ isMeshCore: true })).toBe(true);
    expect(isMeshCoreNode({ advType: 0 })).toBe(true);
    expect(isMeshCoreNode({ user: { role: 2 } })).toBe(false);
    expect(isMeshCoreNode({})).toBe(false);
  });
});

describe('nodePassesTypeFilter', () => {
  it('shows a node whose category is enabled or absent (default visible)', () => {
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 2 }, {})).toBe(true);
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 2 }, { repeater: true })).toBe(true);
    // Meshtastic node with no relevant toggle => visible.
    expect(nodePassesTypeFilter({ user: { role: 5 } }, {})).toBe(true);
  });
  it('hides a node whose category is explicitly disabled', () => {
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 2 }, { repeater: false })).toBe(false);
    expect(nodePassesTypeFilter({ user: { role: 5 } }, { mtTracker: false })).toBe(false);
  });
  it('does not hide other categories when one is disabled', () => {
    const filter = { repeater: false, mtRouter: false };
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 1 }, filter)).toBe(true);
    expect(nodePassesTypeFilter({ user: { role: 0 } }, filter)).toBe(true);
  });
  it('a stale MeshCore toggle does not hide Meshtastic nodes (graceful degradation)', () => {
    // Source mix changed from MeshCore to Meshtastic-only; the old "roomServer: false"
    // toggle is inert because no Meshtastic node ever maps to roomServer.
    const filter = { roomServer: false, companion: false };
    expect(nodePassesTypeFilter({ user: { role: 2 } }, filter)).toBe(true);
    expect(nodePassesTypeFilter({ user: { role: 0 } }, filter)).toBe(true);
  });
});

describe('categoryGlyphFamily', () => {
  it('keeps MeshCore categories as their own family', () => {
    for (const c of MESHCORE_CATEGORIES) {
      expect(categoryGlyphFamily(c)).toBe(c);
    }
  });
  it('draws Meshtastic routers/repeaters as the repeater tower', () => {
    expect(categoryGlyphFamily('mtRouter')).toBe('repeater');
    expect(categoryGlyphFamily('mtRouterLate')).toBe('repeater');
    expect(categoryGlyphFamily('mtRepeater')).toBe('repeater');
  });
  it('draws a Meshtastic sensor as the sensor glyph', () => {
    expect(categoryGlyphFamily('mtSensor')).toBe('sensor');
  });
  it('falls back to the default pin (standard) for Meshtastic client-type roles', () => {
    expect(categoryGlyphFamily('mtClient')).toBe('standard');
    expect(categoryGlyphFamily('mtTracker')).toBe('standard');
    expect(categoryGlyphFamily('mtTak')).toBe('standard');
    expect(categoryGlyphFamily('mtClientBase')).toBe('standard');
  });
});

describe('sourceTypeProtocol', () => {
  it('classifies meshcore vs meshtastic source types', () => {
    expect(sourceTypeProtocol('meshcore')).toBe('meshcore');
    expect(sourceTypeProtocol('meshtastic_tcp')).toBe('meshtastic');
    expect(sourceTypeProtocol('meshtastic_mqtt')).toBe('meshtastic');
    expect(sourceTypeProtocol(undefined)).toBe('meshtastic');
    expect(sourceTypeProtocol(null)).toBe('meshtastic');
  });
});

describe('categoriesForProtocols (adaptive filter set, issue #3610)', () => {
  it('Meshtastic-only instance exposes only Meshtastic role categories', () => {
    const cats = categoriesForProtocols({ meshcore: false, meshtastic: true });
    expect(cats).toEqual(MESHTASTIC_CATEGORIES);
    // None of the MeshCore-only options leak in (the core bug).
    expect(cats).not.toContain('companion');
    expect(cats).not.toContain('roomServer');
    expect(cats).not.toContain('sensor');
    expect(cats).toContain('mtRouter');
    expect(cats).toContain('mtTracker');
  });
  it('MeshCore-only instance exposes only the MeshCore categories', () => {
    const cats = categoriesForProtocols({ meshcore: true, meshtastic: false });
    expect(cats).toEqual(MESHCORE_CATEGORIES);
    expect(cats).not.toContain('mtRouter');
  });
  it('both connected unions both sets (MeshCore first)', () => {
    const cats = categoriesForProtocols({ meshcore: true, meshtastic: true });
    expect(cats).toEqual([...MESHCORE_CATEGORIES, ...MESHTASTIC_CATEGORIES]);
  });
  it('nothing connected yet falls back to the full set (never empty)', () => {
    const cats = categoriesForProtocols({ meshcore: false, meshtastic: false });
    expect(cats).toEqual(NODE_TYPE_CATEGORIES);
  });
});
