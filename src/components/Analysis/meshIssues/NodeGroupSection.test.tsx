/**
 * @vitest-environment jsdom
 *
 * NodeGroupSection (#4964 report reorganization, WP5, spec §6.3/§10.5): the
 * per-node query fires only on expand; findings render as a compact list
 * reusing `FindingDetail`; the node-scope `BulkActionMenu`'s "Restore all N
 * dismissed" count is derived from the section's own fetched rows (there is
 * no `dismissed` field on `MeshIssueNodeSummary`) and only becomes non-zero
 * once those rows are in hand.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
import NodeGroupSection from './NodeGroupSection';
import { DEFAULT_MESH_ISSUES_FILTERS } from './grouping';
import type { MeshIssueNodeSummary, MeshIssueRow, MeshIssuesResponse } from '../meshIssueTypes';

type Mocked = ReturnType<typeof vi.fn>;

function nodeSummary(overrides: Partial<MeshIssueNodeSummary> = {}): MeshIssueNodeSummary {
  return {
    nodeNum: 42,
    nodeName: 'Alpha',
    total: 2,
    bySeverity: { critical: 0, warning: 2, info: 0 },
    worstSeverity: 'warning',
    issueTypes: ['A1_deprecated_role'],
    latestDetected: Date.UTC(2026, 7, 20),
    ...overrides,
  };
}

function issueRow(overrides: Partial<MeshIssueRow> = {}): MeshIssueRow {
  return {
    id: 1,
    issueType: 'A1_deprecated_role',
    subjectKey: 'node:42',
    nodeNum: 42,
    nodeName: 'Alpha',
    severity: 'warning',
    confidence: 'high',
    evidence: { roleName: 'REPEATER' },
    sourceIds: ['sourceA'],
    firstDetected: 1000,
    lastDetected: 2000,
    status: 'open',
    dismissed: false,
    dismissedAt: null,
    ...overrides,
  };
}

function issuesResponse(issues: MeshIssueRow[]): { success: true; data: MeshIssuesResponse } {
  const counts = { critical: 0, warning: 0, info: 0, total: issues.length, dismissed: issues.filter((i) => i.dismissed).length };
  for (const issue of issues) counts[issue.severity]++;
  return { success: true, data: { issues, counts, sourceNames: {}, total: issues.length, limit: 2000, offset: 0 } };
}

function renderSection(props: Partial<React.ComponentProps<typeof NodeGroupSection>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => {};
  return render(
    <QueryClientProvider client={qc}>
      <NodeGroupSection
        nodeSummary={nodeSummary()}
        filters={DEFAULT_MESH_ISSUES_FILTERS}
        sourceNames={{}}
        expanded={false}
        onToggleExpand={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
        onBulkDismiss={noop}
        onBulkRestore={noop}
        bulkPending={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('NodeGroupSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fire the per-node query while collapsed', () => {
    (apiService.get as Mocked).mockResolvedValue(issuesResponse([]));
    renderSection({ expanded: false });
    expect(apiService.get).not.toHaveBeenCalled();
  });

  it('fires exactly one request on expand, scoped to this node', async () => {
    (apiService.get as Mocked).mockResolvedValue(issuesResponse([issueRow()]));
    renderSection({ expanded: true });

    await waitFor(() => expect(apiService.get).toHaveBeenCalledTimes(1));
    const url = (apiService.get as Mocked).mock.calls[0][0] as string;
    expect(url).toContain('nodeNum=42');
  });

  it('renders each finding as a compact row reusing FindingDetail (recommendation text)', async () => {
    (apiService.get as Mocked).mockResolvedValue(
      issuesResponse([issueRow({ evidence: { roleName: 'REPEATER', recommendation: 'Consider CLIENT_BASE.' } })]),
    );
    renderSection({ expanded: true });

    await waitFor(() => expect(screen.getByText('Consider CLIENT_BASE.')).toBeInTheDocument());
  });

  it('the node-scope BulkActionMenu has no dismissed count before expansion (0 -> hidden)', () => {
    renderSection({ expanded: false, canAct: true });
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    expect(screen.queryByRole('menuitem', { name: /Restore all/ })).not.toBeInTheDocument();
    // Dismiss all uses nodeSummary.total (2), available without expansion.
    expect(screen.getByRole('menuitem', { name: 'Dismiss all 2' })).toBeInTheDocument();
  });

  it('the node-scope BulkActionMenu shows an accurate dismissed count once the section has fetched rows', async () => {
    (apiService.get as Mocked).mockResolvedValue(
      issuesResponse([issueRow({ id: 1, dismissed: false }), issueRow({ id: 2, dismissed: true })]),
    );
    renderSection({ expanded: true, canAct: true });

    await waitFor(() => expect(apiService.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions/ }));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Restore all 1 dismissed' })).toBeInTheDocument(),
    );
  });

  it('clicking dismiss on a row calls onDismiss with that row id', async () => {
    (apiService.get as Mocked).mockResolvedValue(issuesResponse([issueRow({ id: 7 })]));
    const onDismiss = vi.fn();
    renderSection({ expanded: true, canAct: true, onDismiss });

    await waitFor(() => expect(screen.getByLabelText('Dismiss')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith(7);
  });

  it('renders the Mesh-wide label and hint for the nodeNum:null pseudo-group', () => {
    renderSection({
      nodeSummary: nodeSummary({ nodeNum: null, nodeName: null, issueTypes: ['A2b_congested_area'] }),
    });
    expect(screen.getByText('Mesh-wide')).toBeInTheDocument();
  });
});
