/**
 * @vitest-environment jsdom
 *
 * MeshCorePage — a tab the viewer has no grant for is never shown, however it
 * is asked for (#5666): a nav click, the status bar's Connect button, or a
 * jump to Node Details all land on the Nodes tab instead of a blank pane.
 * Harness copied from MeshCorePage.navPin.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));

const connect = vi.fn();
vi.mock('./hooks/useMeshCore', () => ({
  useMeshCore: () => ({
    status: { connected: false, deviceType: 1 },
    nodes: [],
    contacts: [],
    messages: [],
    loading: false,
    hasLoadedOnce: true,
    error: null,
    actions: { connect, discoverNodes: vi.fn(), setNodeFavorite: vi.fn(), importContact: vi.fn(), clearError: vi.fn(), syncDeviceTime: vi.fn() },
  }),
  ConnectionStatus: {},
}));
vi.mock('../../hooks/useMeshCoreFilters', () => ({
  useMeshCoreIgnoredNodes: () => ({ data: [] }),
  useHiddenMeshCoreKeys: () => new Set<string>(),
  useSetMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
  useRemoveMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('./hooks/useMeshCoreUnread', () => ({ useMeshCoreUnread: () => ({ channels: false, dms: false }) }));
vi.mock('./hooks/useReadStateSync', () => ({ useReadStateSync: () => undefined }));

let grants: string[] = [];
let authenticated = false;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { authenticated, user: { isAdmin: false } },
    hasPermission: (resource: string, action: string) => action === 'read' && grants.includes(resource),
  }),
}));
vi.mock('../../contexts/SettingsContext', () => ({ useOptionalChannelMuteSettings: () => null }));

// The nav is replaced by one button per tab, so a hidden tab can still be
// asked for: the page itself must refuse it.
const ALL = ['nodes', 'channels', 'rooms', 'dms', 'telemetry', 'packets', 'info', 'configuration', 'automations', 'notifications', 'settings'];
vi.mock('./MeshCoreSubToolbar', () => ({
  MeshCoreSubToolbar: (props: { view: string; onSelect: (v: string) => void }) => (
    <div data-testid="nav" data-view={props.view}>
      {ALL.map((v) => <button key={v} type="button" onClick={() => props.onSelect(v)}>go-{v}</button>)}
    </div>
  ),
}));
vi.mock('./MeshCoreStatusBar', () => ({
  MeshCoreStatusBar: (props: { onOpenSettings: () => void }) => (
    <button type="button" onClick={props.onOpenSettings}>status-connect</button>
  ),
}));
vi.mock('./MeshCoreNodesView', () => ({
  MeshCoreNodesView: (props: { onNavigateToDm: (key: string) => void }) => (
    <div data-testid="view-nodes"><button type="button" onClick={() => props.onNavigateToDm('ab'.repeat(32))}>open-dm</button></div>
  ),
}));
vi.mock('./MeshCoreChannelsView', () => ({ MeshCoreChannelsView: () => <div data-testid="view-channels" /> }));
vi.mock('./MeshCoreRoomsView', () => ({ MeshCoreRoomsView: () => <div data-testid="view-rooms" /> }));
vi.mock('./MeshCoreDirectMessagesView', () => ({ MeshCoreDirectMessagesView: () => <div data-testid="view-dms" /> }));
vi.mock('./MeshCoreTelemetryView', () => ({ MeshCoreTelemetryView: () => <div data-testid="view-telemetry" /> }));
vi.mock('./MeshCorePacketMonitorView', () => ({ MeshCorePacketMonitorView: () => <div data-testid="view-packets" /> }));
vi.mock('./MeshCoreInfoView', () => ({ MeshCoreInfoView: () => <div data-testid="view-info" /> }));
vi.mock('./MeshCoreConfigurationView', () => ({ MeshCoreConfigurationView: () => <div data-testid="view-configuration" /> }));
vi.mock('./MeshCoreAutomationsView', () => ({ MeshCoreAutomationsView: () => <div data-testid="view-automations" /> }));
vi.mock('../NotificationsTab', () => ({ default: () => <div data-testid="view-notifications" /> }));
vi.mock('./MeshCoreSettingsView', () => ({ MeshCoreSettingsView: () => <div data-testid="view-settings" /> }));

import { MeshCorePage } from './MeshCorePage';

const shown = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid^="view-"]')).map((el) => el.getAttribute('data-testid')!.slice(5));
const mount = (held: string[], signedIn = false) => {
  grants = held;
  authenticated = signedIn;
  return render(<MeshCorePage baseUrl="" sourceId="src-1" />);
};

describe('MeshCorePage — a tab without its grant is not reachable (#5666)', () => {
  beforeEach(() => {
    localStorage.clear();
    connect.mockClear();
  });

  // tab, the grant that opens it
  const gated: Array<[string, string]> = [
    ['channels', 'channel_0'],
    ['rooms', 'messages'],
    ['dms', 'messages'],
    ['telemetry', 'dashboard'],
    ['packets', 'packetmonitor'],
    ['configuration', 'configuration'],
    ['automations', 'automation'],
    ['settings', 'settings'],
  ];

  it.each(gated)('asking for %s without its grant shows the Nodes tab', (tab) => {
    mount(['connection', 'nodes']);
    fireEvent.click(screen.getByText(`go-${tab}`));
    expect(shown()).toEqual(['nodes']);
    expect(screen.getByTestId('nav').dataset.view).toBe('nodes');
  });

  it.each(gated)('asking for %s with %s:read shows it', (tab, grant) => {
    mount(['connection', grant]);
    fireEvent.click(screen.getByText(`go-${tab}`));
    expect(shown()).toEqual([tab]);
    expect(screen.getByTestId('nav').dataset.view).toBe(tab);
  });

  it('Notifications needs a signed-in user', () => {
    const first = mount(['connection']);
    fireEvent.click(screen.getByText('go-notifications'));
    expect(shown()).toEqual(['nodes']);
    first.unmount();
    mount(['connection'], true);
    fireEvent.click(screen.getByText('go-notifications'));
    expect(shown()).toEqual(['notifications']);
  });

  it('Node Info is open to anyone who can open the page', () => {
    mount(['connection']);
    fireEvent.click(screen.getByText('go-info'));
    expect(shown()).toEqual(['info']);
  });

  it('a jump to Node Details without messages:read stays on Nodes', () => {
    mount(['connection', 'nodes']);
    fireEvent.click(screen.getByText('open-dm'));
    expect(shown()).toEqual(['nodes']);
  });

  it('the asked-for tab appears once its grant arrives', () => {
    const view = mount(['connection']);
    fireEvent.click(screen.getByText('go-settings'));
    expect(shown()).toEqual(['nodes']);
    grants = ['connection', 'settings'];
    view.rerender(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(shown()).toEqual(['settings']);
  });

  it('the status bar Connect button opens Settings with settings:read', () => {
    mount(['connection', 'settings']);
    fireEvent.click(screen.getByText('status-connect'));
    expect(shown()).toEqual(['settings']);
    expect(connect).not.toHaveBeenCalled();
  });

  it('without the Settings tab, the status bar Connect button connects directly', () => {
    mount(['connection']);
    fireEvent.click(screen.getByText('status-connect'));
    expect(shown()).toEqual(['nodes']);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
