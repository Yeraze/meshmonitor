/**
 * @vitest-environment jsdom
 *
 * Settings UI for the Mesh Issues Analysis scheduler (#4964, Phase 3 WP5).
 * Modeled on AutoPingSection.test.tsx: mocks useCsrfFetch/useSaveBar/ToastContainer
 * directly rather than mocking the whole api service, since the component talks
 * to `/api/analysis/mesh-issues/*` and `/api/settings` with useCsrfFetch (spec §6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import MeshIssuesSection from './MeshIssuesSection';

// Override the global i18n mock from src/test/setup.ts — that mock returns the
// key, not the English default, and these tests assert on English text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) => {
      if (typeof defaultValue === 'string') return defaultValue;
      if (defaultValue && typeof defaultValue === 'object' && 'defaultValue' in defaultValue) {
        return String((defaultValue as Record<string, unknown>).defaultValue);
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: unknown) => mockUseSaveBar(opts),
}));

const statusThresholds = {
  tierAEnabled: true,
  tierBEnabled: true,
  tierCEnabled: true,
  b7Enabled: true,
  airUtilTxPct: 8,
  channelUtilPct: 25,
  mobileSpanMeters: 500,
  snrAsymmetryDb: 6,
  overBroadcastSeconds: 300,
};

const statusResponse = {
  success: true,
  data: {
    running: true,
    inProgress: false,
    enabled: true,
    frequencyHours: 24,
    lookbackHours: 168,
    pairBucketHours: 6,
    lastRunTime: 1_700_000_000_000,
    lastRunResult: { findingCount: 12, durationMs: 4321 },
    thresholds: statusThresholds,
    lastRunResultFromStorage: false,
  },
};

describe('MeshIssuesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCsrfFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => statusResponse,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the current values from status', async () => {
    render(<MeshIssuesSection baseUrl="" />);

    expect(mockCsrfFetch).toHaveBeenCalledWith('/api/analysis/mesh-issues/status');

    await waitFor(() => {
      expect(screen.getByDisplayValue('8')).toBeInTheDocument(); // airUtilTxPct
    });
    expect(screen.getByDisplayValue('25')).toBeInTheDocument(); // channelUtilPct
    expect(screen.getByDisplayValue('500')).toBeInTheDocument(); // mobileSpanMeters
    expect(screen.getByDisplayValue('6')).toBeInTheDocument(); // snrAsymmetryDb
    expect(screen.getByDisplayValue('300')).toBeInTheDocument(); // overBroadcastSeconds

    // 12 finding(s) shown, and every threshold field carries an [official] or
    // [MeshMonitor] provenance tag (spec §9 WP5 hard acceptance).
    expect(screen.getByText(/12 finding/)).toBeInTheDocument();
    expect(screen.getAllByText('[official]').length).toBe(2);
    // 3 pre-existing MeshMonitor-judgement thresholds + auto-close (#4964
    // post-epic follow-ups).
    expect(screen.getAllByText('[MeshMonitor]').length).toBe(4);
  });

  it('defaults auto-close runs to 3 when the field is absent from status (older server, #4964 post-epic follow-ups)', async () => {
    render(<MeshIssuesSection baseUrl="" />);

    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());
    expect(screen.getByDisplayValue('3')).toBeInTheDocument(); // autoCloseRuns fallback
  });

  it('reads a non-default auto-close runs value from status.thresholds.autoCloseCleanRuns (#4964 post-epic follow-ups)', async () => {
    mockCsrfFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ...statusResponse.data,
          thresholds: { ...statusThresholds, autoCloseCleanRuns: 9 },
        },
      }),
    });

    render(<MeshIssuesSection baseUrl="" />);

    await waitFor(() => expect(screen.getByDisplayValue('9')).toBeInTheDocument());
  });

  it('marks the save bar dirty when a field changes', async () => {
    render(<MeshIssuesSection baseUrl="" />);

    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    expect(mockUseSaveBar).toHaveBeenCalledWith(expect.objectContaining({ hasChanges: false }));

    fireEvent.change(screen.getByDisplayValue('8'), { target: { value: '12' } });

    await waitFor(() => {
      const lastCall = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
      expect(lastCall.hasChanges).toBe(true);
    });
  });

  it('saves and POSTs every key as a string, then reloads status', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('8'), { target: { value: '12' } });
    await waitFor(() => {
      const lastCall = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
      expect(lastCall.hasChanges).toBe(true);
    });

    mockCsrfFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { onSave } = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
    await onSave();

    const postCall = mockCsrfFetch.mock.calls.find(
      (call) => call[0] === '/api/settings' && call[1]?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1].body as string);
    expect(body).toEqual({
      mesh_issues_enabled: 'true',
      mesh_issues_frequency_hours: '24',
      mesh_issues_lookback_hours: '168',
      mesh_issues_pair_bucket_hours: '6',
      mesh_issues_tier_a_enabled: 'true',
      mesh_issues_tier_b_enabled: 'true',
      mesh_issues_tier_c_enabled: 'true',
      mesh_issues_b7_enabled: 'true',
      mesh_issues_air_util_tx_pct: '12',
      mesh_issues_channel_util_pct: '25',
      mesh_issues_mobile_span_meters: '500',
      mesh_issues_snr_asymmetry_db: '6',
      mesh_issues_over_broadcast_seconds: '300',
      mesh_issues_auto_close_runs: '3',
    });
    expect(mockShowToast).toHaveBeenCalledWith('Settings saved', 'success');
  });

  it('posts a changed auto-close runs value (#4964 post-epic follow-ups)', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('3')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '7' } });
    await waitFor(() => {
      const lastCall = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
      expect(lastCall.hasChanges).toBe(true);
    });

    mockCsrfFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { onSave } = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
    await onSave();

    const postCall = mockCsrfFetch.mock.calls.find(
      (call) => call[0] === '/api/settings' && call[1]?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1].body as string);
    expect(body.mesh_issues_auto_close_runs).toBe('7');
  });

  it('shows an "already running" toast on a 409 from run-now', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    mockCsrfFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ success: false }) });

    fireEvent.click(screen.getByRole('button', { name: /run analysis now/i }));

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('Mesh issues analysis already running', 'warning');
    });
  });

  it('greys the inputs when the feature is disabled', async () => {
    mockCsrfFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { ...statusResponse.data, enabled: false },
      }),
    });

    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    expect(screen.getByDisplayValue('8')).toBeDisabled();
    expect(screen.getByDisplayValue('300')).toBeDisabled();
  });
});
