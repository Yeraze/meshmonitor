import { describe, it, expect } from 'vitest';
import { rankNodeSummaries } from './grouping';
import type { MeshIssueNodeSummary } from '../meshIssueTypes';

function g(over: Partial<MeshIssueNodeSummary>): MeshIssueNodeSummary {
  return {
    nodeNum: null,
    nodeName: null,
    total: 1,
    bySeverity: { critical: 0, warning: 1, info: 0 },
    worstSeverity: 'warning',
    issueTypes: [],
    latestDetected: 1,
    ...over,
  };
}

describe('rankNodeSummaries with MeshCore groups (#6263)', () => {
  it('pins only the true Mesh-wide group first; MeshCore groups rank like nodes', () => {
    const ranked = rankNodeSummaries([
      g({ subjectKey: 'mc:bb', total: 2 }),
      g({ nodeNum: 5 }),
      g({ subjectKey: 'mc:aa', total: 2 }),
      g({}), // Mesh-wide
    ]);
    expect(ranked.map((n) => n.subjectKey ?? n.nodeNum)).toEqual([null, 'mc:aa', 'mc:bb', 5]);
  });
});
