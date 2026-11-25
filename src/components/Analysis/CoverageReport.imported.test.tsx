/**
 * @vitest-environment jsdom
 *
 * Coverage Report imported rows (#5891 P3): the Show/Hide/Only chip changes
 * the query, Show in the panel narrows to one import and its window, anonymous
 * viewers get the chip but no Import button or panel.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../contexts/authContextObject';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'km' }) }));

const useCoverageReceivers = vi.fn();
const useCoverageSenders = vi.fn();
const useCoverageReceptions = vi.fn();
vi.mock('../../hooks/useCoverageData', () => ({
  useCoverageReceivers: (...a: unknown[]) => useCoverageReceivers(...a),
  useCoverageSenders: (...a: unknown[]) => useCoverageSenders(...a),
  useCoverageReceptions: (...a: unknown[]) => useCoverageReceptions(...a),
}));
vi.mock('../../hooks/useCoverageSurveys', () => ({
  useCoverageSurveys: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}));
vi.mock('./CoverageSurveyBar', () => ({ CoverageSurveyBar: () => <div data-testid="survey-bar-stub" /> }));
vi.mock('./CoverageMap', () => ({ CoverageMap: () => <div data-testid="coverage-map-stub" /> }));
vi.mock('./CoverageSummaryPanel', () => ({ CoverageSummaryPanel: () => <div /> }));
vi.mock('./CoverageDistanceChart', () => ({ CoverageDistanceChart: () => <div /> }));
vi.mock('./CoverageExportButtons', () => ({ CoverageExportButtons: () => <div /> }));

vi.mock('../../hooks/useWalkabout', () => ({
  useWalkaboutSources: () => ({ data: [] }),
  useWalkaboutSessions: () => ({ data: [] }),
}));

const FIRST = 1_690_000_000_000;
const LAST = 1_690_500_000_000;
vi.mock('../../hooks/useCoverageImports', () => ({
  useCoverageImportSources: () => [{ id: 'a', name: 'Alpha', type: 'meshtastic_tcp' }],
  useCoverageImports: () => ({
    isLoading: false,
    imports: [{
      id: 'imp1', sourceId: 'a', sourceName: 'Alpha', kind: 'coverage_report', format: 'csv', filename: 'old.csv',
      status: 'complete', importedAt: 1_700_000_000_000, importedByMe: true, rowCount: 5, insertedCount: 5,
      duplicateCount: 0, skippedCount: 0, firstReceivedAt: FIRST, lastReceivedAt: LAST, sourceTruncated: false,
    }],
  }),
  useDeleteCoverageImport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useImportCoverageFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import CoverageReport from './CoverageReport';

function renderReport(authenticated: boolean) {
  const auth = { authStatus: { authenticated }, hasPermission: () => true };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={auth as never}>
        <CoverageReport />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1];

beforeEach(() => {
  useCoverageReceivers.mockReset().mockReturnValue({
    data: { receivers: [], retentionDays: 7, mqttSources: [] }, isLoading: false, refetch: vi.fn(),
  });
  useCoverageSenders.mockReset().mockReturnValue({ data: { senders: [], truncated: false }, isLoading: false, refetch: vi.fn() });
  useCoverageReceptions.mockReset().mockReturnValue({ data: { items: [], truncated: false }, isLoading: false, refetch: vi.fn() });
});

describe('CoverageReport imported rows', () => {
  it('shows imported rows by default and the chip changes every query', () => {
    renderReport(true);
    expect(lastCall(useCoverageReceptions)[0].imported).toBe('include');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(lastCall(useCoverageReceptions)[0].imported).toBe('exclude');
    expect(lastCall(useCoverageSenders)[0].imported).toBe('exclude');
    expect(lastCall(useCoverageReceivers)[1].imported).toBe('exclude');
    fireEvent.click(screen.getByRole('button', { name: 'Only' }));
    expect(lastCall(useCoverageReceptions)[0].imported).toBe('only');
    expect(screen.getByRole('button', { name: 'Only' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Show in the imports panel narrows to that import, its window, and reaches the receivers back', () => {
    renderReport(true);
    fireEvent.click(screen.getByRole('button', { name: /Imports/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Show old\.csv/ }));
    const rec = lastCall(useCoverageReceptions)[0];
    expect(rec.importId).toBe('imp1');
    expect(rec.imported).toBe('only');
    expect(rec.sinceMs).toBe(FIRST);
    expect(rec.untilMs).toBe(LAST + 1);
    expect(lastCall(useCoverageSenders)[0].importId).toBe('imp1');
    // The window starts long before retention, so the receivers call sends it.
    expect(lastCall(useCoverageReceivers)[1]).toEqual(expect.objectContaining({ importId: 'imp1', sinceMs: FIRST }));
  });

  it('a manual window change detaches the import', () => {
    renderReport(true);
    fireEvent.click(screen.getByRole('button', { name: /Imports/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Show old\.csv/ }));
    fireEvent.click(screen.getByRole('button', { name: '24 h' }));
    expect(lastCall(useCoverageReceptions)[0].importId).toBeUndefined();
  });

  it('leaves the receivers window out inside retention', () => {
    renderReport(true);
    expect(lastCall(useCoverageReceivers)[1].sinceMs).toBeUndefined();
  });

  it('gives an anonymous viewer the chip but no Import button or panel', () => {
    renderReport(false);
    expect(screen.getByTestId('coverage-imported-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-import-button')).toBeNull();
    expect(screen.queryByTestId('coverage-imports-panel')).toBeNull();
  });

  it('gives a signed-in writer the Import button and the panel', () => {
    renderReport(true);
    expect(screen.getByTestId('coverage-import-button')).toBeInTheDocument();
    expect(screen.getByTestId('coverage-imports-panel')).toBeInTheDocument();
  });
});
