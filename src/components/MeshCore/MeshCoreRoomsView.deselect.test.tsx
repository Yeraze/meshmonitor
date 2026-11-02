/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — click the selected Room Server to de-select it (#6149).
 *
 * On desktop a second click on the already-open room returns to the landing
 * pane. On mobile the list IS the landing view, so a tap on the same row must
 * REOPEN the room, never de-select it. De-selecting clears the login/sync form
 * state but keeps `loggedInRooms` (it is a view change, not a logout), and it
 * must NOT re-read the sync config (there is no selected room).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) => {
    if (typeof fallback === 'string') return fallback;
    return key;
  };
  return createReactI18nextMock(t);
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const ROOM_PK = 'b'.repeat(64);
const roomContact: MeshCoreContact = { publicKey: ROOM_PK, advName: 'Test Room', advType: 3 };

const LANDING = 'Select a room server to view posts';

function makeActions(overrides?: Record<string, unknown>) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
    loginRoomWithSaved: vi.fn().mockResolvedValue({ success: false }),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    forgetRoomCredential: vi.fn().mockResolvedValue(true),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
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

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** Click the room's row in the LIST pane. The name also appears in the login
 *  card / stats header / mobile back title, so target the row by its class to
 *  stay unambiguous. */
function clickRoomRow() {
  const row = document.querySelector('.mc-channel-row');
  if (!row) throw new Error('no room row rendered');
  fireEvent.click(row);
}

describe('MeshCoreRoomsView — click-to-deselect (#6149)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport(1024); // desktop by default
  });
  afterEach(() => setViewport(1024));

  it('desktop: a second click on the selected room returns to the landing pane', async () => {
    const actions = makeActions();
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());

    // Landing pane is shown before anything is selected.
    expect(screen.getByText(LANDING)).toBeInTheDocument();

    // First click selects — the login card (password field) replaces the landing.
    clickRoomRow();
    await screen.findByPlaceholderText(/Password/);
    expect(screen.queryByText(LANDING)).not.toBeInTheDocument();
    expect(actions.getRoomSyncConfig).toHaveBeenCalledTimes(1);

    // Second click on the SAME row de-selects and returns to the landing pane.
    clickRoomRow();
    expect(await screen.findByText(LANDING)).toBeInTheDocument();
    // De-select must NOT re-read the sync config.
    expect(actions.getRoomSyncConfig).toHaveBeenCalledTimes(1);
  });

  it('desktop: de-select clears the login form but keeps the logged-in session', async () => {
    // Auto-login with a saved credential succeeds, so the room is logged in.
    const actions = makeActions({
      getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [{ publicKey: ROOM_PK }] }),
      loginRoomWithSaved: vi.fn().mockResolvedValue({ success: true }),
    });
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());

    // Select → auto-login → the stats header proves we are logged in.
    clickRoomRow();
    await waitFor(() => expect(document.querySelector('.meshcore-room-stats-header')).toBeTruthy());
    expect(actions.loginRoomWithSaved).toHaveBeenCalledTimes(1);

    // De-select → landing pane (stats header gone).
    clickRoomRow();
    expect(await screen.findByText(LANDING)).toBeInTheDocument();
    expect(document.querySelector('.meshcore-room-stats-header')).toBeNull();

    // Re-select → still logged in (stats header returns) with NO second login:
    // loggedInRooms was preserved across the de-select.
    clickRoomRow();
    await waitFor(() => expect(document.querySelector('.meshcore-room-stats-header')).toBeTruthy());
    expect(actions.loginRoomWithSaved).toHaveBeenCalledTimes(1);
  });

  it('mobile: a second tap on the same row REOPENS the room, never de-selects', async () => {
    setViewport(500); // mobile
    const actions = makeActions();
    renderView(actions);
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());

    clickRoomRow();
    await screen.findByPlaceholderText(/Password/);

    // Tap the same row again — mobile keeps the room open (landing never shown).
    clickRoomRow();
    expect(screen.queryByText(LANDING)).not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/Password/)).toBeInTheDocument();
  });
});
