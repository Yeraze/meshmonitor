/**
 * @vitest-environment jsdom
 *
 * ByNodeView (#4964 report reorganization, WP5, spec §6.3/§10.5/§11 WP5
 * acceptance): the Mesh-wide pseudo-group pins first regardless of its own
 * severity/count; remaining nodes rank worst-first; each row's badge list
 * carries its distinct issue types; expanding a row fetches that node's
 * findings by `nodeNum` (or the `nodeNum=none` literal for Mesh-wide) in
 * exactly one request.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let result = typeof defaultValue === 'string' ? defaultValue : key;
      if (options) Object.entries(options).forEach(([k, v]) => { result = result.replace(`{{${k}}}`, String(v)); });
      return result;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../../services/api')>();
  return { __esModule: true, default: { get: vi.fn(), post: vi.fn(), setBaseUrl: vi.fn() }, ApiError: actual.ApiError };
});

import apiService from '../../../services/api';
import ByNodeView from './ByNodeView';
import { DEFAULT_MESH_ISSUES_FILTERS } from './grouping';
import { DEFAULT_MESH_ISSUES_VIEW_STATE, type MeshIssuesViewState } from './useMeshIssuesViewState';
import type { MeshIssueNodeSummary, MeshIssuesResponse, MeshIssuesSummary } from '../meshIssueTypes';

type Mocked = ReturnType<typeof vi.fn>;

function nodeSummary(overrides: Partial<MeshIssueNodeSummary> = {}): MeshIssueNodeSummary {
  return {
    nodeNum: 1,
    nodeName: 'Alpha',
    total: 1,
    bySeverity: { critical: 0, warning: 1, info: 0 },
    worstSeverity: 'warning',
    issueTypes: ['A1_deprecated_role'],
    latestDetected: Date.UTC(2026, 7, 20),
    ...overrides,
  };
}

function summaryWith(byNode: MeshIssueNodeSummary[]): MeshIssuesSummary {
  return { byType: [], byNode, counts: { critical: 0, warning: 0, info: 0, total: 0, dismissed: 0 }, total: 0, sourceNames: {} };
}

function issuesResponse(): { success: true; data: MeshIssuesResponse } {
  return { success: true, data: { issues: [], counts: { critical: 0, warning: 0, info: 0, total: 0, dismissed: 0 }, sourceNames: {}, total: 0, limit: 2000, offset: 0 } };
}

const noop = () => {};

/** Manages its own view state, mirroring the real shell's ownership. */
function Harness({ summary }: { summary: MeshIssuesSummary }) {
  const [viewState, setViewState] = useState<MeshIssuesViewState>(DEFAULT_MESH_ISSUES_VIEW_STATE);
  return (
    <ByNodeView
      summary={summary}
      filters={DEFAULT_MESH_ISSUES_FILTERS}
      viewState={viewState}
      setViewState={setViewState}
      sourceNames={{}}
      lastRunTime={null}
      canAct={false}
      onDismiss={noop}
      onRestore={noop}
      dismissPendingId={null}
      restorePendingId={null}
      onBulkDismiss={noop}
      onBulkRestore={noop}
      bulkPending={false}
    />
  );
}

function renderHarness(summary: MeshIssuesSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // MemoryRouter needed because NodeGroupSection now renders NodeLink, which
  // calls useNavigate() (#5002 node-links epic).
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Harness summary={summary} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ByNodeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiService.get as Mocked).mockResolvedValue(issuesResponse());
  });

  it('shows the empty banner when byNode has no entries', () => {
    renderHarness(summaryWith([]));
    expect(screen.getByText(/No nodes match the active filters/)).toBeInTheDocument();
  });

  it('pins the Mesh-wide pseudo-group first regardless of severity/count', () => {
    const { container } = renderHarness(
      summaryWith([
        nodeSummary({ nodeNum: 99, nodeName: 'BigCritical', total: 10, worstSeverity: 'critical' }),
        nodeSummary({ nodeNum: null, nodeName: null, total: 1, worstSeverity: 'info', issueTypes: ['A2b_congested_area'] }),
      ]),
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('Mesh-wide')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Mesh-wide')).toBeLessThan(text.indexOf('BigCritical'));
  });

  it('ranks remaining nodes worst-first: severity beats count', () => {
    const { container } = renderHarness(
      summaryWith([
        nodeSummary({ nodeNum: 2, nodeName: 'InfoBig', total: 20, worstSeverity: 'info' }),
        nodeSummary({ nodeNum: 1, nodeName: 'CriticalSmall', total: 1, worstSeverity: 'critical' }),
      ]),
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('CriticalSmall')).toBeLessThan(text.indexOf('InfoBig'));
  });

  it("renders each node's distinct issue types as badge pills (ruleShortId)", () => {
    renderHarness(
      summaryWith([nodeSummary({ issueTypes: ['A1_deprecated_role', 'B7_coverage_shadow'] })]),
    );
    expect(screen.getByText('A1')).toBeInTheDocument();
    expect(screen.getByText('B7')).toBeInTheDocument();
  });

  it('expanding a node row fetches its findings by nodeNum exactly once', async () => {
    renderHarness(summaryWith([nodeSummary({ nodeNum: 42, nodeName: 'Alpha' })]));

    // Chevron button expands; the name is a separate NodeLink for
    // Source-Node navigation.
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    await waitFor(() => expect(apiService.get).toHaveBeenCalledTimes(1));
    const url = (apiService.get as Mocked).mock.calls[0][0] as string;
    expect(url).toContain('nodeNum=42');
  });

  it('expanding the Mesh-wide row fetches nodeNum=none', async () => {
    renderHarness(summaryWith([nodeSummary({ nodeNum: null, nodeName: null, issueTypes: ['A2b_congested_area'] })]));

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    await waitFor(() => expect(apiService.get).toHaveBeenCalledTimes(1));
    const url = (apiService.get as Mocked).mock.calls[0][0] as string;
    expect(url).toContain('nodeNum=none');
  });

  it('does not fetch until a row is expanded', () => {
    renderHarness(summaryWith([nodeSummary()]));
    expect(apiService.get).not.toHaveBeenCalled();
  });
});
