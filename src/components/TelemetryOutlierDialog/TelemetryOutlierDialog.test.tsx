/**
 * @vitest-environment jsdom
 *
 * TelemetryOutlierDialog (#5333): preview → explicit confirm → purge, with the
 * preview's cutoffId + fingerprint sent back; input validation; stale-preview
 * handling; sweep mode's source/metric pickers.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { OutlierPreview } from '../../utils/telemetryOutliers';

vi.mock('../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../services/api')>();
  return {
    __esModule: true,
    default: {
      previewTelemetryOutliers: vi.fn(),
      purgeTelemetryOutliers: vi.fn(),
      getTelemetryOutlierTypes: vi.fn(),
    },
    ApiError: actual.ApiError,
  };
});

import api, { ApiError } from '../../services/api';
import TelemetryOutlierDialog from './TelemetryOutlierDialog';

const mockApi = api as unknown as {
  previewTelemetryOutliers: ReturnType<typeof vi.fn>;
  purgeTelemetryOutliers: ReturnType<typeof vi.fn>;
  getTelemetryOutlierTypes: ReturnType<typeof vi.fn>;
};

function makePreview(overrides: Partial<OutlierPreview> = {}): OutlierPreview {
  return {
    sourceId: 'src-a',
    telemetryType: 'temperature',
    nodeId: '!abcd',
    criteria: { auto: true, k: 6, min: null, max: null },
    cutoffId: 42,
    fingerprint: 'deadbeef',
    rowsScanned: 21,
    nodesScanned: 1,
    affectedCount: 1,
    nodesAffected: 1,
    removedMin: 1000,
    removedMax: 1000,
    median: 20,
    mad: 0.5,
    scaleKind: 'mad',
    nodesTooFew: 0,
    nodesFlat: 0,
    points: [{ id: 7, nodeId: '!abcd', value: 1000, timestamp: 1_760_000_000_000, reason: 'auto' }],
    pointsTruncated: false,
    nodes: [],
    ...overrides,
  };
}

function renderNodeMode(onPurged = vi.fn()) {
  render(
    <TelemetryOutlierDialog
      isOpen
      onClose={vi.fn()}
      sourceId="src-a"
      telemetryType="temperature"
      nodeId="!abcd"
      onPurged={onPurged}
    />,
  );
  return { onPurged };
}

describe('TelemetryOutlierDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('previews, then deletes only after the explicit confirm, passing the preview cutoff + fingerprint', async () => {
    mockApi.previewTelemetryOutliers.mockResolvedValue(makePreview());
    mockApi.purgeTelemetryOutliers.mockResolvedValue({ deletedCount: 1, nodesAffected: 1 });
    const { onPurged } = renderNodeMode();

    fireEvent.click(screen.getByText('telemetry_outliers.preview_button'));
    await screen.findByTestId('outlier-preview');

    expect(mockApi.previewTelemetryOutliers).toHaveBeenCalledWith({
      sourceId: 'src-a',
      telemetryType: 'temperature',
      nodeId: '!abcd',
      auto: true,
      k: 6,
      min: null,
      max: null,
    });
    // The flagged point is listed.
    expect(screen.getByText('1000')).toBeInTheDocument();
    expect(screen.getByText('telemetry_outliers.reason_auto')).toBeInTheDocument();

    // Step 1 of delete only asks; nothing is purged yet.
    fireEvent.click(screen.getByText('telemetry_outliers.delete_button'));
    expect(mockApi.purgeTelemetryOutliers).not.toHaveBeenCalled();
    expect(screen.getByText('telemetry_outliers.confirm_text')).toBeInTheDocument();

    fireEvent.click(screen.getByText('telemetry_outliers.confirm_button'));
    await screen.findByText('telemetry_outliers.done');
    expect(mockApi.purgeTelemetryOutliers).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', nodeId: '!abcd', cutoffId: 42, fingerprint: 'deadbeef' }),
    );
    expect(onPurged).toHaveBeenCalledWith(1);
  });

  it('cancelling the confirm deletes nothing', async () => {
    mockApi.previewTelemetryOutliers.mockResolvedValue(makePreview());
    renderNodeMode();
    fireEvent.click(screen.getByText('telemetry_outliers.preview_button'));
    await screen.findByTestId('outlier-preview');
    fireEvent.click(screen.getByText('telemetry_outliers.delete_button'));
    fireEvent.click(screen.getByText('telemetry_outliers.cancel'));
    expect(mockApi.purgeTelemetryOutliers).not.toHaveBeenCalled();
    expect(screen.getByText('telemetry_outliers.delete_button')).toBeInTheDocument();
  });

  it('offers no delete when the preview finds nothing, and explains a flat series', async () => {
    mockApi.previewTelemetryOutliers.mockResolvedValue(
      makePreview({ affectedCount: 0, points: [], removedMin: null, removedMax: null, scaleKind: 'flat' }),
    );
    renderNodeMode();
    fireEvent.click(screen.getByText('telemetry_outliers.preview_button'));
    await screen.findByText('telemetry_outliers.none_found');
    expect(screen.getByText('telemetry_outliers.skipped_flat')).toBeInTheDocument();
    expect(screen.queryByText('telemetry_outliers.delete_button')).not.toBeInTheDocument();
  });

  it('editing a setting after the preview throws the preview away', async () => {
    mockApi.previewTelemetryOutliers.mockResolvedValue(makePreview());
    renderNodeMode();
    fireEvent.click(screen.getByText('telemetry_outliers.preview_button'));
    await screen.findByTestId('outlier-preview');
    fireEvent.change(screen.getByLabelText('telemetry_outliers.max_label'), { target: { value: '50' } });
    expect(screen.queryByTestId('outlier-preview')).not.toBeInTheDocument();
    expect(screen.queryByText('telemetry_outliers.delete_button')).not.toBeInTheDocument();
  });

  it('blocks preview on invalid input: k out of range, min >= max, no criteria', () => {
    renderNodeMode();
    const preview = () => screen.getByText('telemetry_outliers.preview_button');

    fireEvent.change(screen.getByLabelText('telemetry_outliers.k_label'), { target: { value: '50' } });
    expect(screen.getByText('telemetry_outliers.invalid_k')).toBeInTheDocument();
    expect(preview()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('telemetry_outliers.k_label'), { target: { value: '6' } });

    fireEvent.change(screen.getByLabelText('telemetry_outliers.min_label'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('telemetry_outliers.max_label'), { target: { value: '5' } });
    expect(screen.getByText('telemetry_outliers.invalid_bounds')).toBeInTheDocument();
    expect(preview()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('telemetry_outliers.min_label'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('telemetry_outliers.max_label'), { target: { value: '' } });

    fireEvent.click(screen.getByLabelText('telemetry_outliers.auto_label'));
    expect(screen.getByText('telemetry_outliers.no_criteria')).toBeInTheDocument();
    expect(preview()).toBeDisabled();

    // Bounds-only is valid.
    fireEvent.change(screen.getByLabelText('telemetry_outliers.max_label'), { target: { value: '60' } });
    expect(preview()).not.toBeDisabled();
    expect(mockApi.previewTelemetryOutliers).not.toHaveBeenCalled();
  });

  it('a 409 on delete sends the user back to re-preview', async () => {
    mockApi.previewTelemetryOutliers.mockResolvedValue(makePreview());
    mockApi.purgeTelemetryOutliers.mockRejectedValue(new ApiError('stale', 409, { code: 'PREVIEW_STALE' }));
    const { onPurged } = renderNodeMode();
    fireEvent.click(screen.getByText('telemetry_outliers.preview_button'));
    await screen.findByTestId('outlier-preview');
    fireEvent.click(screen.getByText('telemetry_outliers.delete_button'));
    fireEvent.click(screen.getByText('telemetry_outliers.confirm_button'));
    await screen.findByText('telemetry_outliers.stale');
    expect(screen.queryByTestId('outlier-preview')).not.toBeInTheDocument();
    expect(onPurged).not.toHaveBeenCalled();
  });

  it('sweep mode: loads the source\'s metrics and previews without a nodeId', async () => {
    mockApi.getTelemetryOutlierTypes.mockResolvedValue(['temperature', 'voltage']);
    mockApi.previewTelemetryOutliers.mockResolvedValue(
      makePreview({ nodeId: null, median: null, scaleKind: null, nodesScanned: 3, nodesAffected: 1 }),
    );
    render(
      <TelemetryOutlierDialog
        isOpen
        onClose={vi.fn()}
        sourceId="src-a"
        sources={[{ id: 'src-a', name: 'Alpha' }, { id: 'src-b', name: 'Beta' }]}
      />,
    );

    await waitFor(() => expect(mockApi.getTelemetryOutlierTypes).toHaveBeenCalledWith('src-a'));
    const preview = screen.getByText('telemetry_outliers.preview_button');
    expect(preview).toBeDisabled(); // no metric picked yet

    fireEvent.change(await screen.findByLabelText('telemetry_outliers.metric_label'), {
      target: { value: 'voltage' },
    });
    fireEvent.click(preview);
    await screen.findByText('telemetry_outliers.summary_sweep');

    const req = mockApi.previewTelemetryOutliers.mock.calls[0][0];
    expect(req).toMatchObject({ sourceId: 'src-a', telemetryType: 'voltage' });
    expect(req).not.toHaveProperty('nodeId');

    fireEvent.change(screen.getByLabelText('telemetry_outliers.source_label'), { target: { value: 'src-b' } });
    await waitFor(() => expect(mockApi.getTelemetryOutlierTypes).toHaveBeenCalledWith('src-b'));
  });
});
