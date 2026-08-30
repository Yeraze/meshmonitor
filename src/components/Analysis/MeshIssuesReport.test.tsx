/**
 * @vitest-environment jsdom
 *
 * MeshIssuesReport — Mesh Issues Analysis findings report (#4964 Phase 1
 * WP5, widened Phase 3 WP4). Covers severity-group ordering, the
 * empty/error/loading states, that a finding's recommendation renders once
 * (not duplicated as an evidence pill), the coverage preface (C3), the info
 * group's collapse/tally/incremental-render, dismiss/restore, duration and
 * source-name formatting, and the `*Total` "+N more" arithmetic. Model:
 * MqttViolationsReport.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Override the global i18n mock (src/test/setup.ts) — that mock's `t(key, options)`
// signature doesn't understand this component's real i18next-style
// `t(key, defaultValue, options)` calls, so string assertions here need a
// local mock that returns the default value, matching the
// NodeInfoEnrichmentReport.test.tsx / MqttViolationsReport.test.tsx precedent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let result = typeof defaultValue === 'string' ? defaultValue : key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          result = result.replace(`{{${k}}}`, String(v));
        });
      }
      return result;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../services/api')>();
  return {
    __esModule: true,
    // setBaseUrl: RouterClusterMap (#4974) pulls BaseMap → TilesetSelector →
    // SettingsContext → i18n → init.ts, which calls api.setBaseUrl at import.
    default: { get: vi.fn(), post: vi.fn(), setBaseUrl: vi.fn() },
    ApiError: actual.ApiError,
  };
});

import apiService, { ApiError } from '../../services/api';
import MeshIssuesReport from './MeshIssuesReport';
import type {
  MeshIssueRow,
  MeshIssuesLastRunResult,
  MeshIssuesResponse,
  MeshIssuesStatus,
  ResolvedMeshIssueThresholds,
} from './meshIssueTypes';

type Mocked = ReturnType<typeof vi.fn>;

function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MeshIssuesReport />
    </QueryClientProvider>,
  );
}

function issueRow(overrides: Partial<MeshIssueRow> = {}): MeshIssueRow {
  return {
    id: 1,
    issueType: 'A1_deprecated_role',
    subjectKey: 'node:12345',
    nodeNum: 12345,
    nodeName: 'TestNode',
    severity: 'warning',
    confidence: 'high',
    evidence: {
      role: 4,
      roleName: 'REPEATER',
      lastHeardAgeMs: 3_600_000,
      sources: ['sourceA'],
      recommendation: 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.',
    },
    sourceIds: ['sourceA'],
    firstDetected: Date.UTC(2026, 6, 1),
    lastDetected: Date.UTC(2026, 6, 20),
    status: 'open',
    dismissed: false,
    dismissedAt: null,
    ...overrides,
  };
}

/**
 * Builds a page-1 `MeshIssuesResponse` fixture. `total` defaults to
 * `issues.length` (i.e. everything fits on one page — the common case for
 * these tests, which keeps `remaining` at 0 and the "Load more" control
 * hidden). Pass an explicit `total` greater than `issues.length` to
 * exercise pagination (#4964 post-epic follow-ups).
 */
function issuesResponse(
  issues: MeshIssueRow[],
  sourceNames: Record<string, string> = {},
  overrides: Partial<Pick<MeshIssuesResponse, 'total' | 'limit' | 'offset' | 'counts'>> = {},
): { success: true; data: MeshIssuesResponse } {
  const total = overrides.total ?? issues.length;
  const counts = overrides.counts ?? {
    critical: 0,
    warning: 0,
    info: 0,
    total,
    dismissed: issues.filter((i) => i.dismissed).length,
  };
  if (!overrides.counts) {
    for (const issue of issues) counts[issue.severity]++;
  }
  return {
    success: true,
    data: {
      issues,
      counts,
      sourceNames,
      total,
      limit: overrides.limit ?? 500,
      offset: overrides.offset ?? 0,
    },
  };
}

const DEFAULT_THRESHOLDS: ResolvedMeshIssueThresholds = {
  tierAEnabled: true,
  tierBEnabled: true,
  tierCEnabled: true,
  b7Enabled: true,
  airUtilTxPct: 8,
  channelUtilPct: 25,
  mobileSpanMeters: 500,
  snrAsymmetryDb: 6,
  overBroadcastSeconds: 300,
  routerClusterMaxLinkKm: 30,
};

