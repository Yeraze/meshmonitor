import { describe, it, expect } from 'vitest';
import {
  getNodeTypeCategory,
  nodePassesTypeFilter,
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

  describe('Meshtastic nodes (by role)', () => {
    it('maps ROUTER role (2) to repeater', () => {
      expect(getNodeTypeCategory({ user: { role: 2 } })).toBe('repeater');
    });
    it('parses a stringified role', () => {
      expect(getNodeTypeCategory({ user: { role: '2' } })).toBe('repeater');
    });
    it('reads a top-level role fallback', () => {
      expect(getNodeTypeCategory({ role: 2 })).toBe('repeater');
    });
    it('maps client roles to standard', () => {
      expect(getNodeTypeCategory({ user: { role: 0 } })).toBe('standard');
      expect(getNodeTypeCategory({ user: { role: 1 } })).toBe('standard');
    });
    it('falls back to standard for missing/garbage role', () => {
      expect(getNodeTypeCategory({})).toBe('standard');
      expect(getNodeTypeCategory({ user: { role: null } })).toBe('standard');
      expect(getNodeTypeCategory({ user: { role: 'nonsense' } })).toBe('standard');
    });
  });

  it('every result is a known category', () => {
    const samples = [
      { isMeshCore: true, advType: 1 },
      { isMeshCore: true, advType: 4 },
      { user: { role: 2 } },
      {},
    ];
    for (const s of samples) {
      expect(NODE_TYPE_CATEGORIES).toContain(getNodeTypeCategory(s));
    }
  });
});

describe('nodePassesTypeFilter', () => {
  it('shows a node whose category is enabled or absent (default visible)', () => {
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 2 }, {})).toBe(true);
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 2 }, { repeater: true })).toBe(true);
  });
  it('hides a node whose category is explicitly disabled', () => {
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 2 }, { repeater: false })).toBe(false);
  });
  it('does not hide other categories when one is disabled', () => {
    const filter = { repeater: false };
    expect(nodePassesTypeFilter({ isMeshCore: true, advType: 1 }, filter)).toBe(true);
    expect(nodePassesTypeFilter({ user: { role: 0 } }, filter)).toBe(true);
  });
});
