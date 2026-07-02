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
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY', temperatureUnit: 'F', telemetryVisualizationHours: 48 }),
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
  default: (props: { nodeId: string; baseUrl?: string; temperatureUnit?: string; telemetryHours?: number }) => (
    <div
      data-testid="telemetry-graphs"
      data-node-id={props.nodeId}
      data-base-url={props.baseUrl ?? ''}
      data-temp-unit={props.temperatureUnit ?? ''}
      data-telemetry-hours={props.telemetryHours ?? ''}
    />
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
    // Contact + remote-admin actions: a repeater/room contact-detail panel
    // mounts the remote-admin console, which calls getRemoteAdminCapability on
    // mount. Without these the panel throws in JSDOM (#3755 repeater tests).
    resetContactPath: vi.fn().mockResolvedValue(true),
    shareContact: vi.fn().mockResolvedValue({ ok: true }),
    setContactOutPath: vi.fn().mockResolvedValue(true),
    traceContactPath: vi.fn().mockResolvedValue(null),
    discoverContactPath: vi.fn().mockResolvedValue(true),
    removeContact: vi.fn().mockResolvedValue(true),
    exportContact: vi.fn().mockResolvedValue(null),
    getNeighbours: vi.fn().mockResolvedValue(null),
    loginRemote: vi.fn().mockResolvedValue({ success: false }),
    loginRemoteWithSaved: vi.fn().mockResolvedValue({ success: false }),
    sendCliCommand: vi.fn().mockResolvedValue(null),
    getRemoteAdminCapability: vi.fn().mockResolvedValue(null),
    forgetRemoteCredential: vi.fn().mockResolvedValue(true),
    getRemoteStatus: vi.fn().mockResolvedValue(null),
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
    // #3659: the user's Temperature Unit + telemetry time-range settings are
    // forwarded so the graph isn't hardcoded to Celsius / 24h.
    expect(graphs.getAttribute('data-temp-unit')).toBe('F');
    expect(graphs.getAttribute('data-telemetry-hours')).toBe('48');
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
      .map((el) => el.querySelector('.mc-node-row-display-name')?.textContent || '');
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
      .map((el) => el.querySelector('.mc-node-row-display-name')?.textContent || '');
    // Bravo (favorite) pinned first despite oldest lastSeen; ★ indicator shown.
    expect(names[0]).toBe('Bravo');
    expect(document.querySelector('.mc-node-row .mc-dm-row-favorite')?.textContent).toBe('★');
  });

  // The `aFav !== bFav` pin runs ahead of BOTH sort branches, so favorites must
  // also stay on top under name sort (not just the default lastMessage sort).
  it('keeps favorited peers pinned when the user switches to name sort', () => {
    const contactsList: MeshCoreContact[] = [
      { publicKey: REAL_PK, advName: 'Charlie', advType: 1, lastSeen: 1000 },
      { publicKey: REAL_PK_2, advName: 'alpha', advType: 1, lastSeen: 2000 },
      { publicKey: 'c'.repeat(64), advName: 'Zeta', advType: 1, lastSeen: 3000 },
    ];
    // 'Zeta' is favorited — alphabetically last, so it would normally sort to
    // the bottom under name/asc; the favorite pin must override that.
    const nodes: MeshCoreNode[] = [
      { publicKey: REAL_PK, name: 'Charlie', advType: 1, isFavorite: false },
      { publicKey: REAL_PK_2, name: 'alpha', advType: 1, isFavorite: false },
      { publicKey: 'c'.repeat(64), name: 'Zeta', advType: 1, isFavorite: true },
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

    const dropdown = screen.getByTitle('Sort by') as HTMLSelectElement;
    fireEvent.change(dropdown, { target: { value: 'name' } });
    // Flip from the default 'desc' to ascending.
    fireEvent.click(screen.getByTitle('Descending'));

    const names = Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-name'))
      .map((el) => el.querySelector('.mc-node-row-display-name')?.textContent || '');
    // Zeta pinned first despite name/asc; non-favorites follow in name order.
    expect(names).toEqual(['Zeta', 'alpha', 'Charlie']);
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

describe('MeshCoreDirectMessagesView — repeaters are not messageable (#3755)', () => {
  const repeaterContact: MeshCoreContact = {
    publicKey: REAL_PK_2,
    advName: 'Repeater Rita',
    advType: 2, // Repeater — cannot receive DMs
    rssi: -80,
    snr: 5,
    pathLen: 1,
    lastSeen: Date.now(),
  };

  it('keeps the repeater listed in the contact sidebar (still browsable)', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact, repeaterContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    // Repeaters are NOT filtered out of the list — only their messaging is removed.
    expect(screen.getByText('Remote Bob')).toBeTruthy();
    expect(screen.getByText('Repeater Rita')).toBeTruthy();
  });

  it('hides the message composer and shows a notice when a repeater is selected', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact, repeaterContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    fireEvent.click(screen.getByText('Repeater Rita'));

    // No compose input for a repeater — the messaging feature is gone, not just disabled.
    expect(screen.queryByPlaceholderText('Type a message…')).toBeNull();
    // Replaced by an explanatory notice.
    expect(screen.getByText(/Repeaters cannot receive direct messages/i)).toBeTruthy();
  });

  it('still renders the message composer for a normal (companion) contact', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact, repeaterContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    fireEvent.click(screen.getByText('Remote Bob'));

    expect(screen.getByPlaceholderText('Type a message…')).toBeTruthy();
    expect(screen.queryByText(/Repeaters cannot receive direct messages/i)).toBeNull();
  });

  it('still renders node details (telemetry) for a selected repeater', async () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact, repeaterContact]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );
    fireEvent.click(screen.getByText('Repeater Rita'));

    // The detail/telemetry side still mounts even though messaging is removed.
    await waitFor(() => {
      expect(screen.getByText('Telemetry Retrieval')).toBeTruthy();
    });
  });
});

