/**
 * @vitest-environment jsdom
 *
 * MeshCorePage — Pin sidebar parity with the Meshtastic sidebar (#5481): one
 * global `sidebar-pinned` key, the nav starts expanded when pinned, and an
 * unpinned nav collapses after a nav click. Harness copied from
 * MeshCorePage.ignoreBlock.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  MeshCoreSubToolbar: (props: {
    expanded: boolean;
    pinned?: boolean;
    onSelect: (v: string) => void;
    onToggleExpanded: () => void;
    onTogglePin?: () => void;
  }) => (
    <div data-testid="nav" data-expanded={String(props.expanded)} data-pinned={String(props.pinned)}>
      <button type="button" onClick={() => props.onSelect('channels')}>select</button>
      <button type="button" onClick={props.onToggleExpanded}>toggle</button>
      <button type="button" onClick={props.onTogglePin}>pin</button>
    </div>
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

const nav = () => screen.getByTestId('nav');

describe('MeshCorePage — Pin sidebar (#5481)', () => {
  beforeEach(() => localStorage.clear());

  it('starts collapsed and collapses again after a nav click when unpinned', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(nav().dataset.expanded).toBe('false');
    fireEvent.click(screen.getByText('toggle'));
    expect(nav().dataset.expanded).toBe('true');
    fireEvent.click(screen.getByText('select'));
    expect(nav().dataset.expanded).toBe('false');
  });

  it('pinning expands the nav, stores the shared key, and keeps it open on nav clicks', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    fireEvent.click(screen.getByText('pin'));
    expect(nav().dataset.pinned).toBe('true');
    expect(nav().dataset.expanded).toBe('true');
    expect(localStorage.getItem('sidebar-pinned')).toBe('true');
    fireEvent.click(screen.getByText('select'));
    expect(nav().dataset.expanded).toBe('true');
  });

  it('starts expanded when the shared pin is already set (e.g. from a Meshtastic source)', () => {
    localStorage.setItem('sidebar-pinned', 'true');
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(nav().dataset.pinned).toBe('true');
    expect(nav().dataset.expanded).toBe('true');
  });

  it('unpinning stores false and lets the next nav click collapse', () => {
    localStorage.setItem('sidebar-pinned', 'true');
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    fireEvent.click(screen.getByText('pin'));
    expect(localStorage.getItem('sidebar-pinned')).toBe('false');
    fireEvent.click(screen.getByText('select'));
    expect(nav().dataset.expanded).toBe('false');
  });
});