function lastRunResultFixture(overrides: Partial<MeshIssuesLastRunResult> = {}): MeshIssuesLastRunResult {
  return {
    durationMs: 1234,
    sourceCount: 2,
    nodeCount: 40,
    findingCount: 5,
    newCount: 1,
    reopenedCount: 0,
    updatedCount: 4,
    closedCount: 0,
    byType: {},
    corpusStats: {
      rawCount: 1842,
      validCount: 1530,
      dedupedCount: 1204,
      sampledCount: 318,
      distinctPairCount: 96,
      truncated: false,
    },
    coverage: {
      evidence: { neighborInfo: true, traceroute: true, mqttGateway: true, packetLog: true },
      neighborInfoRowCount: 10,
      neighborInfoEdgeCount: 20,
      tracerouteEdgeCount: 30,
      tracerouteSentinelHopsDropped: 0,
      gatewayCount: 3,
      gatewayDirectEdgeCount: 5,
      gatewayCoReceptionEdgeCount: 2,
      gatewayCellsSkipped: 0,
      directEdgeCount: 10,
      totalEdgeCount: 15,
      graphNodeCount: 40,
      snrDirectionsWithMinSamples: 5,
      hopHorizonSource: 'packet_log',
      hopHorizonNodeCount: 8,
      skippedRules: [],
    },
    ...overrides,
  };
}

function statusResponse(overrides: Partial<MeshIssuesStatus> = {}): {
  success: true;
  data: MeshIssuesStatus;
} {
  return {
    success: true,
    data: {
      running: true,
      inProgress: false,
      enabled: true,
      frequencyHours: 24,
      lookbackHours: 168,
      pairBucketHours: 6,
      lastRunTime: null,
      lastRunResult: null,
      thresholds: DEFAULT_THRESHOLDS,
      lastRunResultFromStorage: false,
      ...overrides,
    },
  };
}

