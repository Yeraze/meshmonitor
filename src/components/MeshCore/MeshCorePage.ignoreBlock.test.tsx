/**
 * @vitest-environment jsdom
 *
 * MeshCorePage — Ignore / Block (#5408): nodes with an entry are hidden from
 * the node list and map (one filter at the page) and the entries reach the
 * DM / Node Details view.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));

const IGNORED = 'AB'.repeat(32);
const VISIBLE = 'cd'.repeat(32);

vi.mock('./hooks/useMeshCore', () => ({
  useMeshCore: () => ({
    status: { connected: true, deviceType: 1 },
    nodes: [{ publicKey: IGNORED.toLowerCase(), name: 'Spammer' }, { publicKey: VISIBLE, name: 'Friend' }],
    contacts: [{ publicKey: IGNORED.toLowerCase(), advName: 'Spammer' }, { publicKey: VISIBLE, advName: 'Friend' }],
    messages: [],
    loading: false,
    hasLoadedOnce: true,
    error: null,
    actions: { discoverNodes: vi.fn(), setNodeFavorite: vi.fn(), importContact: vi.fn(), clearError: vi.fn(), syncDeviceTime: vi.fn() },
  }),
  ConnectionStatus: {},
}));

vi.mock('../../hooks/useMeshCoreFilters', () => ({
  useMeshCoreIgnoredNodes: () => ({ data: [{ publicKey: IGNORED, mode: 'block' }] }),
  useHiddenMeshCoreKeys: (entries: Array<{ publicKey: string }> = []) => new Set(entries.map((e) => e.publicKey.toLowerCase())),
  useSetMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
  useRemoveMeshCoreIgnoredNode: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('./hooks/useMeshCoreUnread', () => ({ useMeshCoreUnread: () => ({ channels: false, dms: false }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ authStatus: { user: { isAdmin: false } } }) }));
vi.mock('../NotificationsTab', () => ({ default: () => null }));
vi.mock('./MeshCoreSubToolbar', () => ({
  MeshCoreSubToolbar: (props: { onSelect: (v: string) => void }) => (
    <button type="button" onClick={() => props.onSelect('dms')}>go-dms</button>
  ),
}));
vi.mock('./MeshCoreStatusBar', () => ({ MeshCoreStatusBar: () => null }));
vi.mock('./MeshCoreNodesView', () => ({
  MeshCoreNodesView: (props: { nodes: Array<{ publicKey: string }>; contacts: Array<{ publicKey: string }> }) => (
    <div data-testid="nodes">{props.nodes.map((n) => n.publicKey).join(',')}|{props.contacts.map((c) => c.publicKey).join(',')}</div>
  ),
}));
vi.mock('./MeshCoreDirectMessagesView', () => ({
  MeshCoreDirectMessagesView: (props: { ignoredNodes?: Array<{ publicKey: string }>; onSetIgnoredNode?: unknown }) => (
    <div data-testid="dms">{(props.ignoredNodes ?? []).map((n) => n.publicKey).join(',')}|{typeof props.onSetIgnoredNode}</div>
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

describe('MeshCorePage — Ignore / Block (#5408)', () => {
  it('hides listed nodes from the node list and map, case-insensitively', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(screen.getByTestId('nodes').textContent).toBe(`${VISIBLE}|${VISIBLE}`);
  });

  it('passes the entries and handlers to Node Details', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    fireEvent.click(screen.getByText('go-dms'));
    expect(screen.getByTestId('dms').textContent).toBe(`${IGNORED}|function`);
  });
});
