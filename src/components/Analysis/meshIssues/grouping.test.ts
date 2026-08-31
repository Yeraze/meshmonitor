/**
 * grouping — pure unit tests (#4964 report reorganization, WP3, spec §10.1).
 */
import { describe, it, expect } from 'vitest';
import type { MeshIssueRow } from '../meshIssueTypes';
import {
  DEFAULT_MESH_ISSUES_FILTERS,
  compareIssueRows,
  groupByNode,
  issueTypesForGroup,
  matchesFilters,
  rankNodeGroups,
  worstSeverityOf,
} from './grouping';

let nextId = 1;

function makeRow(overrides: Partial<MeshIssueRow> = {}): MeshIssueRow {
  return {
    id: nextId++,
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

describe('matchesFilters', () => {
  it('empty arrays mean "no constraint" on that dimension', () => {
    const row = makeRow();
    expect(matchesFilters(row, DEFAULT_MESH_ISSUES_FILTERS)).toBe(true);
  });

  it('severities filters independently', () => {
    const row = makeRow({ severity: 'info' });
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, severities: ['critical', 'warning'] })).toBe(false);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, severities: ['info'] })).toBe(true);
  });

  it('tiers filters against the first character of issueType', () => {
    const row = makeRow({ issueType: 'B3_asymmetric_link' });
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, tiers: ['A'] })).toBe(false);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, tiers: ['B'] })).toBe(true);
  });

  it('issueTypes filters exactly', () => {
    const row = makeRow({ issueType: 'B3_asymmetric_link' });
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, issueTypes: ['B7_coverage_shadow'] })).toBe(false);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, issueTypes: ['B3_asymmetric_link'] })).toBe(true);
  });

  it('sources filters by intersection with row.sourceIds', () => {
    const row = makeRow({ sourceIds: ['src-a', 'src-b'] });
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, sources: ['src-z'] })).toBe(false);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, sources: ['src-b'] })).toBe(true);
  });

  it('q matches nodeName case-insensitively', () => {
    const row = makeRow({ nodeName: 'Repeater Hill' });
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, q: 'repeater' })).toBe(true);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, q: 'nomatch' })).toBe(false);
  });

  it('q matches subjectKey case-insensitively when nodeName misses', () => {
    const row = makeRow({ nodeName: null, subjectKey: 'edge:AAAA-BBBB' });
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, q: 'aaaa-bbbb' })).toBe(true);
  });

  it('includeClosed defaults to excluding closed rows', () => {
    const row = makeRow({ status: 'closed' });
    expect(matchesFilters(row, DEFAULT_MESH_ISSUES_FILTERS)).toBe(false);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, includeClosed: true })).toBe(true);
  });

  it('includeDismissed defaults to excluding dismissed rows', () => {
    const row = makeRow({ dismissed: true });
    expect(matchesFilters(row, DEFAULT_MESH_ISSUES_FILTERS)).toBe(false);
    expect(matchesFilters(row, { ...DEFAULT_MESH_ISSUES_FILTERS, includeDismissed: true })).toBe(true);
  });
});

describe('compareIssueRows (sort comparator, spec §8.4)', () => {
  const sortByNum = (row: MeshIssueRow) => (typeof row.evidence.n === 'number' ? row.evidence.n : null);

  it('null sorts last ascending', () => {
    const withNull = makeRow({ evidence: {} });
    const withValue = makeRow({ evidence: { n: 1 } });
    expect(compareIssueRows(withNull, withValue, sortByNum, 'asc')).toBeGreaterThan(0);
    expect(compareIssueRows(withValue, withNull, sortByNum, 'asc')).toBeLessThan(0);
  });

  it('null sorts last descending too', () => {
    const withNull = makeRow({ evidence: {} });
    const withValue = makeRow({ evidence: { n: 1 } });
    expect(compareIssueRows(withNull, withValue, sortByNum, 'desc')).toBeGreaterThan(0);
    expect(compareIssueRows(withValue, withNull, sortByNum, 'desc')).toBeLessThan(0);
  });

  it('both null is stable (0)', () => {
    const a = makeRow({ evidence: {}, lastDetected: 5000, id: 10 });
    const b = makeRow({ evidence: {}, lastDetected: 5000, id: 10 });
    expect(compareIssueRows(a, b, sortByNum, 'asc')).toBe(0);
  });

  it('falls through to lastDetected desc, then id desc, on a tie', () => {
    const older = makeRow({ evidence: { n: 5 }, lastDetected: 1000, id: 1 });
    const newer = makeRow({ evidence: { n: 5 }, lastDetected: 2000, id: 2 });
    // Primary sort value ties (both n=5); newer lastDetected sorts first
    // regardless of the requested primary direction.
    expect(compareIssueRows(newer, older, sortByNum, 'asc')).toBeLessThan(0);
    expect(compareIssueRows(newer, older, sortByNum, 'desc')).toBeLessThan(0);

    const sameLastDetected1 = makeRow({ evidence: { n: 5 }, lastDetected: 1000, id: 1 });
    const sameLastDetected2 = makeRow({ evidence: { n: 5 }, lastDetected: 1000, id: 2 });
    expect(compareIssueRows(sameLastDetected2, sameLastDetected1, sortByNum, 'asc')).toBeLessThan(0);
  });

  it('ascending vs descending flips the primary comparison direction', () => {
    const low = makeRow({ evidence: { n: 1 } });
    const high = makeRow({ evidence: { n: 9 } });
    expect(compareIssueRows(low, high, sortByNum, 'asc')).toBeLessThan(0);
    expect(compareIssueRows(low, high, sortByNum, 'desc')).toBeGreaterThan(0);
  });
});

