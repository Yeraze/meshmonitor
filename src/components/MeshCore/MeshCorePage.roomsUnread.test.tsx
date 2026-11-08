/**
 * @vitest-environment jsdom
 *
 * MeshCorePage wires room unread and DM/room mute into the sidebar (#6261):
 * the Rooms dot comes from `useMeshCoreUnread().rooms`, and the page passes the
 * DM mute predicate into the hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));
vi.mock('./hooks/useMeshCore', () => ({
  useMeshCore: () => ({
    status: { connected: true, deviceType: 1 },
    nodes: [], contacts: [], messages: [], loading: false, hasLoadedOnce: true, error: null,
    actions: { clearError: vi.fn(), syncDeviceTime: vi.fn() },
  }),
  ConnectionStatus: {},
}));
vi.mock('../../hooks/useMeshCoreFilters', () => ({
  useMeshCoreIgnoredNodes: () => ({ data: [] }),
  useHiddenMeshCoreKeys: () => new Set(),
  useSetMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
  useRemoveMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
}));

const isDMMuted = vi.fn(() => false);
const unreadHook = vi.fn((_: { isDMMuted?: unknown }) => ({ channels: false, dms: false, rooms: true }));
vi.mock('./hooks/useMeshCoreUnread', () => ({ useMeshCoreUnread: (p: { isDMMuted?: unknown }) => unreadHook(p) }));
vi.mock('../../contexts/SettingsContext', () => ({
  useOptionalMuteSettings: () => ({ isChannelMuted: () => false, isDMMuted }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ authStatus: { user: { isAdmin: false } }, hasPermission: () => true }) }));
vi.mock('../NotificationsTab', () => ({ default: () => null }));
vi.mock('./MeshCoreSubToolbar', () => ({
  MeshCoreSubToolbar: (props: { unread?: Record<string, boolean> }) => (
    <div data-testid="nav" data-rooms={String(props.unread?.rooms)} data-dms={String(props.unread?.dms)} />
  ),
}));
vi.mock('./MeshCoreStatusBar', () => ({ MeshCoreStatusBar: () => null }));
vi.mock('./MeshCoreNodesView', () => ({ MeshCoreNodesView: () => null }));
vi.mock('./MeshCoreDirectMessagesView', () => ({ MeshCoreDirectMessagesView: () => null }));
vi.mock('./MeshCoreChannelsView', () => ({ MeshCoreChannelsView: () => null }));
vi.mock('./MeshCoreRoomsView', () => ({ MeshCoreRoomsView: () => null }));
vi.mock('./MeshCoreInfoView', () => ({ MeshCoreInfoView: () => null }));
vi.mock('./MeshCoreTelemetryView', () => ({ MeshCoreTelemetryView: () => null }));
vi.mock('./MeshCorePacketMonitorView', () => ({ MeshCorePacketMonitorView: () => null }));
vi.mock('./MeshCoreConfigurationView', () => ({ MeshCoreConfigurationView: () => null }));
vi.mock('./MeshCoreSettingsView', () => ({ MeshCoreSettingsView: () => null }));
vi.mock('./MeshCoreAutomationsView', () => ({ MeshCoreAutomationsView: () => null }));

import { MeshCorePage } from './MeshCorePage';

describe('MeshCorePage rooms unread (#6261)', () => {
  it('passes the rooms flag to the sub toolbar and the DM mute predicate to the hook', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(screen.getByTestId('nav').dataset.rooms).toBe('true');
    expect(screen.getByTestId('nav').dataset.dms).toBe('false');
    expect(unreadHook.mock.calls[0][0].isDMMuted).toBe(isDMMuted);
  });
});
