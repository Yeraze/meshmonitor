/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView unread + mute (#6261): row dot from the server's receipt
 * time, cleared on open, suppressed when muted, mark-all-read, and a post of our
 * own never leaves the room unread.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : key;
  return createReactI18nextMock(t);
});

vi.mock('../../contexts/AuthContext', async () => ({
  AuthContext: (await import('react')).createContext(null),
  useAuth: () => ({ hasPermission: () => true, authStatus: { authenticated: true } }),
}));

let muted = new Set<string>();
const muteDM = vi.fn(async (k: string) => { muted.add(k); });
vi.mock('../../contexts/SettingsContext', () => ({
  useSettingsOptional: () => undefined,
  useOptionalMuteSettings: () => ({
    isChannelMuted: () => false,
    muteChannel: vi.fn(),
    unmuteChannel: vi.fn(),
    isDMMuted: (k: string) => muted.has(k),
    muteDM,
    unmuteDM: vi.fn(),
  }),
}));

import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const ROOM_A = 'a'.repeat(64);
const ROOM_B = 'b'.repeat(64);
const rooms: MeshCoreContact[] = [
  { publicKey: ROOM_A, advName: 'Alpha Room', advType: 3 },
  { publicKey: ROOM_B, advName: 'Beta Room', advType: 3 },
];
const KEY = 'meshmonitor-meshcore-room-lastread-src-1';

function makeActions(stats: unknown[], extra: Record<string, unknown> = {}) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [{ publicKey: ROOM_A }] }),
    loginRoomWithSaved: vi.fn().mockResolvedValue({ success: true }),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    fetchRoomMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    fetchRoomStats: vi.fn().mockResolvedValue(stats),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
    ...extra,
  };
}

function renderView(actions: unknown) {
  return render(
    <MeshCoreRoomsView
      messages={[]}
      contacts={rooms}
      status={{ connected: true, localNode: { publicKey: 'f'.repeat(64) } } as never}
      actions={actions as never}
      baseUrl=""
      sourceId="src-1"
    />,
  );
}
const stat = (pk: string, latestReceivedAt: number) => ({ roomPublicKey: pk, count: 3, latest: 1, latestReceivedAt });

describe('MeshCoreRoomsView unread (#6261)', () => {
  beforeEach(() => {
    muted = new Set();
    muteDM.mockClear();
    localStorage.clear();
  });

  it('dots a room whose newest receipt is past its marker', async () => {
    const { container } = renderView(makeActions([stat(ROOM_A, 9000), stat(ROOM_B, 100)]));
    localStorage.setItem(KEY, JSON.stringify({ [ROOM_B]: 100 }));
    await waitFor(() => expect(container.querySelectorAll('.meshcore-dm-unread-dot')).toHaveLength(1));
  });

  it('shows the muted indicator instead of a dot for a muted room', async () => {
    muted.add(ROOM_A);
    const { container } = renderView(makeActions([stat(ROOM_A, 9000)]));
    await waitFor(() => expect(screen.getByLabelText('Notifications muted')).toBeTruthy());
    expect(container.querySelectorAll('.meshcore-dm-unread-dot')).toHaveLength(0);
  });

  it('opening a room marks it read', async () => {
    renderView(makeActions([stat(ROOM_A, 9000)]));
    await waitFor(() => expect(screen.getByText('Alpha Room')).toBeTruthy());
    fireEvent.click(screen.getByText('Alpha Room'));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')[ROOM_A]).toBeGreaterThanOrEqual(9000);
    });
  });

  it('mark-all-read clears every unread room, muted included', async () => {
    muted.add(ROOM_B);
    const { container } = renderView(makeActions([stat(ROOM_A, 9000), stat(ROOM_B, 8000)]));
    const btn = await screen.findByText('Mark all as Read');
    fireEvent.click(btn);
    await waitFor(() => {
      const m = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      expect(m[ROOM_A]).toBe(9000);
      expect(m[ROOM_B]).toBe(8000);
    });
    expect(container.querySelectorAll('.meshcore-dm-unread-dot')).toHaveLength(0);
  });

  it('marks the room read after our own post succeeds', async () => {
    const actions = makeActions([stat(ROOM_A, 100)]);
    renderView(actions);
    fireEvent.click(screen.getByText('Alpha Room'));
    fireEvent.click(await screen.findByRole('button', { name: 'Log in with saved password' }));
    const input = await screen.findByPlaceholderText('Type a message…');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')[ROOM_A]).toBeGreaterThan(0));
    const before = JSON.parse(localStorage.getItem(KEY) ?? '{}')[ROOM_A];
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect((actions as { sendRoomPost: ReturnType<typeof vi.fn> }).sendRoomPost).toHaveBeenCalledWith(ROOM_A, 'hello'));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')[ROOM_A]).toBeGreaterThanOrEqual(before));
  });
});
