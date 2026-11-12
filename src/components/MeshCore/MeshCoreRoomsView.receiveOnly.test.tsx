/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — receive-only gating (#4547 Phase 2 WP3).
 *
 * Opening a room never logs in by itself (4.17.3 review M10): a login is an RF
 * send, so only the explicit "Log in with saved password" button sends one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const ROOM_PK = 'b'.repeat(64);

function makeActions(overrides?: Record<string, unknown>) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({
      canRemember: true,
      stored: [{ publicKey: ROOM_PK }],
    }),
    loginRoomWithSaved: vi.fn().mockResolvedValue({ success: true }),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    fetchRoomMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    fetchRoomStats: vi.fn().mockResolvedValue([]),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const roomContact: MeshCoreContact = {
  publicKey: ROOM_PK,
  advName: 'Test Room',
  advType: 3,
};

describe('MeshCoreRoomsView receive-only mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables the login button and password input, with a tooltip', async () => {
    const actions = makeActions();
    render(
      <MeshCoreRoomsView
        messages={[]}
        contacts={[roomContact]}
        status={{ connected: true } as any}
        actions={actions as any}
        baseUrl=""
        sourceId="src-1"
        receiveOnly
      />,
    );
    fireEvent.click(screen.getByText('Test Room'));

    const loginBtn = await screen.findByText('Login');
    expect(loginBtn.closest('button')).toBeDisabled();
    const passwordInput = screen.getByPlaceholderText(/Password/);
    expect(passwordInput).toBeDisabled();
    expect(passwordInput).toHaveAttribute(
      'title',
      'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.',
    );
  });

  it('selecting a room with a saved password sends no login; the explicit button does (4.17.3 review M10)', async () => {
    const actions = makeActions();
    const { rerender } = render(
      <MeshCoreRoomsView
        messages={[]}
        contacts={[roomContact]}
        status={{ connected: true } as any}
        actions={actions as any}
        baseUrl=""
        sourceId="src-1"
        receiveOnly
      />,
    );

    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(actions.loginRoomWithSaved).not.toHaveBeenCalled();
    // Receive-only: the saved-password button is there but disabled.
    expect(screen.getByRole('button', { name: 'Log in with saved password' })).toBeDisabled();

    rerender(
      <MeshCoreRoomsView
        messages={[]}
        contacts={[roomContact]}
        status={{ connected: true } as any}
        actions={actions as any}
        baseUrl=""
        sourceId="src-1"
        receiveOnly={false}
      />,
    );
    // Turning receive-only off does not log in by itself either.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(actions.loginRoomWithSaved).not.toHaveBeenCalled();
    expect(actions.loginRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Log in with saved password' }));
    await waitFor(() => expect(actions.loginRoomWithSaved).toHaveBeenCalledWith(ROOM_PK, { requestId: expect.any(String) }));
    expect(actions.loginRoom).not.toHaveBeenCalled();
  });

  it('disables the send box (with a tooltip) once logged in, when receiveOnly', async () => {
    const actions = makeActions();
    const { rerender } = render(
      <MeshCoreRoomsView
        messages={[]}
        contacts={[roomContact]}
        status={{ connected: true } as any}
        actions={actions as any}
        baseUrl=""
        sourceId="src-1"
        receiveOnly={false}
      />,
    );
    fireEvent.click(screen.getByText('Test Room'));
    fireEvent.click(await screen.findByRole('button', { name: 'Log in with saved password' }));
    await waitFor(() => expect(actions.loginRoomWithSaved).toHaveBeenCalled());
    const input = await screen.findByPlaceholderText('Type a message…');
    expect(input).not.toBeDisabled();

    // Now that the room is logged in, re-render as receive-only and confirm
    // the send box gates without needing to log in again.
    rerender(
      <MeshCoreRoomsView
        messages={[]}
        contacts={[roomContact]}
        status={{ connected: true } as any}
        actions={actions as any}
        baseUrl=""
        sourceId="src-1"
        receiveOnly
      />,
    );
    const gatedInput = screen.getByPlaceholderText('Type a message…');
    expect(gatedInput).toBeDisabled();
    expect(gatedInput).toHaveAttribute(
      'title',
      'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.',
    );
  });
});
