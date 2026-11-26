/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — "Clear stored posts & re-sync" wiring (#6579).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
const perms = { allowed: true };
vi.mock('../../contexts/AuthContext', async () => ({
  AuthContext: (await import('react')).createContext(null),
  useAuth: () => ({ hasPermission: () => perms.allowed }),
}));

const ROOM_PK = 'e'.repeat(64);
const room: MeshCoreContact = { publicKey: ROOM_PK, advName: 'Stored Room', advType: 3 };

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
    loginRoomWithSaved: vi.fn(),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    getLoginProgress: vi.fn().mockResolvedValue(null),
    cancelLogin: vi.fn().mockResolvedValue(true),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    fetchRoomMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    fetchRoomStats: vi.fn().mockResolvedValue([]),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
    clearRoomPosts: vi.fn().mockResolvedValue({
      success: true, deleted: 3, resyncQueued: false, clearedAt: Date.now(), nextAllowedAt: Date.now() + 30 * 60_000,
    }),
    ...overrides,
  };
}

function renderRooms(actions: ReturnType<typeof makeActions>, deviceType: number) {
  render(
    <MeshCoreRoomsView
      messages={[]}
      contacts={[room]}
      status={{ connected: true, deviceType } as any}
      actions={actions as any}
      baseUrl=""
      sourceId="src-1"
    />,
  );
  fireEvent.click(screen.getByText('Stored Room'));
}

const resyncButton = () => screen.queryByRole('button', { name: /clear stored posts & re-sync/i });

describe('MeshCoreRoomsView re-sync (#6579)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    perms.allowed = true;
  });

  it('on a Companion source the button clears through the action after confirming', async () => {
    const actions = makeActions();
    renderRooms(actions, 1);
    fireEvent.click(resyncButton()!);
    fireEvent.click(screen.getByRole('button', { name: /clear and re-sync/i }));
    await waitFor(() => expect(actions.clearRoomPosts).toHaveBeenCalledWith(ROOM_PK));
  });

  it('on a repeater-ingest source the button is disabled and says why', () => {
    const actions = makeActions();
    renderRooms(actions, 2);
    expect(resyncButton()).toBeDisabled();
    expect(screen.getByText(/only a companion radio keeps a room contact/i)).toBeTruthy();
  });

  it('is not shown without write permission', () => {
    perms.allowed = false;
    renderRooms(makeActions(), 1);
    expect(resyncButton()).toBeNull();
  });

  it('shows the cooldown from the stored clear time', async () => {
    const actions = makeActions({
      getRoomSyncConfig: vi.fn().mockResolvedValue({
        enabled: false, intervalMinutes: 60, failureCount: 0, lastError: null,
        lastClearAt: Date.now() - 5 * 60_000, clearCooldownMs: 30 * 60_000,
      }),
    });
    renderRooms(actions, 1);
    expect(await screen.findByText(/available again in 25 min/i)).toBeTruthy();
    expect(resyncButton()).toBeDisabled();
  });
});
