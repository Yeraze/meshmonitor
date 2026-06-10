/**
 * Tests for the remote LocalStats target-selection union filter (issue #3398).
 *
 * Mirrors the union-of-enabled-filters logic in getNodesNeedingRemoteLocalStatsAsync
 * (list / role / favorite / name-regex) as a pure function so the semantics are
 * pinned without standing up a database.
 */
import { describe, it, expect } from 'vitest';

interface TestNode {
  nodeNum: number;
  role?: number | null;
  isFavorite?: boolean;
  longName?: string;
  shortName?: string;
  nodeId?: string;
  lastHeard?: number | null;
}

interface FilterCfg {
  enabled: boolean;
  nodeNums: number[];
  filterRoles: number[];
  filterNameRegex: string;
  filterNodesEnabled: boolean;
  filterRolesEnabled: boolean;
  filterFavoriteEnabled: boolean;
  filterRegexEnabled: boolean;
}

// Mirrors the union section of getNodesNeedingRemoteLocalStatsAsync.
function applyUnionFilter(nodes: TestNode[], cfg: FilterCfg): TestNode[] {
  if (!cfg.enabled) return [];

  let regexMatcher: RegExp | null = null;
  if (cfg.filterRegexEnabled && cfg.filterNameRegex && cfg.filterNameRegex !== '.*') {
    try { regexMatcher = new RegExp(cfg.filterNameRegex, 'i'); } catch { /* invalid */ }
  }

  const hasAnyFilter =
    (cfg.filterNodesEnabled && cfg.nodeNums.length > 0) ||
    (cfg.filterRolesEnabled && cfg.filterRoles.length > 0) ||
    cfg.filterFavoriteEnabled ||
    (cfg.filterRegexEnabled && regexMatcher !== null);

  if (!hasAnyFilter) return nodes;

  return nodes.filter(node => {
    if (cfg.filterNodesEnabled && cfg.nodeNums.length > 0 && cfg.nodeNums.includes(Number(node.nodeNum))) return true;
    if (cfg.filterRolesEnabled && cfg.filterRoles.length > 0 && node.role != null && cfg.filterRoles.includes(node.role)) return true;
    if (cfg.filterFavoriteEnabled && node.isFavorite === true) return true;
    if (cfg.filterRegexEnabled && regexMatcher !== null) {
      const name = node.longName || node.shortName || node.nodeId || '';
      if (regexMatcher.test(name)) return true;
    }
    return false;
  });
}

const baseCfg: FilterCfg = {
  enabled: true,
  nodeNums: [],
  filterRoles: [],
  filterNameRegex: '.*',
  filterNodesEnabled: true,
  filterRolesEnabled: true,
  filterFavoriteEnabled: false,
  filterRegexEnabled: true,
};

const nodes: TestNode[] = [
  { nodeNum: 1, role: 2, isFavorite: false, longName: 'Router One', nodeId: '!00000001' },   // ROUTER
  { nodeNum: 2, role: 0, isFavorite: true, longName: 'Client Two', nodeId: '!00000002' },    // CLIENT, favorite
  { nodeNum: 3, role: 4, isFavorite: false, longName: 'Repeater Three', nodeId: '!00000003' }, // REPEATER
  { nodeNum: 4, role: 0, isFavorite: false, longName: 'Base Camp', nodeId: '!00000004' },
];

describe('Remote LocalStats target filter (issue #3398)', () => {
  it('returns nothing when the filter group is disabled (strictly opt-in)', () => {
    const result = applyUnionFilter(nodes, { ...baseCfg, enabled: false });
    expect(result).toHaveLength(0);
  });

  it('returns all candidates when enabled but no sub-filter is configured', () => {
    const result = applyUnionFilter(nodes, baseCfg);
    expect(result.map(n => n.nodeNum)).toEqual([1, 2, 3, 4]);
  });

  it('matches by discrete node list', () => {
    const result = applyUnionFilter(nodes, { ...baseCfg, nodeNums: [1, 3] });
    expect(result.map(n => n.nodeNum)).toEqual([1, 3]);
  });

  it('matches by role', () => {
    const result = applyUnionFilter(nodes, { ...baseCfg, filterRoles: [2, 4] });
    expect(result.map(n => n.nodeNum)).toEqual([1, 3]);
  });

  it('matches favorites when the favorite filter is enabled', () => {
    const result = applyUnionFilter(nodes, { ...baseCfg, filterFavoriteEnabled: true });
    expect(result.map(n => n.nodeNum)).toEqual([2]);
  });

  it('matches by name regex (case-insensitive)', () => {
    const result = applyUnionFilter(nodes, { ...baseCfg, filterNameRegex: '^router' });
    expect(result.map(n => n.nodeNum)).toEqual([1]);
  });

  it('unions across multiple enabled filters', () => {
    // ROUTER role (node 1) OR favorite (node 2) OR name ~ /repeater/ (node 3)
    const result = applyUnionFilter(nodes, {
      ...baseCfg,
      filterRoles: [2],
      filterFavoriteEnabled: true,
      filterNameRegex: 'repeater',
    });
    expect(result.map(n => n.nodeNum)).toEqual([1, 2, 3]);
  });

  it('ignores a sub-filter when its enable flag is off', () => {
    // Roles configured but disabled, favorite enabled → only the favorite matches.
    const result = applyUnionFilter(nodes, {
      ...baseCfg,
      filterRoles: [2],
      filterRolesEnabled: false,
      filterFavoriteEnabled: true,
    });
    expect(result.map(n => n.nodeNum)).toEqual([2]);
  });

  it('treats an invalid regex as no-match rather than throwing', () => {
    const result = applyUnionFilter(nodes, { ...baseCfg, filterNameRegex: '(' });
    // Invalid regex → regexMatcher stays null → no OR filter configured → all pass.
    expect(result.map(n => n.nodeNum)).toEqual([1, 2, 3, 4]);
  });
});