// Issue #3890: a node-type (advType) filter on the Node Details contact list so
// users with many repeaters/sensors can narrow to just their companions.
describe('MeshCoreDirectMessagesView — node-type filter (#3890)', () => {
  const mixed: MeshCoreContact[] = [
    { publicKey: 'a'.repeat(64), advName: 'Companion Carl', advType: 1, lastSeen: 4000 },
    { publicKey: 'b'.repeat(64), advName: 'Repeater Rita', advType: 2, lastSeen: 3000 },
    { publicKey: 'c'.repeat(64), advName: 'Sensor Sam', advType: 4, lastSeen: 2000 },
    { publicKey: 'd'.repeat(64), advName: 'Companion Cora', advType: 1, lastSeen: 1000 },
  ];

  const listedNames = (): string[] =>
    Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-display-name'))
      .map((el) => el.textContent || '');

  it('shows every advType by default (filter = All types)', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={mixed}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    const names = listedNames();
    expect(names).toContain('Companion Carl');
    expect(names).toContain('Repeater Rita');
    expect(names).toContain('Sensor Sam');
    expect(names).toContain('Companion Cora');
  });

  it('shows only companions when the Companion filter is selected', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={mixed}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    const filter = screen.getByTitle('Filter by node type') as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: '1' } });

    const names = listedNames();
    expect(names).toContain('Companion Carl');
    expect(names).toContain('Companion Cora');
    expect(names).not.toContain('Repeater Rita');
    expect(names).not.toContain('Sensor Sam');
  });

  it('shows only repeaters when the Repeater filter is selected', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={mixed}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    const filter = screen.getByTitle('Filter by node type') as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: '2' } });

    expect(listedNames()).toEqual(['Repeater Rita']);
  });

  it('combines the type filter with the search box', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={mixed}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    // Companions only…
    fireEvent.change(screen.getByTitle('Filter by node type'), { target: { value: '1' } });
    // …then narrow further to "Carl".
    fireEvent.change(screen.getByPlaceholderText('Search contacts…'), { target: { value: 'Carl' } });

    expect(listedNames()).toEqual(['Companion Carl']);
  });

  it('shows a type-specific empty state when no contact matches the filter', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={[mixed[0], mixed[3]]} // companions only — no repeaters
        status={makeStatus()}
        actions={makeActions()}
      />,
    );
    fireEvent.change(screen.getByTitle('Filter by node type'), { target: { value: '2' } });

    expect(screen.getByText('No contacts of this type')).toBeTruthy();
  });
});

describe('MeshCoreDirectMessagesView — DM unread marking (#3891)', () => {
  it('writes a per-source DM read-marker when a contact is opened', async () => {
    localStorage.removeItem('meshmonitor-meshcore-dm-lastread-src-a');
    render(
      <MeshCoreDirectMessagesView
        messages={[]}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );
    fireEvent.click(screen.getByText('Remote Bob'));

    await waitFor(() => {
      const raw = localStorage.getItem('meshmonitor-meshcore-dm-lastread-src-a');
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)[REAL_PK]).toBeGreaterThan(0);
    });
  });
});
