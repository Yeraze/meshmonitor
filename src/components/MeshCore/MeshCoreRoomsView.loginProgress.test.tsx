/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView room-server login progress and cancel (#5400).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const ROOM_PK = 'c'.repeat(64);
const room: MeshCoreContact = { publicKey: ROOM_PK, advName: 'Club Room', advType: 3 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeActions(overrides: Record<string, unknown> = {}) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
    loginRoomWithSaved: vi.fn(),
    loginRoom: vi.fn(),
    getLoginProgress: vi.fn().mockResolvedValue(null),
    cancelLogin: vi.fn().mockResolvedValue(true),
    sendRoomPost: vi.fn().mockResolvedValue(true),
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
  fireEvent.click(screen.getByText('Club Room'));
}

describe('MeshCoreRoomsView login progress (#5400)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows attempt progress with Cancel; Cancel returns to the login card without logging in', async () => {
    const login = deferred<{ success: boolean }>();
    const actions = makeActions({ loginRoom: vi.fn(() => login.promise) });
    renderRooms(actions);
    fireEvent.click(await screen.findByText('Login'));

    const progress = await screen.findByTestId('meshcore-login-progress');
    expect(progress.textContent).toContain('Sending login');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const requestId = actions.loginRoom.mock.calls[0][3].requestId;
    await waitFor(() => expect(actions.cancelLogin).toHaveBeenCalledWith(requestId));

    login.resolve({ success: true }); // a reply that raced the cancel
    expect(await screen.findByText('Login cancelled')).toBeTruthy();
    expect(screen.getByText('Login')).toBeTruthy(); // still on the login card
  });

  it('reports the server error after the retries run out', async () => {
    const actions = makeActions({
      loginRoom: vi.fn().mockResolvedValue({ success: false, error: 'Room server did not answer the login', reason: 'no_reply' }),
    });
    renderRooms(actions);
    fireEvent.click(await screen.findByText('Login'));
    expect(await screen.findByText('Room server did not answer the login')).toBeTruthy();
  });
});
