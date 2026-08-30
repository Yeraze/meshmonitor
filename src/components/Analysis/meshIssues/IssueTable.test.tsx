/**
 * @vitest-environment jsdom
 *
 * IssueTable (#4964 report reorganization, WP4, spec §6.2/§6.5/§8/§10.5).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

// RouterClusterMap (pulled in transitively by FindingDetail for B1 rows) pulls
// BaseMap -> TilesetSelector -> SettingsContext -> i18n -> init.ts, which
// calls api.setBaseUrl at import (MeshIssuesReport.test.tsx precedent).
vi.mock('../../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../../services/api')>();
  return { __esModule: true, default: { get: vi.fn(), post: vi.fn(), setBaseUrl: vi.fn() }, ApiError: actual.ApiError };
});

import IssueTable from './IssueTable';
import type { MeshIssueRow } from '../meshIssueTypes';

function row(overrides: Partial<MeshIssueRow> = {}): MeshIssueRow {
  return {
    id: 1,
    issueType: 'B7_coverage_shadow',
    subjectKey: 'node:100',
    nodeNum: 100,
    nodeName: 'AlphaNode',
    severity: 'info',
    confidence: 'medium',
    evidence: {
      nearestRouterName: 'RouterOne',
      distanceM: 4200,
      routerObservedRangeM: 3000,
      sources: ['sourceA'],
      recommendation: 'Move closer or add a repeater.',
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

const noop = () => {};

describe('IssueTable', () => {
  it('renders the type-specific §8.2 columns for the given issueType', () => {
    render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );

    expect(screen.getByRole('columnheader', { name: /Nearest router/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Distance km/ })).toBeInTheDocument();
    expect(screen.getByText('RouterOne')).toBeInTheDocument();
    expect(screen.getByText('4.2 km')).toBeInTheDocument();
    expect(screen.getByText('AlphaNode')).toBeInTheDocument();
  });

  it('hides the sources column with <=1 source, shows it with more than 1', () => {
    const { rerender } = render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{ sourceA: 'Home' }}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: /Sources/ })).not.toBeInTheDocument();

    rerender(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{ sourceA: 'Home', sourceB: 'Remote' }}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.getByRole('columnheader', { name: /Sources/ })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('never throws on empty evidence and renders em dashes', () => {
    render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row({ evidence: {} })]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows a New chip when firstDetected >= lastRunTime, hides it otherwise', () => {
    const lastRunTime = Date.UTC(2026, 6, 15);
    const { rerender } = render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row({ firstDetected: Date.UTC(2026, 6, 20) })]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={lastRunTime}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.getByText('New')).toBeInTheDocument();

    rerender(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row({ firstDetected: Date.UTC(2026, 5, 1) })]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={lastRunTime}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it('renders a Dismissed badge for a dismissed row', () => {
    render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row({ dismissed: true })]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
  });

  it('expands a row to show FindingDetail with aria-expanded on the toggle button, not the row', () => {
    render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );

    expect(screen.queryByText('Move closer or add a repeater.')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /show details/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const row_ = toggle.closest('tr');
    expect(row_).not.toHaveAttribute('aria-expanded');

    fireEvent.click(toggle);
    expect(screen.getByText('Move closer or add a repeater.')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking a sortable header toggles sort direction, switching column uses its default direction', () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{}}
        sort={{ key: 'distanceM', dir: 'desc' }}
        onSortChange={onSortChange}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Distance km" }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'distanceM', dir: 'asc' });

    rerender(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{}}
        sort={{ key: 'distanceM', dir: 'desc' }}
        onSortChange={onSortChange}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Nearest router" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'nearestRouterName', dir: 'desc' });
  });

  it('renders dismiss/restore actions only when canAct is true', () => {
    const { rerender } = render(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    const onDismiss = vi.fn();
    rerender(
      <IssueTable
        issueType="B7_coverage_shadow"
        rows={[row()]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct
        onDismiss={onDismiss}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('renders B3 weakerDirection as the weaker endpoint name, never the raw a->b literal', () => {
    render(
      <IssueTable
        issueType="B3_asymmetric_link"
        rows={[
          row({
            issueType: 'B3_asymmetric_link',
            subjectKey: 'edge:100-200',
            evidence: {
              nodeA: { nodeNum: 100, name: 'NodeA' },
              nodeB: { nodeNum: 200, name: 'NodeB' },
              snrToA: { count: 5, meanDb: -2.5, minDb: -6, maxDb: 1 },
              snrToB: { count: 4, meanDb: -10.3, minDb: -14, maxDb: -8 },
              deltaDb: 7.8,
              weakerDirection: 'a->b',
              sources: ['sourceA'],
              recommendation: 'x',
            },
          }),
        ]}
        sourceNames={{}}
        onSortChange={noop}
        lastRunTime={null}
        canAct={false}
        onDismiss={noop}
        onRestore={noop}
        dismissPendingId={null}
        restorePendingId={null}
      />,
    );
    // weakerDirection === 'a->b' -> B is the poor listener (see
    // issueColumns.ts's weakerDirectionColumn / SnrDirections convention).
    expect(screen.getByText('NodeB')).toBeInTheDocument();
    expect(screen.queryByText('a->b')).not.toBeInTheDocument();
  });
});
