/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — forgetting a saved room-server password.
 *
 * The control has to live in the LOGIN card, not next to the auto-sync toggle
 * in the stats header: the header only renders once you are logged in, which
 * is exactly what a stale saved password prevents. That gating is what left
 * users with no way to stop the scheduler re-trying a password the room server
 * had already refused.
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

const roomContact: MeshCoreContact = {
  publicKey: ROOM_PK,
  advName: 'Test Room',
  advType: 3,
};

function makeActions(overrides?: Record<string, unknown>) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({
      canRemember: true,
      stored: [{ publicKey: ROOM_PK }],
    }),
    // Auto-login fails, so the view stays on the login card — the state a user
    // with a stale saved password is stuck in.
    loginRoomWithSaved: vi.fn().mockResolvedValue({
      success: false,
      code: 'STORED_CREDENTIAL_REJECTED',
      reason: 'rejected',
    }),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    forgetRoomCredential: vi.fn().mockResolvedValue(true),
    getRoomSyncConfig: vi.fn().mockResolvedValue({
      enabled: false,
      intervalMinutes: 60,
      failureCount: 1,
      lastError: 'rejected',
    }),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function renderView(actions: ReturnType<typeof makeActions>) {
  return render(
    <MeshCoreRoomsView
      messages={[]}
      contacts={[roomContact]}
      status={{ connected: true } as any}
      actions={actions as any}
      baseUrl=""
      sourceId="src-1"
    />,
  );
}

describe('MeshCoreRoomsView — forget saved password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the forget button while NOT logged in', async () => {
    const actions = makeActions();
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));

    expect(await screen.findByText('Forget saved password')).toBeInTheDocument();
  });

  it('explains that the room server refused the saved password', async () => {
    const actions = makeActions();
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));

    expect(
      await screen.findByText(/refused by this room server/i),
    ).toBeInTheDocument();
  });

  it('calls forgetRoomCredential and drops the button once the password is gone', async () => {
    const actions = makeActions();
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));

    fireEvent.click(await screen.findByText('Forget saved password'));

    await waitFor(() => expect(actions.forgetRoomCredential).toHaveBeenCalledWith(ROOM_PK));
    await waitFor(() =>
      expect(screen.queryByText('Forget saved password')).not.toBeInTheDocument(),
    );
  });

  it('shows no forget button for a room with no saved password', async () => {
    const actions = makeActions({
      getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
      getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    });
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));

    await screen.findByPlaceholderText(/Password/);
    expect(screen.queryByText('Forget saved password')).not.toBeInTheDocument();
  });

  it('reports repeated unanswered logins separately from a refusal', async () => {
    const actions = makeActions({
      // Silence, not a refusal — so the only "refused" wording that could
      // appear would be the stored-failure banner, which must not say that.
      loginRoomWithSaved: vi.fn().mockResolvedValue({
        success: false,
        code: 'ROOM_LOGIN_NO_REPLY',
        reason: 'no_reply',
      }),
      getRoomSyncConfig: vi.fn().mockResolvedValue({
        enabled: true,
        intervalMinutes: 60,
        failureCount: 2,
        lastError: 'no_reply',
      }),
    });
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Test Room'));

    expect(await screen.findByText(/went unanswered/i)).toBeInTheDocument();
    expect(screen.queryByText(/refused by this room server/i)).not.toBeInTheDocument();
  });
});
