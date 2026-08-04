/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — receive-only gating (#4547 Phase 2 WP3), including the
 * auto-login latch hazard (§3.4a(a)).
 *
 * The auto-login effect sets `autoLoginAttempted.current.add(selectedRoom)`
 * (a do-not-repeat latch) BEFORE awaiting. The receiveOnly guard must sit
 * before that latch line, or turning receive-only back off would never
 * re-trigger auto-login for a room already visited once this session. The
 * "flip receiveOnly off and it fires" half of the test below is the only
 * thing that catches a guard placed after the latch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../contexts/AuthContext', () => ({
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

  it('auto-login: silently skips while receiveOnly (no call, no error) — then fires once receiveOnly is turned off (latch not poisoned)', async () => {
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

    // Let the credential-capability fetch resolve (mount effect).
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));

    // Give any (incorrectly unguarded) effect a chance to fire.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(actions.loginRoomWithSaved).not.toHaveBeenCalled();
    expect(screen.queryByText('Login failed')).not.toBeInTheDocument();

    // Flip receive-only off without touching the selection — the effect's
    // own dep array (receiveOnly included) must re-fire it.
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

    await waitFor(() => expect(actions.loginRoomWithSaved).toHaveBeenCalledWith(ROOM_PK));
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
