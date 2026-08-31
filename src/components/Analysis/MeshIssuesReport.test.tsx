/**
 * @vitest-environment jsdom
 *
 * MeshIssuesReport — the thin shell (#4964 report reorganization, WP4).
 * Covers the hard acceptance bullets from MESH_ISSUES_REORG_SPEC.md §11 WP4:
 * initial load issues exactly `/summary` + `/status` and no finding rows
 * render until a section expands; a tile click filters and auto-expands its
 * section in exactly one additional request; loading/error/empty states;
 * run-now; dismiss/restore forbidden-hiding; the coverage preface.
 *
 * Severity-group / FindingCard assertions from the pre-reorg shell moved to
 * `meshIssues/IssueTable.test.tsx` and `meshIssues/IssueTypeSection.test.tsx`
 * (spec §11 WP3 acceptance note: "existing assertions that no longer have a
 * home move to the new component tests rather than being deleted").
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Override the global i18n mock (src/test/setup.ts) — that mock's `t(key, options)`
// signature doesn't understand this component family's real i18next-style
// `t(key, defaultValue, options)` calls.
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
  MeshIssuesSummary,
  MeshIssueTypeSummary,
  ResolvedMeshIssueThresholds,
} from './meshIssueTypes';

type Mocked = ReturnType<typeof vi.fn>;

function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MeshIssuesReport />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function typeSummary(overrides: Partial<MeshIssueTypeSummary> = {}): MeshIssueTypeSummary {
  return {
    issueType: 'A1_deprecated_role',
    total: 3,
    bySeverity: { critical: 0, warning: 3, info: 0 },
    worstSeverity: 'warning',
    dismissed: 0,
    latestDetected: Date.UTC(2026, 7, 20),
    ...overrides,
  };
}

function summaryResponse(
  byType: MeshIssueTypeSummary[],
  overrides: Partial<MeshIssuesSummary> = {},
): { success: true; data: MeshIssuesSummary } {
  const total = byType.reduce((sum, t) => sum + t.total, 0);
  return {
    success: true,
    data: {
      byType,
      byNode: [],
      counts: { critical: 0, warning: total, info: 0, total, dismissed: 0 },
      total,
      sourceNames: {},
      ...overrides,
    },
  };
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

function issuesResponse(issues: MeshIssueRow[]): { success: true; data: MeshIssuesResponse } {
  const counts = { critical: 0, warning: 0, info: 0, total: issues.length, dismissed: issues.filter((i) => i.dismissed).length };
  for (const issue of issues) counts[issue.severity]++;
  return {
    success: true,
    data: { issues, counts, sourceNames: {}, total: issues.length, limit: 2000, offset: 0 },
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
  autoCloseCleanRuns: 3,
  routerClusterMaxLinkKm: 30,
  disabledRules: [],
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

function statusResponse(overrides: Partial<MeshIssuesStatus> = {}): { success: true; data: MeshIssuesStatus } {
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
    localStorage.clear();
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([]));
      return Promise.resolve(issuesResponse([]));
    });
    (apiService.post as Mocked).mockResolvedValue({ success: true });
  });

  it('issues exactly /summary and /status on initial load, with no finding rows in the DOM', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([typeSummary()]));
      return Promise.resolve(issuesResponse([issueRow()]));
    });

    renderReport();

    // Tile + collapsed section header both render the type's label.
    await waitFor(() => expect(screen.getAllByText(/Deprecated role/)).toHaveLength(2));

    // Tiles + collapsed section header rendered, but no finding row/table yet.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('TestNode')).not.toBeInTheDocument();

    const getCalls = (apiService.get as Mocked).mock.calls.map((c) => String(c[0]));
    expect(getCalls.some((u) => u.includes('/status'))).toBe(true);
    expect(getCalls.some((u) => u.includes('/summary'))).toBe(true);
    expect(getCalls.some((u) => u.includes('issueType='))).toBe(false);
    // Exactly the two calls above — no bare GET / and no per-type fetch.
    expect(getCalls).toHaveLength(2);
  });

  it('shows the empty banner when the summary has no findings', async () => {
    renderReport();
    await waitFor(() => expect(screen.getByText(/No mesh issues detected/i)).toBeInTheDocument());
  });

  it('shows the error banner when the summary query rejects', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) {
        return Promise.reject(new ApiError('Failed to load', 500, { code: 'MESH_ISSUES_SUMMARY_FAILED' }));
      }
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText('Failed to load')).toBeInTheDocument());
  });

  it('clicking a tile filters to that type, auto-expands its section, and fetches its findings in one request', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) {
        return Promise.resolve(summaryResponse([typeSummary(), typeSummary({ issueType: 'B7_coverage_shadow', total: 5, bySeverity: { critical: 0, warning: 0, info: 5 }, worstSeverity: 'info' })]));
      }
      if (endpoint.includes('issueType=A1_deprecated_role')) {
        return Promise.resolve(issuesResponse([issueRow({ id: 42, nodeName: 'TileNode' })]));
      }
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    // Tile + section header both render "Coverage shadow" before any filter.
    await waitFor(() => expect(screen.getAllByText(/Coverage shadow/)).toHaveLength(2));

    // The tile is the first "A1 Deprecated role" button in DOM order —
    // SummaryTiles renders before the By-issue section headers.
    const tile = screen.getAllByRole('button', { name: /A1 Deprecated role/ })[0];
    fireEvent.click(tile);

    // Filtering to A1 narrows the By-issue view to just that section — only
    // the (still-visible) B7 tile remains, its section is gone.
    await waitFor(() => expect(screen.getAllByText(/Coverage shadow/)).toHaveLength(1));
    // Auto-expand fires the section's single findings request.
    await waitFor(() => expect(screen.getByText('TileNode')).toBeInTheDocument());

    const getCalls = (apiService.get as Mocked).mock.calls.map((c) => String(c[0]));
    expect(getCalls.filter((u) => u.includes('issueType=A1_deprecated_role'))).toHaveLength(1);

    // Clicking the now-active tile clears the filter again.
    fireEvent.click(screen.getAllByRole('button', { name: /A1 Deprecated role/ })[0]);
    await waitFor(() => expect(screen.getAllByText(/Coverage shadow/)).toHaveLength(2));
  });

  it('run-now button triggers the mutation and refreshes summary + status', async () => {
    renderReport();

    await waitFor(() => expect(screen.getByRole('button', { name: /Run analysis now/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Run analysis now/ }));

    await waitFor(() => expect(apiService.post).toHaveBeenCalledWith('/api/analysis/mesh-issues/run-now'));
  });

  it('hides run-now once it comes back 401/403', async () => {
    (apiService.post as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.endsWith('/run-now')) {
        return Promise.reject(new ApiError('Forbidden', 403, { code: 'FORBIDDEN' }));
      }
      return Promise.resolve({ success: true });
    });

    renderReport();

    await waitFor(() => expect(screen.getByRole('button', { name: /Run analysis now/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Run analysis now/ }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Run analysis now/ })).not.toBeInTheDocument());
  });

  it('renders the coverage preface from a mocked status', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) {
        return Promise.resolve(
          statusResponse({ lastRunTime: Date.UTC(2026, 7, 28), lastRunResult: lastRunResultFixture() }),
        );
      }
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([]));
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/1,842/)).toBeInTheDocument());
    expect(screen.getByText(/318 sampled, 96 distinct pairs/)).toBeInTheDocument();
  });

  it('adds a quiet note when lastRunResult was recovered from storage after a restart', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) {
        return Promise.resolve(statusResponse({ lastRunTime: Date.UTC(2026, 7, 28), lastRunResultFromStorage: true }));
      }
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([]));
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/from the last completed run before restart/)).toBeInTheDocument());
  });

  it('expanding a section, dismissing a row, hides dismiss/restore once a mutation comes back 401/403', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([typeSummary()]));
      return Promise.resolve(issuesResponse([issueRow({ id: 22, nodeName: 'ForbidNode' })]));
    });
    (apiService.post as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.endsWith('/dismiss')) {
        return Promise.reject(new ApiError('Forbidden', 403, { code: 'FORBIDDEN' }));
      }
      return Promise.resolve({ success: true });
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText(/Deprecated role/)).toHaveLength(2));
    // Index 1 is the section header toggle (index 0 is the tile).
    fireEvent.click(screen.getAllByRole('button', { name: /Deprecated role/ })[1]);

    await waitFor(() => expect(screen.getByText('ForbidNode')).toBeInTheDocument());
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissBtn);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument());
  });

  it('selecting the By-node view renders a NodeGroupSection row per summary.byNode entry (WP5 shell integration)', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) {
        return Promise.resolve(
          summaryResponse([typeSummary()], {
            byNode: [
              {
                nodeNum: 555,
                nodeName: 'NodeFive55',
                total: 2,
                bySeverity: { critical: 0, warning: 2, info: 0 },
                worstSeverity: 'warning',
                issueTypes: ['A1_deprecated_role'],
                latestDetected: Date.UTC(2026, 7, 20),
              },
            ],
          }),
        );
      }
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByRole('button', { name: /By node/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /By node/ }));

    await waitFor(() => expect(screen.getByText('NodeFive55')).toBeInTheDocument());
    expect(screen.queryByText(/By-node view is not available yet/)).not.toBeInTheDocument();
  });

  it('bulk-dismissing a type from its header confirms first, POSTs the declarative scope, and refreshes tiles + sections + status (WP5)', async () => {
    let statusCalls = 0;
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) {
        statusCalls++;
        return Promise.resolve(statusResponse());
      }
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([typeSummary({ total: 3, dismissed: 0 })]));
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText(/Deprecated role/)).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dismiss all 3' }));
    // Confirm required before the mutation fires.
    expect(apiService.post).not.toHaveBeenCalledWith('/api/analysis/mesh-issues/bulk/dismiss', expect.anything());
    fireEvent.click(screen.getByTestId('bulk-confirm-go'));

    await waitFor(() =>
      expect(apiService.post).toHaveBeenCalledWith('/api/analysis/mesh-issues/bulk/dismiss', {
        scope: 'issueType',
        issueType: 'A1_deprecated_role',
      }),
    );
    // Refreshes summary (tiles/sections) + status.
    await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(2));
  });

  it('bulk-action and mute-rule controls are absent for a user without settings:write (WP5)', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([typeSummary()]));
      return Promise.resolve(issuesResponse([issueRow({ id: 22, nodeName: 'ForbidNode' })]));
    });
    (apiService.post as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.endsWith('/dismiss')) {
        return Promise.reject(new ApiError('Forbidden', 403, { code: 'FORBIDDEN' }));
      }
      return Promise.resolve({ success: true });
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText(/Deprecated role/)).toHaveLength(2));
    // Bulk menu is visible while canAct is true.
    expect(screen.getByRole('button', { name: /Bulk actions/ })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /Deprecated role/ })[1]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // A 403 on ANY settings:write mutation hides every such control, bulk
    // actions included — one shared forbidden-hiding flag (spec §11 WP5:
    // "bulk/mute controls are absent for a user without settings:write").
    await waitFor(() => expect(screen.queryByRole('button', { name: /Bulk actions/ })).not.toBeInTheDocument());
  });

  it('a filter change (search box) narrows the summary request', async () => {
    (apiService.get as Mocked).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      if (endpoint.includes('/summary')) return Promise.resolve(summaryResponse([typeSummary()]));
      return Promise.resolve(issuesResponse([]));
    });

    renderReport();

    await waitFor(() => expect(screen.getAllByText(/Deprecated role/)).toHaveLength(2));

    const search = screen.getByLabelText(/Search by node name/i);
    fireEvent.change(search, { target: { value: 'Alpha' } });

    await waitFor(() =>
      expect(
        (apiService.get as Mocked).mock.calls.some(
          (c: unknown[]) => String(c[0]).includes('/summary') && String(c[0]).includes('q=Alpha'),
        ),
      ).toBe(true),
    );
  });
});
