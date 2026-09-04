/**
 * NodeIdentityMergeDialog (#5032).
 *
 * The dialog is a safety control, so these tests assert the safety properties
 * rather than the layout:
 *
 * - it opens on a dry run and does not merge anything by opening
 * - the per-table counts it shows are the server's, unmodified
 * - a merge that cannot be undone stays behind an explicit acknowledgement
 * - a failed merge says so and leaves the dialog open
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodeIdentityMergeDialog } from './NodeIdentityMergeDialog';
import apiService from '../services/api';
import type { MergePreview } from '../types/nodeIdentityChange';

vi.mock('../services/api', () => ({
  default: {
    previewNodeIdentityMerge: vi.fn(),
    mergeNodeIdentities: vi.fn(),
  },
}));

const OLD_NUM = 0x433d1ba4;
const NEW_NUM = 0x11223344;

function makePreview(overrides: Partial<MergePreview> = {}): MergePreview {
  return {
    sourceId: 'src-a',
    fromNodeNum: OLD_NUM,
    toNodeNum: NEW_NUM,
    fromNodeId: '!433d1ba4',
    toNodeId: '!11223344',
    entries: [
      { table: 'telemetry', column: 'nodeNum', action: 'rekey', rows: 4210 },
      { table: 'packet_log', column: 'from_node', action: 'rekey', rows: 91203 },
      {
        table: 'messages',
        column: 'id',
        action: 'dropCollision',
        rows: 2,
        note: "Same packet id held by both nodes; the surviving node's row is kept.",
      },
      { table: 'nodes', column: 'nodeNum', action: 'deleteNodeRow', rows: 1 },
    ],
    totalRowsRekeyed: 95413,
    totalRowsDropped: 3,
    journalPkCount: 40,
    undoable: true,
    undoBlockedReason: null,
    notRekeyed: [{ table: 'estimated_positions', reason: 'Global by design; regenerated on the next run.' }],
    warnings: [],
    detectionBasis: 'derivedNodeNum',
    ...overrides,
  };
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeIdentityMergeDialog
        sourceId="src-a"
        fromNodeNum={OLD_NUM}
        toNodeNum={NEW_NUM}
        fromLabel="Base Station"
        toLabel="Base Station"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

describe('NodeIdentityMergeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiService.previewNodeIdentityMerge as ReturnType<typeof vi.fn>).mockResolvedValue(makePreview());
    (apiService.mergeNodeIdentities as ReturnType<typeof vi.fn>).mockResolvedValue({
      mergeId: 'merge-1',
      plan: makePreview(),
      detectionBasis: 'derivedNodeNum',
    });
  });

  it('previews on open, and merges nothing until the operator confirms', async () => {
    renderDialog();

    await waitFor(() => expect(apiService.previewNodeIdentityMerge).toHaveBeenCalledWith('src-a', OLD_NUM, NEW_NUM));
    // Opening the dialog must never be a mutation.
    expect(apiService.mergeNodeIdentities).not.toHaveBeenCalled();

    // The counts on screen are the server's, verbatim.
    expect(await screen.findByText('4,210')).toBeInTheDocument();
    expect(screen.getByText('91,203')).toBeInTheDocument();
    expect(screen.getByText('packet_log')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('node-identity-merge-confirm'));
    await waitFor(() =>
      expect(apiService.mergeNodeIdentities).toHaveBeenCalledWith('src-a', OLD_NUM, NEW_NUM, {
        acknowledgeNoUndo: false,
      }),
    );
  });

  it('keeps an unreversible merge behind an explicit acknowledgement', async () => {
    (apiService.previewNodeIdentityMerge as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePreview({
        undoable: false,
        undoBlockedReason: 'JOURNAL_TOO_LARGE',
        warnings: ['This merge touches too many rows to record a complete undo.'],
      }),
    );
    renderDialog();

    const confirm = await screen.findByTestId('node-identity-merge-confirm');
    expect(confirm).toBeDisabled();
    // The test harness mocks react-i18next to echo the key, so assert on the key.
    expect(screen.getByText('nodes.merge_no_undo_title')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(confirm).not.toBeDisabled());

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(apiService.mergeNodeIdentities).toHaveBeenCalledWith('src-a', OLD_NUM, NEW_NUM, {
        acknowledgeNoUndo: true,
      }),
    );
  });

  it('flags a pairing that no key evidence supports', async () => {
    (apiService.previewNodeIdentityMerge as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePreview({ detectionBasis: 'manual' }),
    );
    renderDialog();

    expect(await screen.findByText('nodes.merge_unverified_title')).toBeInTheDocument();
  });

  it('reports a failed merge and stays open', async () => {
    (apiService.mergeNodeIdentities as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('A newer merge involving one of these nodes is still in place.'),
    );
    const onClose = vi.fn();
    renderDialog(onClose);

    fireEvent.click(await screen.findByTestId('node-identity-merge-confirm'));

    expect(await screen.findByRole('alert')).toHaveTextContent('newer merge');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a preview failure instead of showing an empty plan', async () => {
    (apiService.previewNodeIdentityMerge as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Admin access required'),
    );
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required');
    expect(screen.getByTestId('node-identity-merge-confirm')).toBeDisabled();
  });
});
