/**
 * @vitest-environment jsdom
 *
 * MeshCorePage — Show on Map (#5964): Node Details' button switches to the
 * Nodes view (list + map) and hands it the node to select and pop up.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));

const PK = 'cd'.repeat(32);

vi.mock('./hooks/useMeshCore', () => ({
  useMeshCore: () => ({
    status: { connected: true, deviceType: 2 },
    nodes: [{ publicKey: PK, name: 'Hilltop' }],
    contacts: [{ publicKey: PK, advName: 'Hilltop', latitude: 1, longitude: 2 }],
    messages: [],
    loading: false,
    hasLoadedOnce: true,
    error: null,
    actions: { discoverNodes: vi.fn(), setNodeFavorite: vi.fn(), importContact: vi.fn(), clearError: vi.fn(), syncDeviceTime: vi.fn() },
  }),
  ConnectionStatus: {},
}));
vi.mock('../../hooks/useMeshCoreFilters', () => ({
  useMeshCoreIgnoredNodes: () => ({ data: [] }),
  useHiddenMeshCoreKeys: () => new Set(),
  useSetMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
  useRemoveMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('./hooks/useMeshCoreUnread', () => ({ useMeshCoreUnread: () => ({ channels: false, dms: false }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ authStatus: { user: { isAdmin: false } }, hasPermission: () => true }) }));
vi.mock('../NotificationsTab', () => ({ default: () => null }));
vi.mock('./MeshCoreSubToolbar', () => ({
  MeshCoreSubToolbar: (props: { view: string; onSelect: (v: string) => void }) => (
    <>
      <span data-testid="view">{props.view}</span>
      <button type="button" onClick={() => props.onSelect('dms')}>go-dms</button>
      <button type="button" onClick={() => props.onSelect('nodes')}>go-nodes</button>
    </>
  ),
}));
vi.mock('./MeshCoreStatusBar', () => ({ MeshCoreStatusBar: () => null }));
vi.mock('./MeshCoreNodesView', () => ({
  MeshCoreNodesView: (props: { focusPublicKey?: string | null }) => (
    <div data-testid="nodes">{props.focusPublicKey ?? 'none'}</div>
  ),
}));
vi.mock('./MeshCoreDirectMessagesView', () => ({
  MeshCoreDirectMessagesView: (props: { onShowOnMap?: (pk: string) => void }) => (
    <button type="button" onClick={() => props.onShowOnMap?.(PK)}>show-on-map</button>
  ),
}));
vi.mock('./MeshCoreChannelsView', () => ({ MeshCoreChannelsView: () => null }));
vi.mock('./MeshCoreRoomsView', () => ({ MeshCoreRoomsView: () => null }));
vi.mock('./MeshCoreInfoView', () => ({ MeshCoreInfoView: () => null }));
vi.mock('./MeshCoreTelemetryView', () => ({ MeshCoreTelemetryView: () => null }));
vi.mock('./MeshCorePacketMonitorView', () => ({ MeshCorePacketMonitorView: () => null }));
vi.mock('./MeshCoreConfigurationView', () => ({ MeshCoreConfigurationView: () => null }));
vi.mock('./MeshCoreSettingsView', () => ({ MeshCoreSettingsView: () => null }));
vi.mock('./MeshCoreAutomationsView', () => ({ MeshCoreAutomationsView: () => null }));

import { MeshCorePage } from './MeshCorePage';

describe('MeshCorePage — Show on Map (#5964)', () => {
  it('opens the Nodes view on the node from Node Details', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(screen.getByTestId('nodes').textContent).toBe('none');
    fireEvent.click(screen.getByText('go-dms'));
    expect(screen.queryByTestId('nodes')).toBeNull();
    fireEvent.click(screen.getByText('show-on-map'));
    expect(screen.getByTestId('view').textContent).toBe('nodes');
    expect(screen.getByTestId('nodes').textContent).toBe(PK);
  });

  it('drops the request once the view moves away again', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    fireEvent.click(screen.getByText('go-dms'));
    fireEvent.click(screen.getByText('show-on-map'));
    fireEvent.click(screen.getByText('go-dms'));
    fireEvent.click(screen.getByText('go-nodes'));
    expect(screen.getByTestId('nodes').textContent).toBe('none');
  });
});
