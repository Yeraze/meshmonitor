/**
 * @vitest-environment jsdom
 *
 * IssueTypeSection (#4964 report reorganization, WP4, spec §6.2/§10.5) —
 * the per-section query fires only on expand, in one request, regardless of
 * how many times the section re-renders while expanded.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import IssueTypeSection from './IssueTypeSection';
import { DEFAULT_MESH_ISSUES_FILTERS } from './grouping';
import type { MeshIssueRow, MeshIssuesResponse, MeshIssueTypeSummary } from '../meshIssueTypes';

type Mocked = ReturnType<typeof vi.fn>;

function typeSummary(overrides: Partial<MeshIssueTypeSummary> = {}): MeshIssueTypeSummary {
  return {
    issueType: 'A1_deprecated_role',
    total: 1,
    bySeverity: { critical: 0, warning: 1, info: 0 },
    worstSeverity: 'warning',
    dismissed: 0,
    latestDetected: Date.UTC(2026, 7, 20),
    ...overrides,
  };
}

function issuesResponse(issues: MeshIssueRow[]): { success: true; data: MeshIssuesResponse } {
  return {
    success: true,
    data: { issues, counts: { critical: 0, warning: issues.length, info: 0, total: issues.length, dismissed: 0 }, sourceNames: {}, total: issues.length, limit: 2000, offset: 0 },
  };
}

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const noop = () => {};

describe('IssueTypeSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fire the per-type query while collapsed', () => {
    (apiService.get as Mocked).mockResolvedValue(issuesResponse([]));
    renderWithClient(
      <IssueTypeSection
        typeSummary={typeSummary()}
        filters={DEFAULT_MESH_ISSUES_FILTERS}
        sourceNames={{}}
        expanded={false}
        onToggleExpand={noop}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(apiService.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('fires exactly one request on expand, with issueType + limit=2000', async () => {
    (apiService.get as Mocked).mockResolvedValue(
      issuesResponse([
        { id: 1, issueType: 'A1_deprecated_role', subjectKey: 'node:1', nodeNum: 1, nodeName: 'A', severity: 'warning', confidence: 'high', evidence: {}, sourceIds: [], firstDetected: 0, lastDetected: 0, status: 'open', dismissed: false, dismissedAt: null },
      ]),
    );

    renderWithClient(
      <IssueTypeSection
        typeSummary={typeSummary()}
        filters={DEFAULT_MESH_ISSUES_FILTERS}
        sourceNames={{}}
        expanded
        onToggleExpand={noop}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(apiService.get).toHaveBeenCalledTimes(1);
    const url = (apiService.get as Mocked).mock.calls[0][0] as string;
    expect(url).toContain('issueType=A1_deprecated_role');
    expect(url).toContain('limit=2000');
  });

  it('shows N new / N reopened chips only when present and non-zero', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IssueTypeSection
          typeSummary={typeSummary()}
          filters={DEFAULT_MESH_ISSUES_FILTERS}
          sourceNames={{}}
          expanded={false}
          onToggleExpand={noop}
          onSortChange={noop}
          lastRunTime={null}
          newCount={4}
          reopenedCount={0}
          canAct={false}
          onDismiss={noop}
          onRestore={noop}
          dismissPendingId={null}
          restorePendingId={null}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('4 new')).toBeInTheDocument();
    expect(screen.queryByText(/reopened/)).not.toBeInTheDocument();
  });
});
