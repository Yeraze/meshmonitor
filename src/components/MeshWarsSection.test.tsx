/**
 * @vitest-environment jsdom
 *
 * MeshWars forwarder settings. Modeled on AutoEnrichmentSection.test.tsx:
 * mocks useCsrfFetch / useSaveBar / ToastContainer directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import MeshWarsSection from './MeshWarsSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => mockCsrfFetch }));

const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

let saveBar: { hasChanges: boolean; onSave: () => Promise<void> } | null = null;
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: { hasChanges: boolean; onSave: () => Promise<void> }) => { saveBar = opts; },
}));

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async () => [
      { id: 'mc1', name: 'Base companion', type: 'meshcore' },
      { id: 'mt1', name: 'Meshtastic TCP', type: 'meshtastic_tcp' },
    ]),
  },
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sourceId: 'mc1',
    baseUrl: 'https://meshwars.com',
    apiKeySet: true,
    lastForwardAt: null,
    lastResult: null,
    forwardedCount: 0,
    skippedCount: 0,
    minForwardIntervalMs: 300_000,
    ...overrides,
  };
}

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

describe('MeshWarsSection', () => {
  beforeEach(() => {
    mockCsrfFetch.mockReset();
    mockShowToast.mockReset();
    saveBar = null;
  });

  it('lists only MeshCore sources and says what leaves the radio', async () => {
    mockCsrfFetch.mockImplementation(() => json({ success: true, data: status() }));
    render(<MeshWarsSection baseUrl="" />);

    expect(await screen.findByRole('option', { name: 'Base companion' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Meshtastic TCP' })).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/at most once every 5 minutes/);
  });

  it('never fills the key field, and saves a key only when one is typed', async () => {
    mockCsrfFetch.mockImplementation(() => json({ success: true, data: status() }));
    render(<MeshWarsSection baseUrl="" />);

    const key = await screen.findByLabelText('MeshWars API key') as HTMLInputElement;
    await waitFor(() => expect(key.placeholder).toMatch(/Saved/));
    expect(key.value).toBe('');
    expect(saveBar?.hasChanges).toBe(false);

    fireEvent.change(key, { target: { value: 'new-key' } });
    expect(saveBar?.hasChanges).toBe(true);
    await act(async () => { await saveBar!.onSave(); });

    const post = mockCsrfFetch.mock.calls.find(c => c[1]?.method === 'POST');
    expect(JSON.parse(post![1].body)).toEqual({
      meshwarsEnabled: 'true',
      meshwarsSourceId: 'mc1',
      meshwarsBaseUrl: 'https://meshwars.com',
      meshwars_api_token: 'new-key',
    });
  });

  it('shows why the last ping was not sent', async () => {
    mockCsrfFetch.mockImplementation(() => json({
      success: true,
      data: status({ lastResult: { at: 1, ok: false, repeaters: 2, error: 'HTTP 401' } }),
    }));
    render(<MeshWarsSection baseUrl="" />);
    expect(await screen.findByText(/HTTP 401/)).toBeTruthy();
  });
});
