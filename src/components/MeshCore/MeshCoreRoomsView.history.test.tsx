/**
 * @vitest-environment jsdom
 *
 * MeshCoreRoomsView — room post history survives channel/DM traffic (#6186).
 *
 * The room list's post count and the selected room's thread used to be derived
 * from the shared 100-message window, so once 100 newer messages arrived on
 * other channels/DMs the counts collapsed and old posts vanished. They now come
 * from server queries (`fetchRoomStats` / `fetchRoomMessages`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    (typeof fallback === 'string' ? fallback : key);
  return createReactI18nextMock(t);
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const ROOM_PK = 'd'.repeat(64);

const rooms: MeshCoreContact[] = [
  { publicKey: ROOM_PK, advName: 'Town Square', advType: 3 },
];

// 150 channel messages fill the shared window — NONE of them are room posts.
const windowNoise = Array.from({ length: 150 }, (_, i) => ({
  id: `chan-${i}`, fromPublicKey: 'channel-1', toPublicKey: 'channel-1',
  text: `noise ${i}`, timestamp: 1000 + i, messageType: 'channel',
})) as never[];

function makeActions(fetchRoomStats: ReturnType<typeof vi.fn>, fetchRoomMessages: ReturnType<typeof vi.fn>) {
  return {
    getRoomCredentials: vi.fn().mockResolvedValue({ canRemember: true, stored: [] }),
    loginRoomWithSaved: vi.fn().mockResolvedValue({ success: false }),
    loginRoom: vi.fn().mockResolvedValue({ success: true }),
    sendRoomPost: vi.fn().mockResolvedValue(true),
    forgetRoomCredential: vi.fn().mockResolvedValue(true),
    getRoomSyncConfig: vi.fn().mockResolvedValue(null),
    setRoomSyncConfig: vi.fn().mockResolvedValue(true),
    fetchRoomStats,
    fetchRoomMessages,
  };
}

describe('MeshCoreRoomsView — history survives the window (#6186)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows the server-reported post count even when 150 newer channel messages fill the window', async () => {
    const fetchRoomStats = vi.fn().mockResolvedValue([{ roomPublicKey: ROOM_PK, count: 42, latest: 500 }]);
    const fetchRoomMessages = vi.fn().mockResolvedValue({ messages: [], hasMore: false });
    render(
      <MeshCoreRoomsView
        messages={windowNoise}
        contacts={rooms}
        status={{ connected: true } as never}
        actions={makeActions(fetchRoomStats, fetchRoomMessages) as never}
        baseUrl=""
        sourceId="src-1"
      />,
    );
    // The window alone would report 0 posts; the server query reports 42.
    await waitFor(() => {
      expect(screen.getByText('42 messages')).toBeTruthy();
    });
    expect(fetchRoomStats).toHaveBeenCalled();
  });

  it('loads the selected room backlog from the server on select', async () => {
    const fetchRoomStats = vi.fn().mockResolvedValue([{ roomPublicKey: ROOM_PK, count: 1, latest: 500 }]);
    const fetchRoomMessages = vi.fn().mockResolvedValue({ messages: [], hasMore: false });
    render(
      <MeshCoreRoomsView
        messages={windowNoise}
        contacts={rooms}
        status={{ connected: true } as never}
        actions={makeActions(fetchRoomStats, fetchRoomMessages) as never}
        baseUrl=""
        sourceId="src-1"
      />,
    );
    fireEvent.click(screen.getByText('Town Square'));
    await waitFor(() => {
      expect(fetchRoomMessages).toHaveBeenCalledWith(ROOM_PK, expect.objectContaining({ offset: 0 }));
    });
  });
});
