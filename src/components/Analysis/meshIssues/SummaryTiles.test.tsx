/**
 * @vitest-environment jsdom
 *
 * SummaryTiles (#4964 report reorganization, WP4, spec §6.1/§10.5).
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
}));

import SummaryTiles from './SummaryTiles';
import type { MeshIssueTypeSummary } from '../meshIssueTypes';

function typeSummary(overrides: Partial<MeshIssueTypeSummary> = {}): MeshIssueTypeSummary {
  return {
    issueType: 'B7_coverage_shadow',
    total: 582,
    bySeverity: { critical: 0, warning: 0, info: 582 },
    worstSeverity: 'info',
    dismissed: 0,
    latestDetected: Date.UTC(2026, 7, 20),
    ...overrides,
  };
}

describe('SummaryTiles', () => {
  it('renders one tile per type plus a leading All tile with the total count', () => {
    render(
      <SummaryTiles
        byType={[typeSummary(), typeSummary({ issueType: 'B3_asymmetric_link', total: 53, bySeverity: { critical: 0, warning: 53, info: 0 }, worstSeverity: 'warning' })]}
        total={635}
        activeIssueTypes={[]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^All/ })).toHaveTextContent('635');
    expect(screen.getByText('582')).toBeInTheDocument();
    expect(screen.getByText('53')).toBeInTheDocument();
    expect(screen.getByText(/Coverage shadow/)).toBeInTheDocument();
    expect(screen.getByText(/Asymmetric link/)).toBeInTheDocument();
  });

  it('marks the All tile pressed when no issueType filter is active, and the matching tile when one is', () => {
    const { rerender } = render(
      <SummaryTiles byType={[typeSummary()]} total={582} activeIssueTypes={[]} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Coverage shadow/ })).toHaveAttribute('aria-pressed', 'false');

    rerender(
      <SummaryTiles byType={[typeSummary()]} total={582} activeIssueTypes={['B7_coverage_shadow']} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Coverage shadow/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking a tile selects its type; clicking the active tile clears it', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <SummaryTiles byType={[typeSummary()]} total={582} activeIssueTypes={[]} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Coverage shadow/ }));
    expect(onSelect).toHaveBeenCalledWith('B7_coverage_shadow');

    rerender(
      <SummaryTiles byType={[typeSummary()]} total={582} activeIssueTypes={['B7_coverage_shadow']} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Coverage shadow/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('clicking the All tile clears the filter', () => {
    const onSelect = vi.fn();
    render(
      <SummaryTiles byType={[typeSummary()]} total={582} activeIssueTypes={['B7_coverage_shadow']} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows new/reopened chips only when present and non-zero', () => {
    const { rerender } = render(
      <SummaryTiles byType={[typeSummary()]} total={582} activeIssueTypes={[]} onSelect={vi.fn()} />,
    );
    expect(screen.queryByText(/new this run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reopened/)).not.toBeInTheDocument();

    rerender(
      <SummaryTiles
        byType={[typeSummary()]}
        total={582}
        activeIssueTypes={[]}
        newByType={{ B7_coverage_shadow: 12 }}
        reopenedByType={{ B7_coverage_shadow: 0 }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('12 new this run')).toBeInTheDocument();
    expect(screen.queryByText(/reopened/)).not.toBeInTheDocument();
  });
});