describe('groupByNode / rankNodeGroups (spec §6.3/§10.1)', () => {
  it('partitions findings by nodeNum — no finding appears in two groups', () => {
    const rows = [
      makeRow({ nodeNum: 1 }),
      makeRow({ nodeNum: 1 }),
      makeRow({ nodeNum: 2 }),
      makeRow({ nodeNum: null }),
    ];
    const groups = groupByNode(rows);
    const totalGrouped = groups.reduce((sum, g) => sum + g.issues.length, 0);
    expect(totalGrouped).toBe(rows.length);

    const seenIds = new Set<number>();
    for (const group of groups) {
      for (const issue of group.issues) {
        expect(seenIds.has(issue.id)).toBe(false);
        seenIds.add(issue.id);
      }
    }
  });

  it('nodeNum === null findings land in the Mesh-wide group and rank first regardless of severity/count', () => {
    const meshWide = [makeRow({ nodeNum: null, severity: 'info' })];
    const bigCriticalNode = Array.from({ length: 10 }, () => makeRow({ nodeNum: 99, severity: 'critical' }));
    const groups = rankNodeGroups(groupByNode([...meshWide, ...bigCriticalNode]));
    expect(groups[0].nodeNum).toBeNull();
    expect(groups[1].nodeNum).toBe(99);
  });

  it('severity beats count', () => {
    const criticalSmall = groupByNode([makeRow({ nodeNum: 1, severity: 'critical' })]);
    const infoBig = groupByNode(Array.from({ length: 20 }, () => makeRow({ nodeNum: 2, severity: 'info' })));
    const ranked = rankNodeGroups([...infoBig, ...criticalSmall]);
    expect(ranked[0].nodeNum).toBe(1);
  });

  it('count beats recency when severity ties', () => {
    const twoFindings = groupByNode([
      makeRow({ nodeNum: 1, severity: 'warning', lastDetected: 5000 }),
      makeRow({ nodeNum: 1, severity: 'warning', lastDetected: 5000 }),
    ]);
    const oneRecentFinding = groupByNode([makeRow({ nodeNum: 2, severity: 'warning', lastDetected: 9000 })]);
    const ranked = rankNodeGroups([...oneRecentFinding, ...twoFindings]);
    expect(ranked[0].nodeNum).toBe(1);
  });

  it('recency beats nodeNum when severity and count tie', () => {
    const nodeA = groupByNode([makeRow({ nodeNum: 5, severity: 'warning', lastDetected: 1000 })]);
    const nodeB = groupByNode([makeRow({ nodeNum: 3, severity: 'warning', lastDetected: 9000 })]);
    const ranked = rankNodeGroups([...nodeA, ...nodeB]);
    expect(ranked[0].nodeNum).toBe(3);
  });

  it('nodeNum breaks ties deterministically when severity, count, and recency all tie', () => {
    const nodeHigh = groupByNode([makeRow({ nodeNum: 20, severity: 'warning', lastDetected: 1000 })]);
    const nodeLow = groupByNode([makeRow({ nodeNum: 3, severity: 'warning', lastDetected: 1000 })]);
    const ranked = rankNodeGroups([...nodeHigh, ...nodeLow]);
    expect(ranked[0].nodeNum).toBe(3);
    expect(ranked[1].nodeNum).toBe(20);
  });
});

describe('worstSeverityOf', () => {
  it('picks the highest-ranked severity present', () => {
    const issues = [makeRow({ severity: 'info' }), makeRow({ severity: 'critical' }), makeRow({ severity: 'warning' })];
    expect(worstSeverityOf(issues)).toBe('critical');
  });
});

describe('issueTypesForGroup (spec §4.3 MeshIssueNodeSummary.issueTypes ordering)', () => {
  it('orders distinct types worst-severity-first, then lexicographic', () => {
    const issues = [
      makeRow({ issueType: 'B7_coverage_shadow', severity: 'info' }),
      makeRow({ issueType: 'A1_deprecated_role', severity: 'warning' }),
      makeRow({ issueType: 'B3_asymmetric_link', severity: 'warning' }),
    ];
    expect(issueTypesForGroup(issues)).toEqual(['A1_deprecated_role', 'B3_asymmetric_link', 'B7_coverage_shadow']);
  });

  it('deduplicates repeated types, keeping the best severity seen', () => {
    const issues = [
      makeRow({ issueType: 'B7_coverage_shadow', severity: 'info' }),
      makeRow({ issueType: 'B7_coverage_shadow', severity: 'critical' }),
      makeRow({ issueType: 'A1_deprecated_role', severity: 'warning' }),
    ];
    expect(issueTypesForGroup(issues)).toEqual(['B7_coverage_shadow', 'A1_deprecated_role']);
  });
});
