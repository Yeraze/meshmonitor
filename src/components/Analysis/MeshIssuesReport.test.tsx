/**
 * @vitest-environment jsdom
 *
 * MeshIssuesReport — Mesh Issues Analysis findings report (#4964 Phase 1
 * WP5). Covers severity-group ordering, the empty/error/loading states, and
 * that a finding's recommendation renders once (not duplicated as an
 * evidence pill) while the remaining evidence fields render as pills.
 * Model: MqttViolationsReport.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    default: { get: vi.fn(), post: vi.fn() },
    ApiError: actual.ApiError,
  };
});

import apiService, { ApiError } from '../../services/api';
import MeshIssuesReport from './MeshIssuesReport';
import type { MeshIssueRow, MeshIssuesResponse, MeshIssuesStatus } from './meshIssueTypes';

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
    ...overrides,
  };
}

function issuesResponse(issues: MeshIssueRow[]): { success: true; data: MeshIssuesResponse } {
  const counts = { critical: 0, warning: 0, info: 0, total: issues.length };
  for (const issue of issues) counts[issue.severity]++;
  return { success: true, data: { issues, counts } };
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
      ...overrides,
    },
  };
}

describe('MeshIssuesReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Status call is non-critical for these tests; keep it resolved by default.
    (apiService.get as ReturnType<typeof vi.fn>).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([]));
    });
  });

  it('renders severity groups in critical -> warning -> info order', async () => {
    const issues = [
      issueRow({ id: 1, severity: 'info', issueType: 'A5_cosplay_router', nodeName: 'InfoNode' }),
      issueRow({ id: 2, severity: 'critical', issueType: 'A3_infra_power', nodeName: 'CritNode' }),
      issueRow({ id: 3, severity: 'warning', issueType: 'A1_deprecated_role', nodeName: 'WarnNode' }),
    ];
    (apiService.get as ReturnType<typeof vi.fn>).mockImplementation((endpoint: string) => {
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
  });

  it('shows the empty banner when there are no issues', async () => {
    renderReport();
    await waitFor(() => expect(screen.getByText(/No mesh issues detected/i)).toBeInTheDocument());
  });

  it('shows the error banner when the query rejects', async () => {
    (apiService.get as ReturnType<typeof vi.fn>).mockImplementation((endpoint: string) => {
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
    (apiService.get as ReturnType<typeof vi.fn>).mockImplementation((endpoint: string) => {
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
    expect(screen.getByText('sourceA, sourceB')).toBeInTheDocument();

    // 'recommendation' itself is never rendered as a field label.
    expect(screen.queryByText('Recommendation')).not.toBeInTheDocument();
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
    (apiService.get as ReturnType<typeof vi.fn>).mockImplementation((endpoint: string) => {
      if (endpoint.includes('/status')) return Promise.resolve(statusResponse());
      return Promise.resolve(issuesResponse([issue]));
    });

    renderReport();

    await waitFor(() => expect(screen.getByText(/ChattyNode/)).toBeInTheDocument());
    expect(screen.getByText('9.33')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });
});
