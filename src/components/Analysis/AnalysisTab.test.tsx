/**
 * @vitest-environment jsdom
 *
 * AnalysisTab — landing page for analytical reports (#4964 Phase 1 WP5
 * addition: the Mesh Issues card; #5277 P4a WP4 addition: the Coverage
 * Report deep link). Covers that all report cards render in the grid, that
 * selecting a card swaps to its report, that the back button returns to the
 * grid, and that `/reports?report=coverage&…` opens straight to the
 * Coverage Report pre-filtered and that Back clears those params. Child
 * report components are mocked — this test is about the grid/routing
 * behavior of AnalysisTab itself, not any individual report's internals
 * (those have their own test files). `parseCoverageDeepLink` (WP1) is
 * mocked too: it lives in a separate WP1 worktree that merges before this
 * one, so the real module does not exist here — the mock below mirrors its
 * documented contract (COVERAGE_P4_SPEC.md §2a.5) closely enough to drive
 * these tests.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) =>
      typeof defaultValue === 'string' ? defaultValue : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('./SolarMonitoringReport', () => ({
  default: () => <div data-testid="solar-monitoring-report">Solar report</div>,
}));
vi.mock('./NodeInfoEnrichmentReport', () => ({
  default: () => <div data-testid="nodeinfo-enrichment-report">Enrichment report</div>,
}));
vi.mock('./MqttViolationsReport', () => ({
  default: () => <div data-testid="mqtt-violations-report">MQTT violations report</div>,
}));
vi.mock('./MeshIssuesReport', () => ({
  default: () => <div data-testid="mesh-issues-report">Mesh issues report</div>,
}));
vi.mock('./CoverageReport', () => ({
  default: ({ initialLink }: { initialLink?: { sender?: string; range?: string } }) => (
    <div data-testid="coverage-report">
      Coverage report sender:{initialLink?.sender ?? ''} range:{initialLink?.range ?? ''}
    </div>
  ),
}));

// WP1 (COVERAGE_P4_SPEC.md §2a.5) — real module lives in a separate
// worktree that merges before WP4; not present in this isolated worktree.
// Mirrors the documented contract closely enough for these tests: null
// unless report=coverage, sender/range only when they parse.
const RANGE_IDS = ['1h', '6h', '24h', '3d', '7d'];
vi.mock('../../utils/coverageDeepLink', () => ({
  parseCoverageDeepLink: (params: URLSearchParams) => {
    if (params.get('report') !== 'coverage') return null;
    const sender = params.get('sender');
    const range = params.get('range');
    return {
      sender: sender && /^(![0-9a-f]{8}|[0-9a-f]{64})$/.test(sender) ? sender : undefined,
      range: range && RANGE_IDS.includes(range) ? (range as any) : undefined,
    };
  },
}));

import AnalysisTab from './AnalysisTab';

/** Shows the current URL search string alongside AnalysisTab so tests can
 *  assert the Back button actually clears report=/sender=/range=. */
function SearchParamsProbe() {
  const [params] = useSearchParams();
  return <div data-testid="search-params">{params.toString()}</div>;
}

function renderTab(initialEntries: string[] = ['/reports']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SearchParamsProbe />
      <AnalysisTab />
    </MemoryRouter>,
  );
}

describe('AnalysisTab', () => {
  it('renders every report card, including Mesh Issues, in the grid', () => {
    renderTab();

    expect(screen.getByText('Solar Monitoring Analysis')).toBeInTheDocument();
    expect(screen.getByText('NodeInfo Enrichment')).toBeInTheDocument();
    expect(screen.getByText('ok_to_mqtt Violations')).toBeInTheDocument();
    expect(screen.getByText('Mesh Issues')).toBeInTheDocument();
    expect(screen.getByText('Coverage Report')).toBeInTheDocument();
  });

  it('clicking the Coverage Report card swaps to the report, and the back button returns to the grid', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByText('Coverage Report'));

    expect(screen.getByTestId('coverage-report')).toBeInTheDocument();
    expect(screen.queryByText('Solar Monitoring Analysis')).not.toBeInTheDocument();

    const backButton = screen.getByText('Back to reports');
    await user.click(backButton);

    expect(screen.queryByTestId('coverage-report')).not.toBeInTheDocument();
    expect(screen.getByText('Coverage Report')).toBeInTheDocument();
  });

  it('clicking the Mesh Issues card swaps to the report, and the back button returns to the grid', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByText('Mesh Issues'));

    expect(screen.getByTestId('mesh-issues-report')).toBeInTheDocument();
    expect(screen.queryByText('Solar Monitoring Analysis')).not.toBeInTheDocument();

    const backButton = screen.getByText('Back to reports');
    await user.click(backButton);

    expect(screen.queryByTestId('mesh-issues-report')).not.toBeInTheDocument();
    expect(screen.getByText('Mesh Issues')).toBeInTheDocument();
    expect(screen.getByText('Solar Monitoring Analysis')).toBeInTheDocument();
  });

  it('clicking another report card still works after the Mesh Issues addition', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByText('ok_to_mqtt Violations'));

    expect(screen.getByTestId('mqtt-violations-report')).toBeInTheDocument();
  });

  // #5277 P4a WP4 (COVERAGE_P4_SPEC.md §2a.7) — Coverage Report deep link.
  describe('coverage deep link', () => {
    it('opens straight to the Coverage Report, pre-filtered, when the URL has ?report=coverage', () => {
      renderTab(['/reports?report=coverage&sender=%21bbbbbbbb&range=24h']);

      expect(screen.getByTestId('coverage-report')).toBeInTheDocument();
      expect(screen.getByTestId('coverage-report')).toHaveTextContent('sender:!bbbbbbbb');
      expect(screen.getByTestId('coverage-report')).toHaveTextContent('range:24h');
      expect(screen.queryByText('Solar Monitoring Analysis')).not.toBeInTheDocument();
    });

    it('shows the grid, not the report, for an unrelated report= value', () => {
      renderTab(['/reports?report=solar-monitoring']);

      expect(screen.queryByTestId('coverage-report')).not.toBeInTheDocument();
      expect(screen.getByText('Coverage Report')).toBeInTheDocument();
    });

    it('shows the grid for a deep link with no sender/range (report=coverage alone still opens it, unfiltered)', () => {
      renderTab(['/reports?report=coverage']);

      expect(screen.getByTestId('coverage-report')).toBeInTheDocument();
      expect(screen.getByTestId('coverage-report')).toHaveTextContent('sender:');
      expect(screen.getByTestId('coverage-report')).toHaveTextContent('range:');
    });

    it('Back clears report=/sender=/range= so Back does not reopen the report', async () => {
      const user = userEvent.setup();
      renderTab(['/reports?report=coverage&sender=%21bbbbbbbb&range=24h']);

      expect(screen.getByTestId('coverage-report')).toBeInTheDocument();
      expect(screen.getByTestId('search-params').textContent).toContain('report=coverage');

      await user.click(screen.getByText('Back to reports'));

      expect(screen.queryByTestId('coverage-report')).not.toBeInTheDocument();
      expect(screen.getByTestId('search-params').textContent).toBe('');
    });
  });
});
