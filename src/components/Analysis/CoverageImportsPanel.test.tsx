/**
 * @vitest-environment jsdom
 *
 * CoverageImportsPanel (#5891 P3): lists imports, Show hands the import to the
 * report, Delete asks first and needs the write grant, anonymous sees nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthContext } from '../../contexts/authContextObject';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const deleteAsync = vi.fn();
const state = { imports: [] as unknown[] };
vi.mock('../../hooks/useCoverageImports', () => ({
  useCoverageImportSources: () => [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }],
  useCoverageImports: () => ({ imports: state.imports, isLoading: false }),
  useDeleteCoverageImport: () => ({ mutateAsync: deleteAsync, isPending: false }),
}));

import { CoverageImportsPanel } from './CoverageImportsPanel';

const imp = (id: string, sourceId: string, over: Record<string, unknown> = {}) => ({
  id, sourceId, sourceName: sourceId === 'a' ? 'Alpha' : 'Bravo', kind: 'coverage_report', format: 'csv',
  filename: `${id}.csv`, status: 'complete', importedAt: 1_700_000_000_000, importedByMe: true, rowCount: 10,
  insertedCount: 8, duplicateCount: 2, skippedCount: 0, firstReceivedAt: 1_699_000_000_000,
  lastReceivedAt: 1_699_500_000_000, sourceTruncated: false, ...over,
});

function renderPanel(opts: { authenticated?: boolean; writable?: string[] } = {}) {
  const writable = opts.writable ?? ['a'];
  const auth = {
    authStatus: { authenticated: opts.authenticated ?? true },
    hasPermission: (_r: string, action: string, o?: { sourceId?: string }) =>
      action === 'read' || writable.includes(o?.sourceId ?? ''),
  };
  const onShow = vi.fn();
  const onDeleted = vi.fn();
  render(
    <AuthContext.Provider value={auth as never}>
      <CoverageImportsPanel selectedImportId={null} onShow={onShow} onDeleted={onDeleted} />
    </AuthContext.Provider>,
  );
  return { onShow, onDeleted };
}

beforeEach(() => {
  deleteAsync.mockReset();
  state.imports = [imp('one', 'a'), imp('two', 'b'), imp('empty', 'a', { firstReceivedAt: null, lastReceivedAt: null, insertedCount: 0 })];
});

describe('CoverageImportsPanel', () => {
  it('renders nothing for an anonymous viewer', () => {
    renderPanel({ authenticated: false });
    expect(screen.queryByTestId('coverage-imports-panel')).toBeNull();
  });

  it('lists filename, source and counts once opened', () => {
    renderPanel();
    expect(screen.queryAllByTestId('coverage-import-row')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Imports/ }));
    const rows = screen.getAllByTestId('coverage-import-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('one.csv');
    expect(rows[0]).toHaveTextContent('Alpha');
    expect(rows[0]).toHaveTextContent('8 added, 2 already here');
  });

  it('Show hands the import to the report; an import with no rows cannot be shown', () => {
    const { onShow } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Imports/ }));
    const showButtons = screen.getAllByRole('button', { name: /^Show .* on the map$/ });
    expect(showButtons[2]).toBeDisabled();
    fireEvent.click(showButtons[0]);
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', sourceId: 'a' }));
  });

  it('offers Delete only on sources the viewer may write, and confirms first', async () => {
    deleteAsync.mockResolvedValue(undefined);
    const { onDeleted } = renderPanel({ writable: ['a'] });
    fireEvent.click(screen.getByRole('button', { name: /Imports/ }));
    // one + empty are on a (writable); two is on b (read only).
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(deleteAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('coverage-import-delete-confirm')).toHaveTextContent('Delete one.csv');
    fireEvent.click(screen.getByTestId('coverage-import-delete-confirm-button'));
    await waitFor(() => expect(deleteAsync).toHaveBeenCalledWith({ sourceId: 'a', importId: 'one' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('one'));
  });

  it('shows no Delete for a read-only viewer', () => {
    renderPanel({ writable: [] });
    fireEvent.click(screen.getByRole('button', { name: /Imports/ }));
    expect(screen.queryAllByRole('button', { name: 'Delete' })).toHaveLength(0);
  });
});
