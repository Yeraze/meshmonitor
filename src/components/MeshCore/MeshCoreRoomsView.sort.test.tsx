/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — the Rooms list sort control (#6148).
 *
 * Display-only ordering modelled on the Channels page: Room name (default),
 * Last message, Message count, Distance, and a drag-and-drop Custom order. The
 * mode and the custom order persist per source in localStorage, so a read-only
 * viewer can sort without `settings:write`. These tests assert each mode's
 * order (including the "sink to the bottom" rules), per-source persistence, and
 * that a room joining after a custom order was saved still appears.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { roomSortModeKey, roomCustomOrderKey } from './meshcoreChannelOrder';

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

const PK_A = 'a'.repeat(64); // Zulu
const PK_B = 'b'.repeat(64); // Alpha
const PK_C = 'c'.repeat(64); // Mike

const rooms: MeshCoreContact[] = [
  { publicKey: PK_A, advName: 'Zulu', advType: 3, latitude: 10.1, longitude: 10.1 },
  { publicKey: PK_B, advName: 'Alpha', advType: 3 }, // no location, no posts
  { publicKey: PK_C, advName: 'Mike', advType: 3, latitude: 20, longitude: 20 },
];

const post = (pk: string, ts: number) =>
  ({ messageType: 'room_post', toPublicKey: pk, timestamp: ts } as any);

// A: 2 posts (last 300). C: 3 posts (last 170). B: none.
const messages = [
  post(PK_A, 100), post(PK_A, 300),
  post(PK_C, 150), post(PK_C, 160), post(PK_C, 170),
];

function makeActions() {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
    loginRoomWithSaved: vi.fn().mockResolvedValue({ success: false }),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    fetchRoomMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    fetchRoomStats: vi.fn().mockResolvedValue([]),
    forgetRoomCredential: vi.fn().mockResolvedValue(true),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
  };
}

function renderView(opts?: { sourceId?: string; localNode?: any; contacts?: MeshCoreContact[] }) {
  const actions = makeActions();
  const status: any = { connected: true };
  if (opts?.localNode) status.localNode = opts.localNode;
  const utils = render(
    <MeshCoreRoomsView
      messages={messages}
      contacts={opts?.contacts ?? rooms}
      status={status}
      actions={actions as any}
      baseUrl=""
      sourceId={opts?.sourceId ?? 'src-1'}
    />,
  );
  return { actions, ...utils };
}

/** Room names in list (DOM) order. */
function rowNames(): string[] {
  return Array.from(document.querySelectorAll('.mc-channel-row-name')).map(
    el => (el.textContent || '').trim(),
  );
}

function setMode(value: string) {
  fireEvent.change(screen.getByLabelText('Sort rooms by'), { target: { value } });
}

describe('MeshCoreRoomsView — sort control (#6148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('defaults to Room name order (alphabetical by shown name)', async () => {
    const { actions } = renderView();
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    expect(rowNames()).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('Last message puts the newest first, rooms with no posts last', async () => {
    const { actions } = renderView();
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    setMode('lastMessage');
    // Zulu last=300, Mike last=170, Alpha none → sinks.
    expect(rowNames()).toEqual(['Zulu', 'Mike', 'Alpha']);
  });

  it('Message count puts the busiest first, empty rooms last', async () => {
    const { actions } = renderView();
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    setMode('messageCount');
    // Mike 3, Zulu 2, Alpha 0 → sinks.
    expect(rowNames()).toEqual(['Mike', 'Zulu', 'Alpha']);
  });

  it('Distance puts the nearest first; no-location rooms sink, by name', async () => {
    const { actions } = renderView({ localNode: { latitude: 10, longitude: 10 } });
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    setMode('distance');
    // Zulu ~(10.1,10.1) near, Mike (20,20) far, Alpha no location → sinks.
    expect(rowNames()).toEqual(['Zulu', 'Mike', 'Alpha']);
  });

  it('disables the Distance option when the source node has no location', async () => {
    const { actions } = renderView(); // no localNode
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    const option = within(screen.getByLabelText('Sort rooms by'))
      .getByRole('option', { name: 'Distance' }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('persists the chosen mode per source', async () => {
    const { actions } = renderView({ sourceId: 'src-9' });
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    setMode('messageCount');
    expect(localStorage.getItem(roomSortModeKey('src-9'))).toBe('messageCount');
    // A different source is unaffected.
    expect(localStorage.getItem(roomSortModeKey('src-other'))).toBeNull();
  });

  it('loads a saved Custom order and appends a room that joined later', async () => {
    // Saved order names Mike then Zulu; Alpha is absent (joined later).
    localStorage.setItem(roomSortModeKey('src-c'), 'custom');
    localStorage.setItem(roomCustomOrderKey('src-c'), JSON.stringify([PK_C, PK_A]));
    const { actions } = renderView({ sourceId: 'src-c' });
    await waitFor(() => expect(actions.getRoomCredentials).toHaveBeenCalled());
    // Named rooms first in saved order; the unnamed room appends deterministically.
    expect(rowNames()).toEqual(['Mike', 'Zulu', 'Alpha']);
  });
});
