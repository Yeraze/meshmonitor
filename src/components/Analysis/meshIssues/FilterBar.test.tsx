/**
 * @vitest-environment jsdom
 *
 * FilterBar (#4964 report reorganization, WP4, spec §6/§10.5).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import FilterBar from './FilterBar';
import { DEFAULT_MESH_ISSUES_FILTERS } from './grouping';
import type { MeshIssuesFilters } from '../meshIssueTypes';

describe('FilterBar', () => {
  beforeEach(() => vi.useRealTimers());

  it('toggles a severity chip and reports the change immediately (no debounce)', () => {
    const onChange = vi.fn();
    render(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Warning' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_MESH_ISSUES_FILTERS, severities: ['warning'] });
  });

  it('toggles a tier chip', () => {
    const onChange = vi.fn();
    render(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_MESH_ISSUES_FILTERS, tiers: ['B'] });
  });

  it('hides the source filter with 0 or 1 sources, shows it with more than 1', () => {
    const { rerender } = render(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{}} onChange={vi.fn()} />);
    expect(screen.queryByText('Source')).not.toBeInTheDocument();

    rerender(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{ a: 'Home' }} onChange={vi.fn()} />);
    expect(screen.queryByText('Source')).not.toBeInTheDocument();

    rerender(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{ a: 'Home', b: 'Remote' }} onChange={vi.fn()} />);
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remote' })).toBeInTheDocument();
  });

  it('debounces the search box before calling onChange', async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{}} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/Search by node name/i), { target: { value: 'Alpha' } });
    expect(onChange).not.toHaveBeenCalled();

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_MESH_ISSUES_FILTERS, q: 'Alpha' }), {
      timeout: 1000,
    });
  });

  it('toggles includeClosed / includeDismissed checkboxes', () => {
    const onChange = vi.fn();
    render(<FilterBar filters={DEFAULT_MESH_ISSUES_FILTERS} sourceNames={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /show closed/i }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_MESH_ISSUES_FILTERS, includeClosed: true });

    fireEvent.click(screen.getByRole('checkbox', { name: /show dismissed/i }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_MESH_ISSUES_FILTERS, includeDismissed: true });
  });

  it('shows Clear filters only when a filter is active, and clearing preserves issueTypes', () => {
    const onChange = vi.fn();
    const filters: MeshIssuesFilters = { ...DEFAULT_MESH_ISSUES_FILTERS };
    const { rerender } = render(<FilterBar filters={filters} sourceNames={{}} onChange={onChange} />);
    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();

    const active: MeshIssuesFilters = { ...DEFAULT_MESH_ISSUES_FILTERS, severities: ['warning'], issueTypes: ['B7_coverage_shadow'] };
    rerender(<FilterBar filters={active} sourceNames={{}} onChange={onChange} />);
    fireEvent.click(screen.getByText('Clear filters'));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_MESH_ISSUES_FILTERS, issueTypes: ['B7_coverage_shadow'] });
  });
});
