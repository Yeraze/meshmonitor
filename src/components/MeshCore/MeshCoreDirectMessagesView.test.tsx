/**
 * @vitest-environment jsdom
 *
 * Tests for the MeshCore DM/Node-Detail view's hosting of the per-node
 * telemetry-retrieval config panel. The panel was moved here from
 * `MeshCoreNodesView` and should only mount when:
 *   - the selected DM peer has a real 64-hex MeshCore pubkey, AND
 *   - the view is in per-source mode (sourceId + baseUrl are passed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

// TelemetryGraphs is exercised by its own tests; here we only need to
// confirm the DM view mounts it with the right props when conditions are
// met. Stub the heavy graphs component with a sentinel so we don't need
// ToastProvider / QueryClientProvider / SourceProvider in this test.
vi.mock('../TelemetryGraphs', () => ({
  default: (props: { nodeId: string; baseUrl?: string }) => (
    <div data-testid="telemetry-graphs" data-node-id={props.nodeId} data-base-url={props.baseUrl ?? ''} />
  ),
}));

import { MeshCoreDirectMessagesView } from './MeshCoreDirectMessagesView';
import type { MeshCoreActions, ConnectionStatus, MeshCoreMessage, MeshCoreNode } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

function makeActions(overrides: Partial<MeshCoreActions> = {}): MeshCoreActions {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    setDeviceName: vi.fn().mockResolvedValue(true),
    setRadioParams: vi.fn().mockResolvedValue(true),
    setCoords: vi.fn().mockResolvedValue(true),
    setAdvertLocPolicy: vi.fn().mockResolvedValue(true),
    setTelemetryModeBase: vi.fn().mockResolvedValue(true),
    setTelemetryModeLoc: vi.fn().mockResolvedValue(true),
    setTelemetryModeEnv: vi.fn().mockResolvedValue(true),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    ...overrides,
  };
}

function makeStatus(): ConnectionStatus {
  return {
    connected: true,
    deviceType: 1,
    deviceTypeName: 'companion',
    config: null,
    localNode: { publicKey: 'self'.padEnd(64, '0'), name: 'self', advType: 1 },
  };
}

const REAL_PK = 'a'.repeat(64);
const REAL_PK_2 = 'b'.repeat(64);

const realContact: MeshCoreContact = {
  publicKey: REAL_PK,
  advName: 'Remote Bob',
  advType: 1,
  rssi: -72,
  snr: 8.5,
  pathLen: 2,
  lastSeen: Date.now(),
};

const messages: MeshCoreMessage[] = [];

beforeEach(() => {
  csrfFetchMock.mockReset();
  csrfFetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { enabled: false, intervalMinutes: 60, lastRequestAt: null },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
});

describe('MeshCoreDirectMessagesView — per-node telemetry-config panel', () => {
  it('renders the telemetry-retrieval panel when the selected peer has a real 64-hex pubkey and sourceId is set', async () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    // Pick the peer in the DM sidebar.
    fireEvent.click(screen.getByText('Remote Bob'));

    await waitFor(() => {
      expect(screen.getByText('Telemetry Retrieval')).toBeTruthy();
    });

    // Panel made its GET against the per-node telemetry-config endpoint.
    expect(csrfFetchMock).toHaveBeenCalled();
    const calledUrl = csrfFetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/sources/src-a/meshcore/nodes/');
    expect(calledUrl).toContain(REAL_PK);
    expect(calledUrl).toContain('/telemetry-config');
  });

  it('does NOT render the telemetry-retrieval panel when sourceId is not provided (singleton mode)', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );

    fireEvent.click(screen.getByText('Remote Bob'));

    expect(screen.queryByText('Telemetry Retrieval')).toBeNull();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('does NOT render the panel for a non-64-hex peer key (e.g. inbound prefix-only)', () => {
    const prefixOnly: MeshCoreContact = {
      publicKey: 'cafebabe1234', // 12 hex chars — fails the real-key gate
      advName: 'Prefix Pete',
      advType: 1,
    };

    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[prefixOnly]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    fireEvent.click(screen.getByText('Prefix Pete'));

    expect(screen.queryByText('Telemetry Retrieval')).toBeNull();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('mounts the TelemetryGraphs component with the selected pubkey when sourceId is set', async () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl="/meshmonitor"
        sourceId="src-a"
      />,
    );

    fireEvent.click(screen.getByText('Remote Bob'));

    const graphs = await screen.findByTestId('telemetry-graphs');
    expect(graphs.getAttribute('data-node-id')).toBe(REAL_PK);
    expect(graphs.getAttribute('data-base-url')).toBe('/meshmonitor');
  });

  it('does NOT mount TelemetryGraphs for a non-real-pubkey peer', () => {
    const prefixOnly: MeshCoreContact = {
      publicKey: 'cafebabe1234',
      advName: 'Prefix Pete',
      advType: 1,
    };

    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[prefixOnly]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    fireEvent.click(screen.getByText('Prefix Pete'));
    expect(screen.queryByTestId('telemetry-graphs')).toBeNull();
  });

  it('does NOT mount TelemetryGraphs when sourceId is not provided', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );

    fireEvent.click(screen.getByText('Remote Bob'));
    expect(screen.queryByTestId('telemetry-graphs')).toBeNull();
  });

  it('sorts DM peers by name when the user picks "Name" and toggles to ascending', () => {
    const contactsList: MeshCoreContact[] = [
      { publicKey: REAL_PK, advName: 'Charlie', advType: 1, lastSeen: 1000 },
      { publicKey: REAL_PK_2, advName: 'alpha', advType: 1, lastSeen: 3000 },
      { publicKey: 'c'.repeat(64), advName: 'Bravo', advType: 1, lastSeen: 2000 },
    ];

    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={contactsList}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );

    const dropdown = screen.getByTitle('Sort by') as HTMLSelectElement;
    fireEvent.change(dropdown, { target: { value: 'name' } });
    // Direction starts 'desc' — click the direction button (titled
    // "Descending" in that state) to flip to ascending.
    fireEvent.click(screen.getByTitle('Descending'));

    const names = Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-name'))
      .map((el) => el.querySelector('span')?.textContent || '');
    expect(names).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  // Issue #3620: favorited MeshCore nodes pin to the top of the DM contact
  // list, consistent with the Meshtastic DM list and the MeshCore node list.
  // The favorite flag lives server-side on the node list (issue #3588), not on
  // contacts, so it's threaded in via the `nodes` prop.
  it('pins favorited peers to the top of the DM list regardless of sort order', () => {
    const contactsList: MeshCoreContact[] = [
      { publicKey: REAL_PK, advName: 'Charlie', advType: 1, lastSeen: 3000 },
      { publicKey: REAL_PK_2, advName: 'alpha', advType: 1, lastSeen: 2000 },
      { publicKey: 'c'.repeat(64), advName: 'Bravo', advType: 1, lastSeen: 1000 },
    ];
    // Only 'Bravo' is favorited; it has the OLDEST lastSeen and would normally
    // sort last under the default (lastMessage / desc) order.
    const nodes: MeshCoreNode[] = [
      { publicKey: REAL_PK, name: 'Charlie', advType: 1, isFavorite: false },
      { publicKey: REAL_PK_2, name: 'alpha', advType: 1, isFavorite: false },
      { publicKey: 'c'.repeat(64), name: 'Bravo', advType: 1, isFavorite: true },
    ];

    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={contactsList}
        nodes={nodes}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );

    const names = Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-name'))
      .map((el) => el.querySelector('span:not(.mc-dm-row-favorite)')?.textContent || '');
    // Bravo (favorite) pinned first despite oldest lastSeen; ★ indicator shown.
    expect(names[0]).toBe('Bravo');
    expect(document.querySelector('.mc-node-row .mc-dm-row-favorite')?.textContent).toBe('★');
  });

  it('collapses the node list when the toggle button is clicked, and restores it on re-click', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );

    // Starts expanded — peer is visible and the toggle reads "Collapse node list".
    expect(screen.getByText('Remote Bob')).toBeTruthy();
    const toggle = screen.getByTitle('Collapse node list');
    expect(toggle.textContent).toBe('◀');

    // Click collapses — peer row is unmounted, toggle now reads "Expand…".
    fireEvent.click(toggle);
    expect(screen.queryByText('Remote Bob')).toBeNull();
    const expandToggle = screen.getByTitle('Expand node list');
    expect(expandToggle.textContent).toBe('▶');

    // Click again restores the list.
    fireEvent.click(expandToggle);
    expect(screen.getByText('Remote Bob')).toBeTruthy();
    expect(screen.getByTitle('Collapse node list')).toBeTruthy();
  });

  it('refetches telemetry config when switching from one real-pubkey peer to another', async () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[
          realContact,
          { ...realContact, publicKey: REAL_PK_2, advName: 'Remote Carol' },
        ]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    fireEvent.click(screen.getByText('Remote Bob'));
    await waitFor(() => {
      const urls = csrfFetchMock.mock.calls.map(c => c[0] as string);
      expect(urls.some(u => u.includes(REAL_PK))).toBe(true);
    });

    fireEvent.click(screen.getByText('Remote Carol'));
    await waitFor(() => {
      const urls = csrfFetchMock.mock.calls.map(c => c[0] as string);
      expect(urls.some(u => u.includes(REAL_PK_2))).toBe(true);
    });
  });

  // Regression: the right pane carries the `meshcore-main-pane--dm` modifier
  // class that opts into the page-scrolling layout (bounded message stream
  // height + flowing contact-detail / telemetry block below). Dropping it
  // would revert to the 45%-capped detail pane.
  it('applies the meshcore-main-pane--dm modifier to opt into page-scroll layout', () => {
    const { container } = render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    const mainPane = container.querySelector('.meshcore-main-pane');
    expect(mainPane?.classList.contains('meshcore-main-pane--dm')).toBe(true);
  });
});
