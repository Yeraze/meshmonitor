/**
 * Asset Tracking section (#5354): editable with settings:write, read-only
 * otherwise; saving calls PUT, turning off calls DELETE.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  setBaseUrl: vi.fn(),
}));
vi.mock('../services/api', () => ({ default: api }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      let s = String(opts?.defaultValue ?? key);
      for (const [k, v] of Object.entries(opts ?? {})) s = s.replace(`{{${k}}}`, String(v));
      return s;
    },
  }),
}));

import AssetTrackingSection from './AssetTrackingSection';

function renderSection(props: React.ComponentProps<typeof AssetTrackingSection>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssetTrackingSection {...props} />
    </QueryClientProvider>,
  );
}

describe('AssetTrackingSection (#5354)', () => {
  beforeEach(() => {
    api.get.mockReset().mockResolvedValue({
      success: true,
      data: { nodeNum: 5, rowsLast24h: 10, retentionDays: 90, estimatedRows: 900 },
    });
    api.put.mockReset().mockResolvedValue({ success: true, data: { nodeNum: 5, retentionDays: 90, updatedBy: 1, updatedAt: 1 } });
    api.delete.mockReset().mockResolvedValue({ success: true });
  });

  it('turns tracking on with the default retention', async () => {
    renderSection({ nodeNum: 5, asset: undefined, canEdit: true });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/assets/5', { retentionDays: 90 }));
    expect(await screen.findByText('About 900 rows kept')).toBeTruthy();
  });

  it('turns tracking off with DELETE', async () => {
    renderSection({ nodeNum: 5, asset: { retentionDays: 30 }, canEdit: true });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/assets/5'));
  });

  it('saves a changed retention and blocks an invalid one', async () => {
    renderSection({ nodeNum: 5, asset: { retentionDays: 30 }, canEdit: true });
    const input = screen.getByRole('spinbutton');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '400' } });
    expect(screen.getByText('Enter a whole number from 1 to 365')).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/assets/5', { retentionDays: 120 }));
  });

  it('shows "unknown" when the node has no recent data', async () => {
    api.get.mockResolvedValue({ success: true, data: { nodeNum: 5, rowsLast24h: 0, retentionDays: 30, estimatedRows: null } });
    renderSection({ nodeNum: 5, asset: { retentionDays: 30 }, canEdit: true });
    expect(await screen.findByText('Estimated rows kept: unknown')).toBeTruthy();
  });

  it('is read-only without settings:write', () => {
    renderSection({ nodeNum: 5, asset: { retentionDays: 30 }, canEdit: false });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Tracked as an asset. Keeps 30 days of telemetry.')).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('says so when a read-only node is not an asset', () => {
    renderSection({ nodeNum: 5, asset: undefined, canEdit: false });
    expect(screen.getByText('Not tracked as an asset.')).toBeTruthy();
  });
});
