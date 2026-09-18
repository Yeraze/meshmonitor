import { describe, it, expect } from 'vitest';
import { buildGroupedNodeItems, countNodesByCategory } from './nodeGrouping';
import { NODE_TYPE_CATEGORIES } from './nodeTypeCategory';

interface TestNode {
  id: string;
  user?: { role?: number } | null;
  isFavorite?: boolean;
}

const node = (id: string, role: number, isFavorite = false): TestNode => ({ id, user: { role }, isFavorite });

describe('countNodesByCategory', () => {
  it('counts nodes per category and omits empty categories', () => {
    const nodes = [node('a', 2), node('b', 2), node('c', 0)]; // 2x mtRouter, 1x mtClient
    const result = countNodesByCategory(nodes);
    expect(result).toEqual([
      { category: 'mtRouter', count: 2 },
      { category: 'mtClient', count: 1 },
    ]);
  });

  it('orders categories by the fixed NODE_TYPE_CATEGORIES order, not by count', () => {
    // mtClient (role 0) outnumbers mtRouter (role 2) 3:1, but mtRouter sorts
    // first in NODE_TYPE_CATEGORIES (infrastructure-first) so it must stay first.
    const nodes = [node('a', 0), node('b', 0), node('c', 0), node('d', 2)];
    const result = countNodesByCategory(nodes);
    expect(result.map((r) => r.category)).toEqual(['mtRouter', 'mtClient']);
    const indexOfRouter = NODE_TYPE_CATEGORIES.indexOf('mtRouter');
    const indexOfClient = NODE_TYPE_CATEGORIES.indexOf('mtClient');
    expect(indexOfRouter).toBeLessThan(indexOfClient);
  });

  it('returns an empty array for an empty node list', () => {
    expect(countNodesByCategory([])).toEqual([]);
  });

  it('sums to the total node count', () => {
    const nodes = [node('a', 0), node('b', 1), node('c', 2), node('d', 2), node('e', 6)];
    const result = countNodesByCategory(nodes);
    const total = result.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(nodes.length);
  });
});

describe('buildGroupedNodeItems', () => {
  // Identity order-by-id, standing in for NodesTab's favorites-first + field sort.
  const orderById = (nodes: TestNode[]) => [...nodes].sort((a, b) => a.id.localeCompare(b.id));

  it('produces one header per present category followed by its rows', () => {
    const nodes = [node('b', 0), node('a', 0), node('z', 2)];
    const items = buildGroupedNodeItems(nodes, orderById, new Set());
    expect(items).toEqual([
      { type: 'header', category: 'mtRouter', count: 1, collapsed: false },
      { type: 'node', node: node('z', 2) },
      { type: 'header', category: 'mtClient', count: 2, collapsed: false },
      { type: 'node', node: node('a', 0) },
      { type: 'node', node: node('b', 0) },
    ]);
  });

  it('orders groups infrastructure-first per NODE_TYPE_CATEGORIES, independent of insertion order', () => {
    const nodes = [node('a', 6), node('b', 0), node('c', 2)]; // sensor, client, router
    const items = buildGroupedNodeItems(nodes, orderById, new Set());
    const headerCategories = items.filter((i) => i.type === 'header').map((i) => (i as { category: string }).category);
    expect(headerCategories).toEqual(['mtRouter', 'mtClient', 'mtSensor']);
  });

  it('omits a collapsed group\'s rows entirely but keeps its header (never renders hidden rows eagerly)', () => {
    const nodes = [node('a', 0), node('b', 0), node('c', 2)];
    const items = buildGroupedNodeItems(nodes, orderById, new Set(['mtClient']));
    expect(items).toEqual([
      { type: 'header', category: 'mtRouter', count: 1, collapsed: false },
      { type: 'node', node: node('c', 2) },
      { type: 'header', category: 'mtClient', count: 2, collapsed: true },
    ]);
  });

  it('applies orderWithinGroup independently per group', () => {
    const nodes = [node('b', 0), node('a', 0)];
    const reversed = (list: TestNode[]) => [...list].reverse();
    const items = buildGroupedNodeItems(nodes, reversed, new Set());
    // Group collects in input order ['b', 'a']; reversed() flips it to ['a', 'b'].
    expect(items.filter((i) => i.type === 'node').map((i) => (i as { node: TestNode }).node.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty node list', () => {
    expect(buildGroupedNodeItems([], orderById, new Set())).toEqual([]);
  });

  it('header counts sum to the total node count', () => {
    const nodes = [node('a', 0), node('b', 1), node('c', 2), node('d', 2), node('e', 6)];
    const items = buildGroupedNodeItems(nodes, orderById, new Set());
    const total = items
      .filter((i): i is { type: 'header'; category: string; count: number; collapsed: boolean } => i.type === 'header')
      .reduce((sum, h) => sum + h.count, 0);
    expect(total).toBe(nodes.length);
  });
});