describe('MeshIssuesReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Status call is non-critical for these tests; keep it resolved by default.
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([]));
    });
    (apiService.post as Mocked).mockResolvedValue({ success: true });
  });

  it('renders severity groups in critical -> warning -> info order', async () => {
    const issues = [
      issueRow({ id: 1, severity: 'info', issueType: 'A5_cosplay_router', nodeName: 'InfoNode' }),
      issueRow({ id: 2, severity: 'critical', issueType: 'A3_infra_power', nodeName: 'CritNode' }),
      issueRow({ id: 3, severity: 'warning', issueType: 'A1_deprecated_role', nodeName: 'WarnNode' }),
    ];
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse(issues));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/CritNode/)).toBeInTheDocument());

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    const criticalIdx = headings.findIndex((h) => h?.startsWith('Critical'));
    const warningIdx = headings.findIndex((h) => h?.startsWith('Warning'));
    const infoIdx = headings.findIndex((h) => h?.startsWith('Info'));

    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeGreaterThan(criticalIdx);
    expect(infoIdx).toBeGreaterThan(warningIdx);

    // Critical and warning stay expanded — no collapsed-info card is hidden here.
    expect(screen.getByText(/WarnNode/)).toBeInTheDocument();
    expect(screen.getByText(/CritNode/)).toBeInTheDocument();
  });

  it('shows the empty banner when there are no issues', async () => {
    renderReport();
    await waitFor(() => expect(screen.getByText(/No mesh issues detected/i)).toBeInTheDocument());
  });

  it('shows the error banner when the query rejects', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.reject(new ApiError('Failed to load', 500, { code: 'MESH_ISSUES_FETCH_FAILED' }));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText('Failed to load')).toBeInTheDocument());
  });

  it('renders the recommendation once and other evidence fields as pills, never duplicating recommendation', async () => {
    const issue = issueRow({
      id: 7,
      severity: 'warning',
      nodeName: 'FieldNode',
      evidence: {
        role: 4,
        roleName: 'REPEATER',
        lastHeardAgeMs: 7_200_000,
        sources: ['sourceA', 'sourceB'],
        recommendation: 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/FieldNode/)).toBeInTheDocument());

    // Recommendation text appears exactly once.
    expect(
      screen.getAllByText('Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.'),
    ).toHaveLength(1);

    // Other evidence fields render as label/value pills.
    expect(screen.getByText('REPEATER')).toBeInTheDocument();

    // 'recommendation' itself is never rendered as a field label.
    expect(screen.queryByText('Recommendation')).not.toBeInTheDocument();
  });

  it('renders a B1 router-cluster finding with member names and severity, not [object Object]', async () => {
    const issue = issueRow({
      id: 10,
      issueType: 'B1_router_cluster',
      subjectKey: 'cluster:3:1a2b3c',
      nodeNum: null,
      nodeName: null,
      severity: 'critical',
      confidence: 'medium',
      evidence: {
        size: 3,
        members: [
          { nodeNum: 111, name: 'RouterAlpha', role: 3, roleName: 'ROUTER', directDegree: 2 },
          { nodeNum: 222, name: null, role: 3, roleName: 'ROUTER', directDegree: 1 },
          { nodeNum: 333, name: 'RouterGamma', role: 6, roleName: 'REPEATER', directDegree: 2 },
        ],
        membersTruncated: false,
        edges: [{ a: 111, b: 222, evidenceClasses: ['neighborInfo'], observationCount: 4 }],
        edgesTruncated: false,
        inferredOnly: false,
        bestSitedNodeNum: 111,
        bestSitedName: 'RouterAlpha',
        sources: ['sourceA'],
        recommendation: 'Keep RouterAlpha as the router and move the others to ROUTER_LATE.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText('RouterAlpha').length).toBeGreaterThan(0));
    // Nameless member falls back to !hex, never [object Object].
    expect(screen.getByText('!000000de')).toBeInTheDocument();
    expect(screen.getByText('RouterGamma')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('renders a B3 asymmetric-link finding with both directional SNR rows and folds weakerDirection into the table', async () => {
    const issue = issueRow({
      id: 11,
      issueType: 'B3_asymmetric_link',
      subjectKey: 'edge:100-200',
      nodeNum: 100,
      nodeName: null,
      severity: 'warning',
      confidence: 'medium',
      evidence: {
        nodeA: { nodeNum: 100, name: 'NodeA', role: 3, roleName: 'ROUTER' },
        nodeB: { nodeNum: 200, name: 'NodeB', role: null, roleName: 'Unknown' },
        snrToA: { count: 5, meanDb: -2.5, minDb: -6, maxDb: 1 },
        snrToB: { count: 4, meanDb: -10.3, minDb: -14, maxDb: -8 },
        deltaDb: 7.8,
        weakerDirection: 'a->b',
        evidenceClasses: ['traceroute'],
        observationCount: 9,
        sources: ['sourceA'],
        recommendation: 'One end of this link hears the other much better than the reverse.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText('SNR by direction')).toBeInTheDocument());
    // NodeA -> NodeB row shows the SNR measured AT B (snrToB); the reverse
    // row shows the SNR measured AT A (snrToA) — see rfGraph.ts's convention.
    expect(screen.getByText(/NodeA -> NodeB/)).toBeInTheDocument();
    expect(screen.getByText('-10.3 dB (n=4)')).toBeInTheDocument();
    expect(screen.getByText(/NodeB -> NodeA/)).toBeInTheDocument();
    expect(screen.getByText('-2.5 dB (n=5)')).toBeInTheDocument();
    // weakerDirection is folded into the table as a "weaker" tag, never a raw a->b pill.
    expect(screen.getByText('(weaker)')).toBeInTheDocument();
    expect(screen.queryByText('a->b')).not.toBeInTheDocument();
    expect(screen.queryByText('Weaker Direction')).not.toBeInTheDocument();
  });

  it('shows a truncation affordance for a capped member list instead of a raw Yes/No pill', async () => {
    const issue = issueRow({
      id: 12,
      issueType: 'B1_router_cluster',
      subjectKey: 'cluster:2:deadbeef',
      nodeNum: null,
      nodeName: null,
      severity: 'warning',
      confidence: 'low',
      evidence: {
        size: 2,
        members: [{ nodeNum: 1, name: 'One', role: 3, roleName: 'ROUTER', directDegree: 1 }],
        membersTruncated: true,
        edges: [],
        edgesTruncated: false,
        inferredOnly: true,
        bestSitedNodeNum: 1,
        bestSitedName: 'One',
        sources: ['sourceA'],
        recommendation: 'Keep One as the router.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText('One').length).toBeGreaterThan(0));
    expect(screen.getByText(/more not shown/i)).toBeInTheDocument();
    // The truncated flag itself must never render as a raw boolean pill.
    expect(screen.queryByText('Members Truncated')).not.toBeInTheDocument();
  });

  it('shows the real remainder from a *Total field on a capped list, not the generic wording', async () => {
    const issue = issueRow({
      id: 13,
      issueType: 'B1_router_cluster',
      subjectKey: 'cluster:2:cafef00d',
      nodeNum: null,
      nodeName: null,
      severity: 'warning',
      evidence: {
        size: 40,
        members: [{ nodeNum: 1, name: 'One', role: 3, roleName: 'ROUTER', directDegree: 1 }],
        membersTruncated: true,
        membersTotal: 40,
        edges: [],
        edgesTruncated: false,
        edgesTotal: 0,
        inferredOnly: false,
        bestSitedNodeNum: 1,
        bestSitedName: 'One',
        sources: ['sourceA'],
        recommendation: 'Keep One as the router.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText('One').length).toBeGreaterThan(0));
    expect(screen.getByText('+39 more not shown')).toBeInTheDocument();
    expect(screen.queryByText('Members Total')).not.toBeInTheDocument();
  });

  it('falls back to the generic field instead of throwing when structured evidence is malformed', async () => {
    const issue = issueRow({
      id: 14,
      issueType: 'B1_router_cluster',
      subjectKey: 'cluster:2:baadf00d',
      nodeNum: null,
      nodeName: null,
      severity: 'warning',
      confidence: 'medium',
      evidence: {
        size: 2,
        // Malformed: a string where an EvidenceNodeRef[] is expected.
        members: 'not-an-array',
        edges: [],
        inferredOnly: false,
        bestSitedNodeNum: 1,
        bestSitedName: 'One',
        sources: ['sourceA'],
        recommendation: 'Keep One as the router.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    // Falls back to the generic pill rendering the raw string, not a crash.
    await waitFor(() => expect(screen.getByText('not-an-array')).toBeInTheDocument());
  });

  it('still renders Tier A findings via the plain evidence grid unchanged', async () => {
    const issue = issueRow({
      id: 15,
      issueType: 'A3_infra_power',
      nodeName: 'InfraNode',
      severity: 'critical',
      evidence: {
        role: 3,
        roleName: 'ROUTER',
        resetCount: 4,
        sources: ['sourceA'],
        recommendation: 'Check this node’s power supply.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/InfraNode/)).toBeInTheDocument());
    expect(screen.getByText('ROUTER')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Check this node’s power supply.')).toBeInTheDocument();
  });

  it('formats non-integer evidence numbers to at most 2 decimal places', async () => {
    const issue = issueRow({
      id: 9,
      issueType: 'A2a_chatty_node',
      severity: 'warning',
      nodeName: 'ChattyNode',
      evidence: {
        meanAirUtilTx: 9.33333,
        sampleCount: 6,
        sources: ['sourceA'],
        recommendation: 'Review its position/telemetry broadcast intervals.',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/ChattyNode/)).toBeInTheDocument());
    expect(screen.getByText('9.33')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('renders lastHeardAgeMs as a human duration and drops the trailing "Ms" from the label', async () => {
    const issue = issueRow({
      id: 16,
      nodeName: 'DurationNode',
      evidence: {
        lastHeardAgeMs: 3 * 3_600_000,
        sources: ['sourceA'],
        recommendation: 'x',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/DurationNode/)).toBeInTheDocument());
    expect(screen.getByText('Last Heard Age')).toBeInTheDocument();
    expect(screen.getByText('3 hours')).toBeInTheDocument();
    expect(screen.queryByText('Last Heard Age Ms')).not.toBeInTheDocument();
  });

  it('renders source ids as names via sourceNames, falling back to a shortened id', async () => {
    const issue = issueRow({
      id: 17,
      nodeName: 'SourceNode',
      sourceIds: ['sourceA', 'unknownSourceId12345'],
      evidence: {
        sources: ['sourceA', 'unknownSourceId12345'],
        recommendation: 'x',
      },
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue], { sourceA: 'Home Base' }));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/SourceNode/)).toBeInTheDocument());
    // Both the "sources" evidence pill and the header SOURCES row resolve names.
    expect(screen.getAllByText(/Home Base, unknownS/).length).toBeGreaterThan(0);
  });

  it('renders the coverage preface funnel, evidence pills, and degradation notes from a mocked status', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) {
        return Promise.resolve(
          statusResponse({
            lastRunTime: Date.UTC(2026, 7, 28),
            lastRunResult: lastRunResultFixture({
              coverage: {
                evidence: { neighborInfo: true, traceroute: false, mqttGateway: false, packetLog: true },
                neighborInfoRowCount: 10,
                neighborInfoEdgeCount: 12,
                tracerouteEdgeCount: 0,
                tracerouteSentinelHopsDropped: 4,
                gatewayCount: 0,
                gatewayDirectEdgeCount: 0,
                gatewayCoReceptionEdgeCount: 0,
                gatewayCellsSkipped: 0,
                directEdgeCount: 12,
                totalEdgeCount: 12,
                graphNodeCount: 40,
                snrDirectionsWithMinSamples: 0,
                hopHorizonSource: null,
                hopHorizonNodeCount: 0,
                skippedRules: [{ rule: 'B2', reason: 'insufficient neighbor data' }],
              },
            }),
          }),
        );
      }
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/1,842/)).toBeInTheDocument());
    expect(screen.getByText(/318 sampled, 96 distinct pairs/)).toBeInTheDocument();
    expect(screen.getByText(/NeighborInfo \(12\)/)).toBeInTheDocument();
    expect(screen.getByText(/needs traceroutes; none were collected in the window/)).toBeInTheDocument();
    expect(
      screen.getByText(/needs traceroutes or the MQTT packet log: no link has 3 or more SNR samples/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/needs a packet monitor: enable the Meshtastic packet log or the MQTT packet log/),
    ).toBeInTheDocument();
    expect(screen.getByText(/the MQTT packet log is off/)).toBeInTheDocument();
    expect(screen.getByText(/insufficient neighbor data/)).toBeInTheDocument();
    expect(screen.getByText(/traceroute hops were dropped as MQTT-injected/)).toBeInTheDocument();
  });

  it('renders no coverage preface (not a broken shell) when lastRunResult is null', async () => {
    renderReport();

    await waitFor(() => expect(screen.getByText(/No mesh issues detected/i)).toBeInTheDocument());
    expect(screen.queryByText(/distinct pairs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NeighborInfo/)).not.toBeInTheDocument();
  });

  it('adds a quiet note when lastRunResult was recovered from storage after a restart', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) {
        return Promise.resolve(
          statusResponse({ lastRunTime: Date.UTC(2026, 7, 28), lastRunResultFromStorage: true }),
        );
      }
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() =>
      expect(screen.getByText(/from the last completed run before restart/)).toBeInTheDocument(),
    );
  });

  it('collapses the info group by default with a per-type tally; expand then show-more reveal cards incrementally, while critical/warning stay expanded', async () => {
    const infoIssues = Array.from({ length: 30 }, (_, i) =>
      issueRow({
        id: 100 + i,
        severity: 'info',
        issueType: 'B7_coverage_shadow',
        nodeName: `InfoNode${i}`,
      }),
    );
    const warnIssue = issueRow({ id: 5, severity: 'warning', issueType: 'A1_deprecated_role', nodeName: 'WarnNode' });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([...infoIssues, warnIssue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/WarnNode/)).toBeInTheDocument());
    // Warning group stays expanded by default.
    expect(screen.getByText(/WarnNode/)).toBeInTheDocument();
    // Info group starts collapsed — no info card is in the DOM yet.
    expect(screen.queryByText(/InfoNode0(?!\d)/)).not.toBeInTheDocument();
    // A per-type tally is visible even while collapsed.
    expect(screen.getByText(/Coverage shadow 30/)).toBeInTheDocument();

    const infoToggle = screen.getByRole('button', { name: /Info \(30\)/ });
    fireEvent.click(infoToggle);

    await waitFor(() => expect(screen.getByText(/InfoNode0(?!\d)/)).toBeInTheDocument());
    // Only the first INFO_PAGE_SIZE (25) cards render initially.
    expect(screen.queryByText(/InfoNode29/)).not.toBeInTheDocument();
    expect(screen.getByText(/Show 5 more \(5 remaining\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Show 5 more/));

    await waitFor(() => expect(screen.getByText(/InfoNode29/)).toBeInTheDocument());
  });

  it('dismiss button fires the POST and the row moves under the "Show dismissed" toggle', async () => {
    let dismissed = false;
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      const includeDismissed = endpoint.includes('includeDismissed=true');
      if (!includeDismissed && dismissed) return Promise.resolve(issuesResponse([]));
      return Promise.resolve(
        issuesResponse([issueRow({ id: 21, nodeName: 'DismissMe', dismissed })]),
      );
    });
    (apiService.post as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.endsWith('/dismiss')) dismissed = true;
      return Promise.resolve({ success: true });
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/DismissMe/)).toBeInTheDocument());

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissBtn);

    await waitFor(() =>
      expect(apiService.post).toHaveBeenCalledWith('/api/analysis/mesh-issues/21/dismiss'),
    );

    // With dismissed rows still excluded (checkbox unchecked), the row disappears.
    await waitFor(() => expect(screen.queryByText(/DismissMe/)).not.toBeInTheDocument());

    // Toggling "Show dismissed" brings it back, now with a Restore action.
    fireEvent.click(screen.getByRole('checkbox', { name: /show dismissed/i }));

    await waitFor(() => expect(screen.getByText(/DismissMe/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
  });

  it('shows "Load more" when total > loaded issues, fetches the next page on click, appends results, and the group heading reflects the full count once fully loaded (#4964 post-epic follow-ups)', async () => {
    const page1Issues = [
      issueRow({ id: 1, severity: 'warning', nodeName: 'WarnNode1' }),
      issueRow({ id: 2, severity: 'warning', nodeName: 'WarnNode2' }),
    ];
    const page2Issues = [
      issueRow({ id: 3, severity: 'warning', nodeName: 'WarnNode3' }),
      issueRow({ id: 4, severity: 'warning', nodeName: 'WarnNode4' }),
      issueRow({ id: 5, severity: 'warning', nodeName: 'WarnNode5' }),
    ];
    const total = page1Issues.length + page2Issues.length;
    const fullCounts = { critical: 0, warning: total, info: 0, total, dismissed: 0 };

    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('offset=2')) {
        return Promise.resolve(
          issuesResponse(page2Issues, {}, { total, counts: fullCounts, offset: 2 }),
        );
      }
      return Promise.resolve(
        issuesResponse(page1Issues, {}, { total, counts: fullCounts, offset: 0 }),
      );
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/WarnNode2/)).toBeInTheDocument());
    expect(screen.queryByText(/WarnNode3/)).not.toBeInTheDocument();
    // Partially loaded: the group heading says so rather than showing the
    // loaded count alone.
    expect(screen.getByText(/Warning \(2 of 5 loaded\)/)).toBeInTheDocument();

    const loadMoreBtn = screen.getByRole('button', { name: /Load more \(3 remaining\)/i });
    fireEvent.click(loadMoreBtn);

    await waitFor(() => expect(screen.getByText(/WarnNode5/)).toBeInTheDocument());
    // Page 1's cards are still present — appended, not replaced.
    expect(screen.getByText(/WarnNode1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Warning \(5\)/)).toBeInTheDocument();
  });

  it('hides dismiss/restore controls once a mutation comes back 401/403', async () => {
    (apiService.post as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.endsWith('/dismiss')) {
        return Promise.reject(new ApiError('Forbidden', 403, { code: 'FORBIDDEN' }));
      }
      return Promise.resolve({ success: true });
    });
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issueRow({ id: 22, nodeName: 'ForbidNode' })]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/ForbidNode/)).toBeInTheDocument());
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissBtn);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument());
  });
});
