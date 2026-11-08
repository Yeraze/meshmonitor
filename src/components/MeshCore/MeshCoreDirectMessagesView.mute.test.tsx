/**
 * @vitest-environment jsdom
 *
 * MeshCoreDirectMessagesView mute + mark-all (#6261): the toolbar bell mutes the
 * open peer by canonical pubkey, a muted row shows the indicator and no unread
 * dot, and the header button marks every unread peer read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : key;
  return createReactI18nextMock(t);
});

let authenticated = true;
vi.mock('../../contexts/AuthContext', async () => ({
  AuthContext: (await import('react')).createContext(null),
  useAuth: () => ({ hasPermission: () => true, authStatus: { authenticated } }),
}));

let muted = new Set<string>();
const muteDM = vi.fn(async (k: string) => { muted.add(k); });
const unmuteDM = vi.fn(async (k: string) => { muted.delete(k); });
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY', temperatureUnit: 'F', telemetryVisualizationHours: 48 }),
  useSettingsOptional: () => ({ linkPreviewsEnabled: false }),
  useOptionalMuteSettings: () => ({
    isChannelMuted: () => false,
    muteChannel: vi.fn(),
    unmuteChannel: vi.fn(),
    isDMMuted: (k: string) => muted.has(k),
    muteDM,
    unmuteDM,
  }),
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../TelemetryGraphs', () => ({ default: () => null }));

import { MeshCoreDirectMessagesView } from './MeshCoreDirectMessagesView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const SELF = 'f'.repeat(64);
const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const contacts: MeshCoreContact[] = [
  { publicKey: PK_A, advName: 'Alice', advType: 1 },
  { publicKey: PK_B, advName: 'Bob', advType: 1 },
];
const incoming = (id: string, from: string, ts: number) => ({
  id, fromPublicKey: from, toPublicKey: SELF, text: 'hi', timestamp: ts, messageType: 'direct',
});
const actions = {
  fetchDmMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  fetchDmPeers: vi.fn().mockResolvedValue([]),
  getRemoteAdminCapability: vi.fn().mockResolvedValue(null),
} as never;

function renderView(messages: unknown[]) {
  return render(
    <MeshCoreDirectMessagesView
      messages={messages as never}
      contacts={contacts}
      status={{ connected: true, localNode: { publicKey: SELF, name: 'self', advType: 1 } } as never}
      actions={actions}
      baseUrl=""
      sourceId="src-a"
    />,
  );
}

describe('MeshCoreDirectMessagesView mute + mark-all (#6261)', () => {
  beforeEach(() => {
    muted = new Set();
    authenticated = true;
    muteDM.mockClear();
    unmuteDM.mockClear();
    localStorage.clear();
  });

  it('mutes the open peer from the toolbar bell by pubkey', async () => {
    renderView([]);
    fireEvent.click(screen.getByText('Alice'));
    fireEvent.click(await screen.findByRole('button', { name: 'Mute notifications' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute indefinitely' }));
    await waitFor(() => expect(muteDM).toHaveBeenCalledWith(PK_A, null));
  });

  it('hides the bell for an anonymous viewer', () => {
    authenticated = false;
    renderView([]);
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.queryByRole('button', { name: 'Mute notifications' })).toBeNull();
  });

  it('shows the muted indicator and no unread dot on a muted peer', () => {
    muted.add(PK_A);
    const { container } = renderView([incoming('1', PK_A, 5000), incoming('2', PK_B, 5000)]);
    expect(screen.getAllByLabelText('Notifications muted')).toHaveLength(1);
    // Only Bob (not muted) carries the unread dot.
    expect(container.querySelectorAll('.meshcore-dm-unread-dot')).toHaveLength(1);
  });

  it('mark-all-read clears every unread peer, muted included', async () => {
    muted.add(PK_A);
    const { container } = renderView([incoming('1', PK_A, 5000), incoming('2', PK_B, 5000)]);
    fireEvent.click(screen.getByText('Mark All Read'));
    await waitFor(() => {
      const raw = JSON.parse(localStorage.getItem('meshmonitor-meshcore-dm-lastread-src-a') ?? '{}');
      expect(raw[PK_A]).toBe(5000);
      expect(raw[PK_B]).toBe(5000);
    });
    expect(container.querySelectorAll('.meshcore-dm-unread-dot')).toHaveLength(0);
    expect(screen.queryByText('Mark All Read')).toBeNull();
  });
});
