/**
 * issueColumns — pure unit tests (#4964 report reorganization, WP3, spec
 * §10.1). No DOM; `render`/`sortValue` are called directly and their return
 * values inspected.
 */
import { describe, it, expect } from 'vitest';
import { ISSUE_TYPE_LABELS, type MeshIssueRow } from '../meshIssueTypes';
import { arr, bool, num, path, str, columnsForType, type ColumnCtx } from './issueColumns';

const CTX: ColumnCtx = { sourceNames: {} };

function makeRow(overrides: Partial<MeshIssueRow> = {}): MeshIssueRow {
  return {
    id: 1,
    issueType: 'A1_deprecated_role',
    subjectKey: 'node:123',
    nodeNum: 123,
    nodeName: 'Alice',
    severity: 'warning',
    confidence: 'medium',
    evidence: {},
    sourceIds: ['src-1'],
    firstDetected: 1000,
    lastDetected: 2000,
    status: 'open',
    dismissed: false,
    dismissedAt: null,
    ...overrides,
  };
}

const ALL_TYPES = Object.keys(ISSUE_TYPE_LABELS);

describe('columnsForType — structural invariants (spec §8.1/§10.1)', () => {
  it('returns 18 canonical issue types to check', () => {
    expect(ALL_TYPES.length).toBe(18);
  });

  for (const type of ALL_TYPES) {
    it(`${type}: non-empty, exactly one primary, unique keys`, () => {
      const columns = columnsForType(type);
      expect(columns.length).toBeGreaterThan(0);

      const primaries = columns.filter((c) => c.primary === true);
      expect(primaries.length).toBe(1);

      const keys = columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it(`${type}: every column survives evidence: {} without throwing`, () => {
      const row = makeRow({ issueType: type, evidence: {} });
      for (const column of columnsForType(type)) {
        expect(() => column.render(row, CTX)).not.toThrow();
        expect(() => column.sortValue(row)).not.toThrow();
        // An empty-evidence row has nothing to show — every value-derived
        // column renders an em dash. (The fallback-column path for unknown
        // types is exercised separately below; every canonical type's
        // columns are strictly evidence-key-driven.)
        const rendered = column.render(row, CTX);
        expect(rendered).toBe('—');
        expect(column.sortValue(row)).toBeNull();
      }
    });

    it(`${type}: survives a redacted (null-name) row without throwing`, () => {
      const row = makeRow({
        issueType: type,
        evidence: {
          roleName: null,
          nearestRouterName: null,
          coveredByName: null,
          bestSitedName: null,
          peerBestName: null,
        },
      });
      for (const column of columnsForType(type)) {
        expect(() => column.render(row, CTX)).not.toThrow();
        expect(() => column.sortValue(row)).not.toThrow();
      }
    });
  }
});

describe('defensive accessors', () => {
  it('num/str/bool/arr/path degrade gracefully on missing or wrong-typed evidence', () => {
    const row = makeRow({ evidence: { a: 'x', b: 1, c: true, d: [1, 2], e: { f: 5 } } });
    expect(num(row, 'a')).toBeNull();
    expect(num(row, 'b')).toBe(1);
    expect(num(row, 'missing')).toBeNull();
    expect(str(row, 'a')).toBe('x');
    expect(str(row, 'b')).toBeNull();
    expect(bool(row, 'c')).toBe(true);
    expect(bool(row, 'a')).toBeNull();
    expect(arr(row, 'd')).toEqual([1, 2]);
    expect(arr(row, 'a')).toBeNull();
    expect(path(row, 'e', 'f')).toBe(5);
    expect(path(row, 'a', 'f')).toBeUndefined();
    expect(path(row, 'missing', 'f')).toBeUndefined();
  });
});

describe('ratio-valued columns render percent and sort on the raw ratio (spec §8.2)', () => {
  it('B2 overlapRatio', () => {
    const row = makeRow({ issueType: 'B2_redundant_router', evidence: { overlapRatio: 0.42 } });
    const col = columnsForType('B2_redundant_router').find((c) => c.key === 'overlapRatio')!;
    expect(col.render(row, CTX)).toBe('42%');
    expect(col.sortValue(row)).toBe(0.42);
    expect(col.primary).toBe(true);
  });

  it('B4 hopShare defaults ascending (low is bad)', () => {
    const col = columnsForType('B4_idle_router').find((c) => c.key === 'hopShare')!;
    expect(col.defaultDir).toBe('asc');
  });

  it('B5 areaShare', () => {
    const row = makeRow({ issueType: 'B5_load_bearing_client', evidence: { areaShare: 0.75 } });
    const col = columnsForType('B5_load_bearing_client').find((c) => c.key === 'areaShare')!;
    expect(col.render(row, CTX)).toBe('75%');
    expect(col.sortValue(row)).toBe(0.75);
  });

  it('B6 exhaustedRatio', () => {
    const row = makeRow({ issueType: 'B6_hop_horizon', evidence: { exhaustedRatio: 0.9 } });
    const col = columnsForType('B6_hop_horizon').find((c) => c.key === 'exhaustedRatio')!;
    expect(col.render(row, CTX)).toBe('90%');
    expect(col.sortValue(row)).toBe(0.9);
  });
});

describe('B7 distanceM renders km, sorts metres (spec §8.2)', () => {
  it('renders 1dp km, sorts raw metres', () => {
    const row = makeRow({ issueType: 'B7_coverage_shadow', evidence: { distanceM: 2500 } });
    const col = columnsForType('B7_coverage_shadow').find((c) => c.key === 'distanceM')!;
    expect(col.render(row, CTX)).toBe('2.5 km');
    expect(col.sortValue(row)).toBe(2500);
    expect(col.primary).toBe(true);
  });
});

describe("B3 weakerDirection renders the weaker end's name, never the raw literal (spec §8.2)", () => {
  const nodeA = { nodeNum: 1, name: 'Alpha' };
  const nodeB = { nodeNum: 2, name: 'Bravo' };

  it("'a->b' renders node B's name (B is the poor listener)", () => {
    const row = makeRow({
      issueType: 'B3_asymmetric_link',
      evidence: { nodeA, nodeB, weakerDirection: 'a->b' },
    });
    const col = columnsForType('B3_asymmetric_link').find((c) => c.key === 'weakerDirection')!;
    const rendered = col.render(row, CTX);
    expect(rendered).toBe('Bravo');
    expect(rendered).not.toBe('a->b');
  });

  it("'b->a' renders node A's name", () => {
    const row = makeRow({
      issueType: 'B3_asymmetric_link',
      evidence: { nodeA, nodeB, weakerDirection: 'b->a' },
    });
    const col = columnsForType('B3_asymmetric_link').find((c) => c.key === 'weakerDirection')!;
    expect(col.render(row, CTX)).toBe('Alpha');
  });

  it('falls back to hex id when the endpoint has no name', () => {
    const row = makeRow({
      issueType: 'B3_asymmetric_link',
      evidence: { nodeA: { nodeNum: 1 }, nodeB: { nodeNum: 2 }, weakerDirection: 'a->b' },
    });
    const col = columnsForType('B3_asymmetric_link').find((c) => c.key === 'weakerDirection')!;
    expect(col.render(row, CTX)).toBe('!00000002');
  });
});

describe('B3 deltaDb sorts by absolute magnitude regardless of sign', () => {
  it('a negative delta sorts as its absolute value', () => {
    const row = makeRow({ issueType: 'B3_asymmetric_link', evidence: { deltaDb: -8.4 } });
    const col = columnsForType('B3_asymmetric_link').find((c) => c.key === 'deltaDb')!;
    expect(col.sortValue(row)).toBe(8.4);
    expect(col.render(row, CTX)).toBe('-8.4 dB');
  });
});

describe('C1_time_offset sorts by absolute offset; a negative offset renders signed (spec §8.2/§10.1)', () => {
  it('negative offset', () => {
    const row = makeRow({ issueType: 'C1_time_offset', evidence: { timeOffsetSeconds: -125 } });
    const col = columnsForType('C1_time_offset').find((c) => c.key === 'timeOffsetSeconds')!;
    expect(col.sortValue(row)).toBe(125);
    const rendered = col.render(row, CTX) as string;
    expect(rendered.startsWith('-')).toBe(true);
  });

  it('positive offset', () => {
    const row = makeRow({ issueType: 'C1_time_offset', evidence: { timeOffsetSeconds: 125 } });
    const col = columnsForType('C1_time_offset').find((c) => c.key === 'timeOffsetSeconds')!;
    expect(col.sortValue(row)).toBe(125);
    const rendered = col.render(row, CTX) as string;
    expect(rendered.startsWith('+')).toBe(true);
  });

  it('sorts by absolute value, so a bigger negative offset outranks a smaller positive one', () => {
    const bigNegative = makeRow({ issueType: 'C1_time_offset', evidence: { timeOffsetSeconds: -500 } });
    const smallPositive = makeRow({ issueType: 'C1_time_offset', evidence: { timeOffsetSeconds: 10 } });
    const col = columnsForType('C1_time_offset').find((c) => c.key === 'timeOffsetSeconds')!;
    expect(col.sortValue(bigNegative)! > col.sortValue(smallPositive)!).toBe(true);
  });
});

describe('C1_key_security clauses: sorted by length, joined for display', () => {
  it('renders joined clauses and sorts by count', () => {
    const row = makeRow({
      issueType: 'C1_key_security',
      evidence: { clauses: ['keyIsLowEntropy', 'duplicateKeyDetected'] },
    });
    const col = columnsForType('C1_key_security').find((c) => c.key === 'clauses')!;
    expect(col.render(row, CTX)).toBe('keyIsLowEntropy, duplicateKeyDetected');
    expect(col.sortValue(row)).toBe(2);
    expect(col.primary).toBe(true);
  });
});

describe('B1 members and edges', () => {
  it('members: first 3 names + "+N"', () => {
    const row = makeRow({
      issueType: 'B1_router_cluster',
      evidence: {
        members: [
          { nodeNum: 1, name: 'One' },
          { nodeNum: 2, name: 'Two' },
          { nodeNum: 3, name: 'Three' },
          { nodeNum: 4, name: 'Four' },
          { nodeNum: 5 },
        ],
      },
    });
    const col = columnsForType('B1_router_cluster').find((c) => c.key === 'members')!;
    expect(col.render(row, CTX)).toBe('One, Two, Three +2');
  });

  it('edges: prefers edgesTotal over edges.length', () => {
    const row = makeRow({
      issueType: 'B1_router_cluster',
      evidence: { edges: [{ a: 1, b: 2 }], edgesTotal: 40 },
    });
    const col = columnsForType('B1_router_cluster').find((c) => c.key === 'edges')!;
    expect(col.render(row, CTX)).toBe('40');
    expect(col.sortValue(row)).toBe(40);
  });

  it('edges: falls back to edges.length when edgesTotal is absent', () => {
    const row = makeRow({
      issueType: 'B1_router_cluster',
      evidence: { edges: [{ a: 1, b: 2 }, { a: 2, b: 3 }] },
    });
    const col = columnsForType('B1_router_cluster').find((c) => c.key === 'edges')!;
    expect(col.render(row, CTX)).toBe('2');
    expect(col.sortValue(row)).toBe(2);
  });
});

describe('unknown-type fallback (spec §8.5)', () => {
  it('returns up to 3 columns with exactly one primary', () => {
    const columns = columnsForType('Z9_totally_unknown');
    expect(columns.length).toBe(3);
    expect(columns.filter((c) => c.primary).length).toBe(1);
    const keys = columns.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('builds columns from the row\'s own evidence keys, excluding structured/Total/Truncated/recommendation/sources', () => {
    const row = makeRow({
      issueType: 'Z9_totally_unknown',
      evidence: {
        recommendation: 'do something',
        sources: ['src-1'],
        members: [{ nodeNum: 1 }],
        fooTotal: 3,
        fooTruncated: true,
        widgetCount: 7,
        colorName: 'blue',
      },
    });
    const columns = columnsForType('Z9_totally_unknown');
    const rendered = columns.map((c) => c.render(row, CTX));
    // Only widgetCount/colorName survive the exclusion filters; the primary
    // column (index 0) shows the first of them.
    expect(rendered[0]).toContain('Widget Count');
    expect(rendered[1]).toContain('Color Name');
  });

  it('empty evidence: the primary column falls back to a synthetic lastDetected date', () => {
    const row = makeRow({ issueType: 'Z9_totally_unknown', evidence: {}, lastDetected: 1_700_000_000_000 });
    const columns = columnsForType('Z9_totally_unknown');
    const primary = columns.find((c) => c.primary)!;
    expect(() => primary.render(row, CTX)).not.toThrow();
    expect(primary.render(row, CTX)).toBe(new Date(row.lastDetected).toLocaleString());
    expect(primary.sortValue(row)).toBe(row.lastDetected);
  });
});
