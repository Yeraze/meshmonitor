/**
 * @vitest-environment jsdom
 *
 * MeshCoreChannelsView channel mute (#5487): a muted channel never counts as
 * unread (row dot, header total, "unread first" sort), shows a muted icon, and
 * the bell menu mutes / unmutes the active channel by MeshCore channel index.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

let authenticated = true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true, authStatus: { authenticated } }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

let muted = new Set<number>();
const muteChannel = vi.fn(async (idx: number) => { muted.add(idx); });
const unmuteChannel = vi.fn(async (idx: number) => { muted.delete(idx); });
vi.mock('../../contexts/SettingsContext', () => ({
  useOptionalChannelMuteSettings: () => ({
    isChannelMuted: (idx: number) => muted.has(idx),
    muteChannel,
    unmuteChannel,
  }),
}));

import { MeshCoreChannelsView } from './MeshCoreChannelsView';
import type { MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeActions(): MeshCoreActions {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    setDeviceName: vi.fn().mockResolvedValue(true),
    setRadioParams: vi.fn().mockResolvedValue(true),
    setCoords: vi.fn().mockResolvedValue(true),
    setAdvertLocPolicy: vi.fn().mockResolvedValue(true),
    setTelemetryModeBase: vi.fn().mockResolvedValue(true),
    setTelemetryModeLoc: vi.fn().mockResolvedValue(true),
    setTelemetryModeEnv: vi.fn().mockResolvedValue(true),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    getDefaultScope: vi.fn().mockResolvedValue(''),
    discoverRegions: vi.fn().mockResolvedValue({ regions: [] }),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
  } as unknown as MeshCoreActions;
}

function makeStatus(): ConnectionStatus {
  return {
    connected: true,
    deviceType: 1,
    deviceTypeName: 'companion',
    config: null,
    localNode: { publicKey: 'local-pubkey'.padEnd(64, '0'), name: 'self', advType: 1 },
  } as ConnectionStatus;
}

/** Public (0) is active; Town (1) and Market (2) both have unread traffic. */
function routedFetch() {
  return vi.fn((url: string) => {
    if (url.includes('/api/channels/all')) {
      return Promise.resolve(jsonResponse([
        { id: 0, name: 'Public' },
        { id: 1, name: 'Town' },
        { id: 2, name: 'Market' },
      ]));
    }
    if (url.includes('/messages/channel-counts')) {
      return Promise.resolve(jsonResponse({
        success: true,
        counts: { 0: 1, 1: 1, 2: 1 },
        latestTimestamps: { 0: 100, 1: 5000, 2: 9999 },
      }));
    }
    return Promise.resolve(jsonResponse({ success: true, data: [] }));
  });
}

function renderView() {
  return render(
    <MeshCoreChannelsView
      messages={[]}
      contacts={[]}
      status={makeStatus()}
      actions={makeActions()}
      baseUrl=""
      sourceId="src-a"
    />,
  );
}

const rowFor = (name: string) => screen.getByText(name).closest('.mc-channel-row') as HTMLElement;

describe('MeshCoreChannelsView — channel mute (#5487)', () => {
  beforeEach(() => {
    localStorage.clear();
    muted = new Set();
    authenticated = true;
    vi.clearAllMocks();
    csrfFetchMock.mockImplementation(routedFetch());
  });

  it('a muted channel shows no unread dot and is left out of the header total', async () => {
    muted = new Set([2]);
    const { container } = renderView();
    await waitFor(() => expect(rowFor('# Town').classList.contains('unread')).toBe(true));
    expect(rowFor('# Market').classList.contains('unread')).toBe(false);
    expect(container.querySelectorAll('.mc-channel-unread-dot')).toHaveLength(1);
    expect(container.querySelector('.mc-channel-unread-total')?.textContent).toBe('1');
    expect(rowFor('# Market').querySelector('[aria-label="Notifications muted"]')).toBeTruthy();
    expect(rowFor('# Town').querySelector('[aria-label="Notifications muted"]')).toBeNull();
  });

  it('"unread first" does not lift a muted channel', async () => {
    muted = new Set([2]);
    const { container } = renderView();
    await waitFor(() => expect(rowFor('# Town').classList.contains('unread')).toBe(true));
    fireEvent.click(screen.getByTitle('Show channels with unread messages first'));
    await waitFor(() => {
      const names = Array.from(container.querySelectorAll('.mc-channel-row-name')).map(n => n.textContent);
      expect(names[0]).toBe('# Town');
    });
    const names = Array.from(container.querySelectorAll('.mc-channel-row-name')).map(n => n.textContent);
    // Market (muted, newest) stays in base order behind Public.
    expect(names.indexOf('# Market')).toBeGreaterThan(names.indexOf('# Public'));
  });

  it('with every unread channel muted, no header total is shown', async () => {
    muted = new Set([1, 2]);
    const { container } = renderView();
    await waitFor(() => expect(screen.getByText('# Market')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('1 messages').length).toBe(3));
    expect(container.querySelector('.mc-channel-unread-total')).toBeNull();
    expect(container.querySelector('.mc-channel-unread-dot')).toBeNull();
  });

  it('the bell menu mutes the active channel by index, with the Meshtastic durations', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('# Town')).toBeTruthy());
    fireEvent.click(screen.getByText('# Town'));
    fireEvent.click(screen.getByLabelText('Mute notifications'));
    expect(screen.getByText(/Mute for 1 hour/)).toBeTruthy();
    expect(screen.getByText(/Mute for 1 week/)).toBeTruthy();
    expect(screen.queryByText(/Unmute/)).toBeNull();

    const before = Date.now();
    fireEvent.click(screen.getByText(/Mute for 1 hour/));
    expect(muteChannel).toHaveBeenCalledTimes(1);
    const [idx, until] = muteChannel.mock.calls[0] as unknown as [number, number];
    expect(idx).toBe(1);
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
  });

  it('offers Unmute for a muted active channel', async () => {
    muted = new Set([0]);
    renderView();
    await waitFor(() => expect(screen.getByText('# Public')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Muted — click to change'));
    fireEvent.click(screen.getByText(/Unmute/));
    expect(unmuteChannel).toHaveBeenCalledWith(0);
  });

  it('opening a muted channel still clears its last-read marker', async () => {
    muted = new Set([2]);
    renderView();
    await waitFor(() => expect(screen.getByText('# Market')).toBeTruthy());
    fireEvent.click(screen.getByText('# Market'));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('meshmonitor-meshcore-channel-lastread-src-a') ?? '{}');
      expect(stored['2']).toBeGreaterThan(0);
    });
  });

  it('hides the bell for an anonymous viewer', async () => {
    authenticated = false;
    renderView();
    await waitFor(() => expect(screen.getByText('# Town')).toBeTruthy());
    expect(screen.queryByLabelText('Mute notifications')).toBeNull();
  });
});
