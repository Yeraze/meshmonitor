/**
 * @vitest-environment jsdom
 *
 * CoverageImportDialog (#5891 P3): writable sources only (the caller's list),
 * client size pre-check, server error list, success counts, disabled while
 * uploading.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const mutateAsync = vi.fn();
const mutation = { isPending: false };
vi.mock('../../hooks/useCoverageImports', () => ({
  useImportCoverageFile: () => ({ mutateAsync, isPending: mutation.isPending }),
}));

import { CoverageImportDialog } from './CoverageImportDialog';
import { CoverageImportUploadError } from '../../services/coverageImportApi';
import { COVERAGE_IMPORT_MAX_BYTES } from '../../utils/coverageImport';
import type { CoverageImportDto } from '../../types/coverageImport';

const SOURCES = [
  { id: 'a', name: 'Alpha', type: 'meshtastic_tcp' },
  { id: 'b', name: 'Bravo', type: 'meshcore' },
];

const dto = (over: Partial<CoverageImportDto> = {}): CoverageImportDto => ({
  id: 'i1', sourceId: 'a', kind: 'coverage_report', format: 'csv', filename: 'drive.csv', status: 'complete',
  importedAt: 1, importedByMe: true, rowCount: 10, insertedCount: 8, duplicateCount: 2, skippedCount: 0,
  firstReceivedAt: 1, lastReceivedAt: 2, sourceTruncated: false, ...over,
});

const pickFile = (file: File) =>
  fireEvent.change(screen.getByTestId('coverage-import-file'), { target: { files: [file] } });
const csv = () => new File(['a,b'], 'drive.csv', { type: 'text/csv' });

beforeEach(() => {
  mutateAsync.mockReset();
  mutation.isPending = false;
});

function open() {
  return render(<CoverageImportDialog isOpen onClose={vi.fn()} sources={SOURCES} />);
}

describe('CoverageImportDialog', () => {
  it('lists the given sources and tells the user same-instance rows are skipped', () => {
    open();
    const options = Array.from(screen.getByTestId('coverage-import-source').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Alpha', 'Bravo']);
    expect(screen.getByText(/Save a survey to keep live data/)).toBeInTheDocument();
    expect(screen.getByTestId('coverage-import-submit')).toBeDisabled();
  });

  it('refuses a file over the size cap without uploading', () => {
    open();
    const big = new File(['x'], 'big.csv');
    Object.defineProperty(big, 'size', { value: COVERAGE_IMPORT_MAX_BYTES + 1 });
    pickFile(big);
    expect(screen.getByTestId('coverage-import-error')).toHaveTextContent(/over 32 MB/);
    expect(screen.getByTestId('coverage-import-submit')).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('uploads to the chosen source and shows the counts and the truncated note', async () => {
    mutateAsync.mockResolvedValue({ import: dto({ sourceTruncated: true, skippedCount: 3 }), skipped: { protocolMismatch: 3, gapFeatures: 0 } });
    open();
    fireEvent.change(screen.getByTestId('coverage-import-source'), { target: { value: 'b' } });
    pickFile(csv());
    fireEvent.click(screen.getByTestId('coverage-import-submit'));
    await waitFor(() => expect(screen.getByTestId('coverage-import-success')).toBeInTheDocument());
    expect(mutateAsync).toHaveBeenCalledWith({ sourceId: 'b', file: expect.any(File) });
    const box = screen.getByTestId('coverage-import-success');
    expect(box).toHaveTextContent('8 rows added');
    expect(box).toHaveTextContent('2 rows already here');
    expect(box).toHaveTextContent('3 rows skipped');
    expect(screen.getByTestId('coverage-import-truncated')).toBeInTheDocument();
  });

  it('renders the first 20 row errors with row and field, and the hidden count', async () => {
    const errors = Array.from({ length: 25 }, (_, i) => ({ row: i + 2, field: i === 0 ? 'latitude' : null, message: `bad ${i}` }));
    mutateAsync.mockRejectedValue(new CoverageImportUploadError('Some rows are invalid.', 400, 'IMPORT_INVALID_ROWS', errors, 40));
    open();
    pickFile(csv());
    fireEvent.click(screen.getByTestId('coverage-import-submit'));
    const box = await screen.findByTestId('coverage-import-error');
    expect(box).toHaveTextContent('Some rows are invalid.');
    expect(box.querySelectorAll('li')).toHaveLength(20);
    expect(box).toHaveTextContent('Row 2, latitude: bad 0');
    expect(box).toHaveTextContent('Row 3: bad 1');
    expect(box).toHaveTextContent('20 more errors not shown.');
    expect(screen.queryByTestId('coverage-import-success')).toBeNull();
  });

  it('disables the controls while uploading', () => {
    mutation.isPending = true;
    open();
    pickFile(csv());
    expect(screen.getByTestId('coverage-import-submit')).toBeDisabled();
    expect(screen.getByTestId('coverage-import-source')).toBeDisabled();
    expect(screen.getByTestId('coverage-import-file')).toBeDisabled();
  });
});
