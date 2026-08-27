/**
 * MeshCoreSettingsView — receive-only toggle (#4547 Phase 2 WP2).
 *
 * Covers: the toggle renders and reflects the threaded `receiveOnly` prop
 * (not local state), confirm-on-disable-only, the save/invalidate/toast
 * path, and the button gating owned by this package (Send advert, Discover
 * x3, Discover regions — with Refresh contacts and Save scope left enabled
 * as the negative control, per spec §5.1/§5.2).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreSettingsView } from './MeshCoreSettingsView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const base = typeof fallback === 'string' ? fallback : key;
      const vars = (typeof fallback === 'object' ? fallback : opts) ?? {};
      return base.replace(/\{\{(\w+)\}\}/g, (_m, k) => String((vars as Record<string, unknown>)[k] ?? ''));
    },
  }),
}));

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  invalidateQueries: vi.fn(),
  csrfFetch: vi.fn(),
}));

vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));
// Not under test; it fetches on mount.
vi.mock('./MeshCoreNodeDisplaySection', () => ({
  MeshCoreNodeDisplaySection: () => null,
}));

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    discoverNodes: vi.fn().mockResolvedValue({ returned: 0, newCount: 0, nodes: [] }),
    getDiscoverable: vi.fn().mockResolvedValue(false),
    setDiscoverable: vi.fn().mockResolvedValue(true),
    getDefaultScope: vi.fn().mockResolvedValue(''),
    getDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    setDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    setDefaultScope: vi.fn().mockResolvedValue('region-x'),
    discoverRegions: vi.fn().mockResolvedValue(null),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
    addSavedRegion: vi.fn().mockResolvedValue(true),
    deleteSavedRegion: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    purgeAllMessages: vi.fn().mockResolvedValue(true),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as never;
}

function renderView(receiveOnly: boolean, overrides: Record<string, unknown> = {}) {
  render(
    <MeshCoreSettingsView
      status={{ connected: true, deviceType: 1 } as never}
      loading={false}
      actions={makeActions(overrides)}
      baseUrl=""
      sourceId="src-a"
      receiveOnly={receiveOnly}
    />,
  );
}

const TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';

beforeEach(() => {
  vi.clearAllMocks();
  h.csrfFetch.mockResolvedValue({ ok: true });
});

describe('MeshCoreSettingsView — receive-only toggle rendering', () => {
  it('renders unchecked and reflects false when receiveOnly is false', () => {
    renderView(false);
    const checkbox = screen.getByRole('checkbox', { name: /Strict receive-only/i });
    expect(checkbox).not.toBeChecked();
  });

  it('renders checked when receiveOnly is true — reads the threaded prop, not local state', () => {
    renderView(true);
    const checkbox = screen.getByRole('checkbox', { name: /Strict receive-only/i });
    expect(checkbox).toBeChecked();
  });
});

describe('MeshCoreSettingsView — receive-only button gating', () => {
  it('disables Send advert, Discover x3 and Discover regions, all with the control tooltip', () => {
    renderView(true);

    const gated = [
      screen.getByRole('button', { name: 'Send advert' }),
      screen.getByRole('button', { name: 'Discover Nearby Nodes' }),
      screen.getByRole('button', { name: 'Discover Repeaters' }),
      screen.getByRole('button', { name: 'Discover Sensors' }),
      screen.getByRole('button', { name: 'Discover regions from repeaters' }),
    ];
    for (const btn of gated) {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', TOOLTIP);
    }
  });

  it('leaves Refresh contacts and Save scope enabled — the negative control', () => {
    renderView(true);

    expect(screen.getByRole('button', { name: 'Refresh contacts' })).not.toBeDisabled();
    // Save scope is disabled by its own dirty-check (scopeInput === defaultScope
    // on mount), never by receiveOnly — assert it carries no receive-only tooltip.
    const saveScope = screen.getByRole('button', { name: 'Save' });
    expect(saveScope).not.toHaveAttribute('title', TOOLTIP);
  });

  it('enables every gated button again once receiveOnly flips back to false', () => {
    renderView(false);

    const gated = [
      screen.getByRole('button', { name: 'Send advert' }),
      screen.getByRole('button', { name: 'Discover Nearby Nodes' }),
      screen.getByRole('button', { name: 'Discover Repeaters' }),
      screen.getByRole('button', { name: 'Discover Sensors' }),
      screen.getByRole('button', { name: 'Discover regions from repeaters' }),
    ];
    for (const btn of gated) {
      expect(btn).not.toBeDisabled();
    }
  });

  it('renders the paused note under the discoverable toggle only while receive-only', () => {
    renderView(true);
    expect(screen.getByRole('status')).toHaveTextContent(/Paused — receive-only mode/);
  });

  it('does not render the paused note when receiveOnly is false', () => {
    renderView(false);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('MeshCoreSettingsView — toggle save / invalidate path (#4547 Phase 2 WP2 §5.2)', () => {
  it('checking the box does not call window.confirm and POSTs { meshcoreReceiveOnly: true }', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    renderView(false);

    await user.click(screen.getByRole('checkbox', { name: /Strict receive-only/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalledTimes(1));
    const [url, opts] = h.csrfFetch.mock.calls[0];
    expect(url).toBe('/api/settings?sourceId=src-a');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ meshcoreReceiveOnly: true });
    confirmSpy.mockRestore();
  });

  it('a successful save invalidates the ["txStatus"] query key and toasts success', async () => {
    const user = userEvent.setup();
    renderView(false);

    await user.click(screen.getByRole('checkbox', { name: /Strict receive-only/i }));

    await waitFor(() => expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['txStatus'] }));
    expect(h.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Receive-only mode enabled/),
      'success',
    );
  });

  it('unchecking calls window.confirm; accepting POSTs { meshcoreReceiveOnly: false }', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderView(true);

    await user.click(screen.getByRole('checkbox', { name: /Strict receive-only/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalledTimes(1));
    const [, opts] = h.csrfFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ meshcoreReceiveOnly: false });
    confirmSpy.mockRestore();
  });

  it('unchecking, when confirm is declined, makes no network call and the checkbox stays checked', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderView(true);

    const checkbox = screen.getByRole('checkbox', { name: /Strict receive-only/i });
    await user.click(checkbox);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.csrfFetch).not.toHaveBeenCalled();
    // receiveOnly is server-truth via the prop, unchanged (still true) → still checked.
    expect(checkbox).toBeChecked();
    confirmSpy.mockRestore();
  });

  it('a non-ok save shows the save_failed error toast and does not invalidate', async () => {
    h.csrfFetch.mockResolvedValue({ ok: false, status: 500 });
    const user = userEvent.setup();
    renderView(false);

    await user.click(screen.getByRole('checkbox', { name: /Strict receive-only/i }));

    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to change receive-only mode/),
      'error',
    ));
    expect(h.invalidateQueries).not.toHaveBeenCalled();
  });

  it('a non-ok save (400, with a json body) toasts the error, does not invalidate, and leaves the checkbox not claiming the new state', async () => {
    h.csrfFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ success: false, error: 'Invalid request', code: 'VALIDATION_ERROR' }),
    });
    const user = userEvent.setup();
    renderView(false);

    const checkbox = screen.getByRole('checkbox', { name: /Strict receive-only/i });
    await user.click(checkbox);

    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to change receive-only mode/),
      'error',
    ));
    expect(h.invalidateQueries).not.toHaveBeenCalled();
    // receiveOnly is server-truth via the prop, not local state — a failed
    // save must not leave the checkbox claiming the toggled (unpersisted)
    // state. Since the prop never changed (still false), the box must still
    // read unchecked.
    expect(checkbox).not.toBeChecked();
  });
});
