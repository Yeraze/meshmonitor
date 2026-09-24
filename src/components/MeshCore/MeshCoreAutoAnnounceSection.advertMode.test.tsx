/**
 * @vitest-environment jsdom
 *
 * MeshCoreAutoAnnounceSection — advert burst reach (zero-hop / flood). The
 * server reports the stored mode (flood for a burst saved before the field
 * existed); the section shows it, and a save sends the chosen mode.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as null | { onSave: () => Promise<void>; hasChanges: boolean } } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: { onSave: () => Promise<void>; hasChanges: boolean }) => {
    saveBarCapture.current = options;
  },
}));

import { MeshCoreAutoAnnounceSection } from './MeshCoreAutoAnnounceSection';

function mockFetch(data: Record<string, unknown>) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/automation/announce/preview')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, preview: '' }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    if (url.includes('/automation/announce') && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { lastRunAt: null } }) });
    }
    if (url.includes('/automation/announce')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

const zeroHop = () => screen.getByRole('radio', { name: 'Zero-hop (nearby nodes only)' });
const flood = () => screen.getByRole('radio', { name: 'Flood (whole mesh)' });

describe('MeshCoreAutoAnnounceSection advert mode', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
  });

  it('hides the reach choice while the advert burst is off', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch({ enabled: true, channelIndexes: [0], advertEnabled: false, advertMode: 'zero_hop' }));
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('radio', { name: 'Flood (whole mesh)' })).toBeNull();
  });

  it('shows a legacy (flood) burst as flood, with the warning', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch({ enabled: true, channelIndexes: [0], advertEnabled: true, advertMode: 'flood' }));
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(flood()).toBeChecked());
    expect(screen.getByRole('note')).toHaveTextContent(/at most once per hour per source/);
  });

  it('treats an enabled burst from an older server (no advertMode) as flood', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch({ enabled: true, channelIndexes: [0], advertEnabled: true }));
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(flood()).toBeChecked());
  });

  it('defaults a newly enabled burst to zero-hop and saves the chosen mode', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch({ enabled: true, channelIndexes: [0], advertEnabled: false, advertMode: 'zero_hop' }));
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
    const toggle = await screen.findByRole('checkbox', { name: /Send advert after each announcement/ });
    fireEvent.click(toggle);
    expect(zeroHop()).toBeChecked();

    fireEvent.click(flood());
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await act(async () => { await saveBarCapture.current!.onSave(); });

    const post = csrfFetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith('/automation/announce') && (init as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeDefined();
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body).toMatchObject({ advertEnabled: true, advertMode: 'flood' });
  });
});
