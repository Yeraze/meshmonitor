/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView shows stored posts read-only without a live login (#6332).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', async () => ({
  AuthContext: (await import('react')).createContext(null),
  useAuth: () => ({ hasPermission: () => true }),
}));

const ROOM_PK = 'e'.repeat(64);
const room: MeshCoreContact = { publicKey: ROOM_PK, advName: 'Stored Room', advType: 3 };
const post = {
  id: 'p1', fromPublicKey: 'a'.repeat(64), toPublicKey: ROOM_PK,
  text: 'saved post body', timestamp: 1000, messageType: 'room',
};

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
    loginRoomWithSaved: vi.fn(),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    getLoginProgress: vi.fn().mockResolvedValue(null),
    cancelLogin: vi.fn().mockResolvedValue(true),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    fetchRoomMessages: vi.fn().mockResolvedValue({ messages: [post], hasMore: false }),
    fetchRoomStats: vi.fn().mockResolvedValue([]),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function renderRooms(actions: ReturnType<typeof makeActions>) {
  render(
    <MeshCoreRoomsView
      messages={[]}
      contacts={[room]}
      status={{ connected: true } as any}
      actions={actions as any}
      baseUrl=""
      sourceId="src-1"
    />,
  );
  fireEvent.click(screen.getByText('Stored Room'));
}

describe('MeshCoreRoomsView read-only stored posts (#6332)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows stored posts, the banner and login controls, but no composer, when logged out', async () => {
    renderRooms(makeActions());
    expect(await screen.findByText('saved post body')).toBeTruthy();
    expect(screen.getByText(/Not logged in/)).toBeTruthy();
    expect(screen.getByText('Login')).toBeTruthy();
    expect(screen.getByPlaceholderText('Password (empty for guest)')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Type a message…')).toBeNull();
    expect(screen.queryByText('posts')).toBeNull(); // stats header is login-only
  });

  it('keeps the posts visible after a login failure and explains a no-reply timeout', async () => {
    const actions = makeActions({
      loginRoom: vi.fn().mockResolvedValue({ success: false, error: 'Room server did not answer the login', reason: 'no_reply' }),
    });
    renderRooms(actions);
    fireEvent.click(await screen.findByText('Login'));
    expect(await screen.findByText('Room server did not answer the login')).toBeTruthy();
    expect(screen.getByText(/sends no reply when it refuses a login/)).toBeTruthy();
    expect(screen.getByText('saved post body')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Type a message…')).toBeNull();
  });

  it('logged-in view shows the composer and drops the banner', async () => {
    renderRooms(makeActions());
    fireEvent.click(await screen.findByText('Login'));
    expect(await screen.findByPlaceholderText('Type a message…')).toBeTruthy();
    expect(screen.queryByText(/Not logged in/)).toBeNull();
    expect(screen.getByText('saved post body')).toBeTruthy();
  });
});
