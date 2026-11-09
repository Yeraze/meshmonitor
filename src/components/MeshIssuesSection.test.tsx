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
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, defaultValue?: string | Record<string, unknown>) => {
    if (typeof defaultValue === 'string') return defaultValue;
    if (defaultValue && typeof defaultValue === 'object' && 'defaultValue' in defaultValue) {
      return String((defaultValue as Record<string, unknown>).defaultValue);
    }
    return key;
  };
  return createReactI18nextMock(t);
});

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
  // Report reorg #4964 WP2 — resolved, sorted per-rule mute list.
  disabledRules: [] as string[],
  airUtilTxPct: 8,
  channelUtilPct: 25,
  mobileSpanMeters: 500,
  snrAsymmetryDb: 6,
  overBroadcastSeconds: 300,
  // Non-default on purpose (#4976 review): proves the saved POST body carries
  // the SERVER-provided value, not the client-side ?? 30 fallback.
  routerClusterMaxLinkKm: 15,
  // Non-default node-health tunables (#6279), distinct from every other field.
  staleHoursMeshtastic: 36,
  staleHoursMeshcore: 120,
  lowBatteryPct: 30,
  lowBatteryMv: 3400,
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
    // post-epic follow-ups) + router-cluster max link km (#4976) + the four
    // node-health tunables (#6279).
    expect(screen.getAllByText('[MeshMonitor]').length).toBe(9);
    expect(screen.getByDisplayValue('36')).toBeInTheDocument(); // staleHoursMeshtastic
    expect(screen.getByDisplayValue('120')).toBeInTheDocument(); // staleHoursMeshcore
    expect(screen.getByDisplayValue('30')).toBeInTheDocument(); // lowBatteryPct
    expect(screen.getByDisplayValue('3400')).toBeInTheDocument(); // lowBatteryMv
    expect(screen.getByText(/LiFePO4/)).toBeInTheDocument();
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
      mesh_issues_disabled_rules: '',
      mesh_issues_b7_enabled: 'true',
      mesh_issues_air_util_tx_pct: '12',
      mesh_issues_channel_util_pct: '25',
      mesh_issues_mobile_span_meters: '500',
      mesh_issues_snr_asymmetry_db: '6',
      mesh_issues_over_broadcast_seconds: '300',
      mesh_issues_auto_close_runs: '3',
      mesh_issues_router_cluster_max_link_km: '15',
      mesh_issues_stale_hours_meshtastic: '36',
      mesh_issues_stale_hours_meshcore: '120',
      mesh_issues_low_battery_pct: '30',
      mesh_issues_low_battery_mv: '3400',
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

  it('posts a changed low-battery mV and stale-hours value (#6279)', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('3400')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('3400'), { target: { value: '3200' } });
    fireEvent.change(screen.getByDisplayValue('120'), { target: { value: '72' } });
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
    const body = JSON.parse(postCall![1].body as string);
    expect(body.mesh_issues_low_battery_mv).toBe('3200');
    expect(body.mesh_issues_stale_hours_meshcore).toBe('72');
    expect(body.mesh_issues_stale_hours_meshtastic).toBe('36');
  });

  it('lists the four node-health rules under Tier A and mutes one on save (#6279)', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    for (const label of [/Stale infrastructure node/i, /without a position/i, /Low battery/i, /Impossible reported position/i]) {
      expect(screen.getByRole('checkbox', { name: label })).toBeChecked();
    }
    fireEvent.click(screen.getByRole('checkbox', { name: /Low battery/i }));
    await waitFor(() => {
      const lastCall = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
      expect(lastCall.hasChanges).toBe(true);
    });
    mockCsrfFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    const { onSave } = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
    await onSave();
    const postCall = mockCsrfFetch.mock.calls.find((c) => c[0] === '/api/settings' && c[1]?.method === 'POST');
    expect(JSON.parse(postCall![1].body as string).mesh_issues_disabled_rules).toBe('A8_low_battery');
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

  it('renders a checkbox per rule, checked (enabled) when nothing is muted (report reorg #4964 WP2)', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    // Short id + label, e.g. "B7" + "Coverage shadow" (spec §9.10).
    const b7Checkbox = screen.getByRole('checkbox', { name: /Coverage shadow/i });
    expect(b7Checkbox).toBeChecked();
    const a1Checkbox = screen.getByRole('checkbox', { name: /Deprecated role/i });
    expect(a1Checkbox).toBeChecked();
    const c2Checkbox = screen.getByRole('checkbox', { name: /Broadcasting too often/i });
    expect(c2Checkbox).toBeChecked();
  });

  it('shows a muted rule unchecked when status.thresholds.disabledRules names it', async () => {
    mockCsrfFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ...statusResponse.data,
          thresholds: { ...statusThresholds, disabledRules: ['B7_coverage_shadow'] },
        },
      }),
    });

    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    expect(screen.getByRole('checkbox', { name: /Coverage shadow/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Deprecated role/i })).toBeChecked();
  });

  it('unchecking a rule mutes it: save posts it in mesh_issues_disabled_rules', async () => {
    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: /Coverage shadow/i }));
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
    const body = JSON.parse(postCall![1].body as string);
    expect(body.mesh_issues_disabled_rules).toBe('B7_coverage_shadow');
    // TRAP (spec §5.2): muting B7 through the CSV must also flip the legacy
    // key, or resolveThresholds would never observe the mute for a fresh
    // install that has no mesh_issues_b7_enabled row at all... but more
    // importantly, un-muting later requires both keys to move together —
    // asserted in the next test.
    expect(body.mesh_issues_b7_enabled).toBe('false');
  });

  it('re-checking a muted B7 un-mutes it: save writes BOTH keys (spec §5.2 TRAP)', async () => {
    mockCsrfFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ...statusResponse.data,
          thresholds: { ...statusThresholds, b7Enabled: false, disabledRules: ['B7_coverage_shadow'] },
        },
      }),
    });

    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: /Coverage shadow/i })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: /Coverage shadow/i }));
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
    const body = JSON.parse(postCall![1].body as string);
    expect(body.mesh_issues_disabled_rules).toBe('');
    expect(body.mesh_issues_b7_enabled).toBe('true');
  });

  it('defaults to nothing muted when disabledRules is absent from status (older server)', async () => {
    mockCsrfFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ...statusResponse.data,
          thresholds: { ...statusThresholds, disabledRules: undefined },
        },
      }),
    });

    render(<MeshIssuesSection baseUrl="" />);
    await waitFor(() => expect(screen.getByDisplayValue('8')).toBeInTheDocument());

    expect(screen.getByRole('checkbox', { name: /Coverage shadow/i })).toBeChecked();
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
