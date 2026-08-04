/**
 * @vitest-environment jsdom
 *
 * MeshCorePage — receive-only flag distribution (#4547 Phase 2 WP1, §3.0).
 *
 * Phase 1 made GET /api/device/tx-status MeshCore-aware, so `isTxDisabled`
 * for a MeshCore sourceId already means "receive-only is on" — no separate
 * hook. This test proves MeshCorePage calls `useTxStatus` exactly once and
 * threads the resulting boolean, renamed `receiveOnly`, into each of its
 * eight direct children (per §3.0's decision — a plain prop, not a new
 * context, not a per-component query).
 *
 * Every child component is replaced with a lightweight stub that renders
 * the `receiveOnly` prop it received, and `MeshCoreSubToolbar` is replaced
 * with plain buttons so the test can switch views without needing the real
 * sidebar markup.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const txStatus = { isTxDisabled: true };
vi.mock('../../hooks/useTxStatus', () => ({
  useTxStatus: (...args: unknown[]) => {
    useTxStatusCalls.push(args);
    return txStatus;
  },
}));
let useTxStatusCalls: unknown[][] = [];

vi.mock('./hooks/useMeshCore', () => ({
  useMeshCore: () => ({
    status: { connected: true, deviceType: 1 },
    nodes: [],
    contacts: [],
    messages: [],
    loading: false,
    hasLoadedOnce: true,
    error: null,
    actions: { discoverNodes: vi.fn(), setNodeFavorite: vi.fn(), importContact: vi.fn(), clearError: vi.fn(), syncDeviceTime: vi.fn() },
  }),
  ConnectionStatus: {},
}));

vi.mock('./hooks/useMeshCoreUnread', () => ({
  useMeshCoreUnread: () => ({ channels: false, dms: false }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { user: { isAdmin: false } } }),
}));

vi.mock('../NotificationsTab', () => ({ default: () => null }));

// Real SaveBarProvider/SaveBarGroup/SaveBar — plain context, safe to mount.

vi.mock('./MeshCoreSubToolbar', () => ({
  MeshCoreSubToolbar: (props: { onSelect: (v: string) => void }) => (
    <div>
      {['nodes', 'channels', 'rooms', 'dms', 'configuration', 'automations', 'settings'].map(v => (
        <button key={v} type="button" onClick={() => props.onSelect(v)}>
          go-{v}
        </button>
      ))}
    </div>
  ),
}));

function stub(testId: string) {
  return (props: { receiveOnly?: boolean }) => (
    <div data-testid={testId}>{String(props.receiveOnly)}</div>
  );
}

vi.mock('./MeshCoreStatusBar', () => ({ MeshCoreStatusBar: stub('statusbar-receiveOnly') }));
vi.mock('./MeshCoreNodesView', () => ({ MeshCoreNodesView: stub('nodesview-receiveOnly') }));
vi.mock('./MeshCoreChannelsView', () => ({ MeshCoreChannelsView: stub('channelsview-receiveOnly') }));
vi.mock('./MeshCoreRoomsView', () => ({ MeshCoreRoomsView: stub('roomsview-receiveOnly') }));
vi.mock('./MeshCoreDirectMessagesView', () => ({ MeshCoreDirectMessagesView: stub('dmsview-receiveOnly') }));
vi.mock('./MeshCoreInfoView', () => ({ MeshCoreInfoView: () => null }));
vi.mock('./MeshCoreTelemetryView', () => ({ MeshCoreTelemetryView: () => null }));
vi.mock('./MeshCorePacketMonitorView', () => ({ MeshCorePacketMonitorView: () => null }));
vi.mock('./MeshCoreConfigurationView', () => ({ MeshCoreConfigurationView: stub('configview-receiveOnly') }));
vi.mock('./MeshCoreSettingsView', () => ({ MeshCoreSettingsView: stub('settingsview-receiveOnly') }));
vi.mock('./MeshCoreAutomationsView', () => ({ MeshCoreAutomationsView: stub('automationsview-receiveOnly') }));

import { MeshCorePage } from './MeshCorePage';

describe('MeshCorePage — receive-only flag distribution (#4547 Phase 2 WP1)', () => {
  it('calls useTxStatus exactly once with { baseUrl, sourceId }', () => {
    useTxStatusCalls = [];
    render(<MeshCorePage baseUrl="/mm" sourceId="src-1" />);
    expect(useTxStatusCalls).toHaveLength(1);
    expect(useTxStatusCalls[0][0]).toEqual({ baseUrl: '/mm', sourceId: 'src-1' });
  });

  it('threads receiveOnly=true (from isTxDisabled) into MeshCoreStatusBar and the default nodes view', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);
    expect(screen.getByTestId('statusbar-receiveOnly')).toHaveTextContent('true');
    expect(screen.getByTestId('nodesview-receiveOnly')).toHaveTextContent('true');
  });

  it('threads receiveOnly into every remaining direct child as the view switches', () => {
    render(<MeshCorePage baseUrl="" sourceId="src-1" />);

    fireEvent.click(screen.getByText('go-channels'));
    expect(screen.getByTestId('channelsview-receiveOnly')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('go-rooms'));
    expect(screen.getByTestId('roomsview-receiveOnly')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('go-dms'));
    expect(screen.getByTestId('dmsview-receiveOnly')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('go-configuration'));
    expect(screen.getByTestId('configview-receiveOnly')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('go-automations'));
    expect(screen.getByTestId('automationsview-receiveOnly')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('go-settings'));
    expect(screen.getByTestId('settingsview-receiveOnly')).toHaveTextContent('true');
  });

  it('threads receiveOnly=false when isTxDisabled is false (Meshtastic/non-gated source)', () => {
    txStatus.isTxDisabled = false;
    try {
      render(<MeshCorePage baseUrl="" sourceId="src-2" />);
      expect(screen.getByTestId('statusbar-receiveOnly')).toHaveTextContent('false');
      expect(screen.getByTestId('nodesview-receiveOnly')).toHaveTextContent('false');
    } finally {
      txStatus.isTxDisabled = true;
    }
  });
});
