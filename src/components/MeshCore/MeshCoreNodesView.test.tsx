/**
 * @vitest-environment jsdom
 *
 * Sort behavior for the MeshCore Nodes list, the per-row "More details"
 * quick-access (#3350), and the header Discover menu (#3351).
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

// Captures every prop MeshCoreMap is rendered with, so the per-source age
// filter suite (#4412 Phase 4 WP3) can assert on the `contacts` it receives
// without the map needing to filter anything itself (spec §3.4 / §3.11).
const meshCoreMapProps = vi.fn();
vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: (props: Record<string, unknown>) => {
    meshCoreMapProps(props);
    return <div data-testid="mc-map" />;
  },
}));

const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

// `useSource()` resolves to a real MeshCore SourceProvider in the app
// (main.tsx). Standalone here, so a fixed sourceId is enough — the age
// filter behaviour itself is driven entirely by the mocked
// useNodeDisplaySettings below (spec §3.4b).
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test Source', sourceType: 'meshcore' }),
}));

const mockUseNodeDisplaySettings = vi.fn();
vi.mock('../../hooks/useNodeDisplaySettings', () => ({
  useNodeDisplaySettings: (...args: unknown[]) => mockUseNodeDisplaySettings(...args),
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';
import type { MeshCoreNode } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

// Rebased onto Date.now()-relative milliseconds (#4412 Phase 4 WP3) — the
// original fixtures used `lastHeard: 1000/2000/3000` (epoch 1970), which
// falls outside any real age cutoff. Relative order/spacing is preserved
// (alpha most recent, Charlie oldest) so every sort/selection assertion
// below is unchanged.
const NOW = Date.now();
const HOUR_MS = 60 * 60 * 1000;

const nodes: MeshCoreNode[] = [
  { publicKey: PK_A, name: 'Charlie', advType: 1, lastHeard: NOW - 3 * HOUR_MS },
  { publicKey: PK_B, name: 'alpha', advType: 1, lastHeard: NOW - 1 * HOUR_MS },
  { publicKey: PK_C, name: 'Bravo', advType: 1, lastHeard: NOW - 2 * HOUR_MS },
];

const contacts: MeshCoreContact[] = [];

function listedNames(): string[] {
  // The display name carries the stable `.mc-node-row-display-name` class; a
  // role icon (#3647) and other indicators may precede it in the row.
  const rows = Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-name'));
  return rows.map((el) => el.querySelector('.mc-node-row-display-name')?.textContent || '');
}

// Default 24h cutoff for every describe below — the rebased fixtures above
// are all within 3 hours, so they survive it. The per-source age filter
// suite overrides this per-test where it needs a different cutoff.
beforeEach(() => {
  mockUseNodeDisplaySettings.mockReset().mockReturnValue({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 });
  meshCoreMapProps.mockClear();
});

describe('MeshCoreNodesView — sort controls', () => {
  it('defaults to sorting by last heard, descending (most recent first)', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    // lastHeard order desc: alpha(3000) -> Bravo(2000) -> Charlie(1000)
    expect(listedNames()).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('sorts alphabetically (case-insensitive) when "Name" is selected', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    const dropdown = screen.getByTitle('Sort by') as HTMLSelectElement;
    fireEvent.change(dropdown, { target: { value: 'name' } });
    // Direction defaults to desc — toggle to asc for natural alphabetical.
    fireEvent.click(screen.getByTitle('Descending'));
    expect(listedNames()).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('reverses order when the direction button is clicked', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    const dropdown = screen.getByTitle('Sort by') as HTMLSelectElement;
    fireEvent.change(dropdown, { target: { value: 'name' } });
    // After selecting name, direction is still 'desc' from default — Z..A.
    expect(listedNames()).toEqual(['Charlie', 'Bravo', 'alpha']);
  });
});

describe('MeshCoreNodesView — role icon (#3647)', () => {
  it('renders a role icon to the LEFT of the name and no text role label', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    // Companion (advType=1) uses the shared smartphone icon, one per row.
    const icons = document.querySelectorAll('.mc-node-row-name .mc-node-role-icon');
    expect(icons).toHaveLength(3);
    expect(icons[0].querySelector('.lucide-smartphone')).not.toBeNull();
    // The old text role label (.mc-node-row-type) is gone.
    expect(document.querySelector('.mc-node-row-type')).toBeNull();
    // The icon precedes the display name within the row.
    const rowName = document.querySelector('.mc-node-row-name')!;
    const spans = Array.from(rowName.querySelectorAll('span'));
    const iconIdx = spans.findIndex((s) => s.classList.contains('mc-node-role-icon'));
    const nameIdx = spans.findIndex((s) => s.classList.contains('mc-node-row-display-name'));
    expect(iconIdx).toBeGreaterThanOrEqual(0);
    expect(iconIdx).toBeLessThan(nameIdx);
  });
});

describe('MeshCoreNodesView — node-details quick access (#3350)', () => {
  it('renders a details button per row that navigates to the node detail screen', () => {
    const onNavigateToDm = vi.fn();
    render(
      <MeshCoreNodesView nodes={nodes} contacts={contacts} onNavigateToDm={onNavigateToDm} />,
    );
    const detailButtons = screen.getAllByLabelText('More details');
    expect(detailButtons).toHaveLength(3);
    fireEvent.click(detailButtons[0]);
    // Default sort is lastHeard desc, so the first row is alpha (PK_B).
    expect(onNavigateToDm).toHaveBeenCalledWith(PK_B);
  });

  it('double-clicking a row navigates to the node detail screen', () => {
    const onNavigateToDm = vi.fn();
    render(
      <MeshCoreNodesView nodes={nodes} contacts={contacts} onNavigateToDm={onNavigateToDm} />,
    );
    const main = document.querySelectorAll('.mc-node-row-main')[1] as HTMLElement;
    fireEvent.doubleClick(main);
    expect(onNavigateToDm).toHaveBeenCalledWith(PK_C); // Bravo, second by lastHeard desc
  });

  it('single click still selects the row (does not navigate)', () => {
    const onNavigateToDm = vi.fn();
    render(
      <MeshCoreNodesView nodes={nodes} contacts={contacts} onNavigateToDm={onNavigateToDm} />,
    );
    const main = document.querySelectorAll('.mc-node-row-main')[0] as HTMLElement;
    fireEvent.click(main);
    expect(onNavigateToDm).not.toHaveBeenCalled();
    expect(document.querySelector('.mc-node-row.selected')).not.toBeNull();
  });

  it('omits the details button when no navigation handler is provided', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect(screen.queryByLabelText('More details')).toBeNull();
  });
});

describe('MeshCoreNodesView — Discover menu (#3351)', () => {
  beforeEach(() => {
    showToast.mockReset();
  });

  it('hides the Discover button when canDiscover is false', () => {
    render(
      <MeshCoreNodesView
        nodes={nodes}
        contacts={contacts}
        onDiscoverNodes={vi.fn()}
        canDiscover={false}
      />,
    );
    expect(screen.queryByText('Discover')).toBeNull();
  });

  it('opens the menu and fires the chosen discovery mode, then toasts the result', async () => {
    const onDiscoverNodes = vi.fn().mockResolvedValue({ returned: 2, newCount: 1 });
    render(
      <MeshCoreNodesView
        nodes={nodes}
        contacts={contacts}
        onDiscoverNodes={onDiscoverNodes}
        canDiscover
      />,
    );
    fireEvent.click(screen.getByText('Discover'));
    fireEvent.click(screen.getByText('Discover Sensors'));
    expect(onDiscoverNodes).toHaveBeenCalledWith('sensors');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'success'));
  });

  it('toasts an error when discovery fails', async () => {
    const onDiscoverNodes = vi.fn().mockResolvedValue(null);
    render(
      <MeshCoreNodesView
        nodes={nodes}
        contacts={contacts}
        onDiscoverNodes={onDiscoverNodes}
        canDiscover
      />,
    );
    fireEvent.click(screen.getByText('Discover'));
    fireEvent.click(screen.getByText('Discover Repeaters'));
    expect(onDiscoverNodes).toHaveBeenCalledWith('repeaters');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Discovery failed', 'error'));
  });
});

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
}

describe('MeshCoreNodesView — list collapse toggle (mobile map access)', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewportWidth(1024); // desktop by default
  });

  it('collapses the list pane on desktop and hides header/list controls', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect(document.querySelector('.meshcore-list-pane.collapsed')).toBeNull();
    fireEvent.click(screen.getByTitle('Collapse node list'));
    expect(document.querySelector('.meshcore-list-pane.collapsed')).not.toBeNull();
    // Header content (title/search/list rows) is gone; only the toggle remains.
    expect(screen.queryByText('Nodes')).toBeNull();
    expect(screen.queryByPlaceholderText('Search nodes…')).toBeNull();
    expect(screen.getByTitle('Expand node list')).toBeTruthy();
  });

  it('expanding again restores the header/list controls', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    fireEvent.click(screen.getByTitle('Collapse node list'));
    fireEvent.click(screen.getByTitle('Expand node list'));
    expect(document.querySelector('.meshcore-list-pane.collapsed')).toBeNull();
    expect(screen.getByText('Nodes')).toBeTruthy();
  });

  it('persists the desktop collapse preference to localStorage', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    fireEvent.click(screen.getByTitle('Collapse node list'));
    expect(localStorage.getItem('meshcore-list-collapsed')).toBe('true');
  });

  it('restores the collapsed state from localStorage on mount', () => {
    localStorage.setItem('meshcore-list-collapsed', 'true');
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect(document.querySelector('.meshcore-list-pane.collapsed')).not.toBeNull();
  });

  it('on mobile, the toggle reveals the map instead of collapsing to a thin bar', () => {
    setViewportWidth(500);
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect(document.querySelector('.meshcore-two-pane.mobile-show-list')).not.toBeNull();
    fireEvent.click(screen.getByTitle('Collapse node list'));
    // Reveals the map pane via the existing mobile pane-swap mechanism...
    expect(document.querySelector('.meshcore-two-pane.mobile-show-content')).not.toBeNull();
    // ...rather than the desktop thin-bar collapsed state.
    expect(document.querySelector('.meshcore-list-pane.collapsed')).toBeNull();
  });
});

describe('MeshCoreNodesView — per-source age filter (#4412 Phase 4)', () => {
  const PK_RECENT = 'd'.repeat(64);
  const PK_OLD = 'e'.repeat(64);
  const PK_FAVORITE_OLD = 'f'.repeat(64);
  const PK_LOCAL = '1'.repeat(63) + '2';
  const PK_NO_TIMESTAMP_NODE = '3'.repeat(64);
  const PK_NO_TIMESTAMP_CONTACT = '4'.repeat(64);
  const PK_ADVERT_ONLY = '5'.repeat(64);
  const PK_ZERO_LAST_HEARD = '6'.repeat(64);

  it('lists a node within the cutoff and excludes one outside it', () => {
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_RECENT, name: 'Recent', advType: 1, lastHeard: NOW - 2 * HOUR_MS },
      { publicKey: PK_OLD, name: 'Old', advType: 1, lastHeard: NOW - 72 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
    expect(listedNames()).toEqual(['Recent']);
  });

  it('bypasses the cutoff for a favorite, still pinned to the top', () => {
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_RECENT, name: 'Recent', advType: 1, lastHeard: NOW - 2 * HOUR_MS },
      {
        publicKey: PK_FAVORITE_OLD,
        name: 'FavoriteOld',
        advType: 1,
        lastHeard: NOW - 72 * HOUR_MS,
        isFavorite: true,
      },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
    expect(listedNames()).toEqual(['FavoriteOld', 'Recent']);
  });

  it('bypasses the cutoff for the local node (isLocal flag, not the "(local)" name)', () => {
    // The `(local)` suffix stays as display text (#4438) — the exemption
    // itself is driven by `isLocal: true`, asserted separately from the
    // rendered string by the negative control below.
    const testContacts: MeshCoreContact[] = [
      { publicKey: PK_LOCAL, advName: 'MyNode (local)', isLocal: true, lastSeen: NOW - 72 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={[]} contacts={testContacts} />);
    expect(listedNames()).toEqual(['MyNode (local)']);
  });

  it('T-C4 negative control: a stranger named "(local)" without isLocal is NOT exempt from the cutoff', () => {
    // This is the exact bug #4438 exists to fix: a user-chosen device name
    // containing "(local)" must not be silently treated as the operator's
    // own node. Before the fix, `isAgeExempt` matched on this substring and
    // this contact bypassed the cutoff.
    const testContacts: MeshCoreContact[] = [
      { publicKey: PK_LOCAL, advName: 'Imposter (local)', isLocal: false, lastSeen: NOW - 72 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={[]} contacts={testContacts} />);
    expect(listedNames()).toEqual([]);
  });

  it('excludes rows with no resolvable timestamp', () => {
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_NO_TIMESTAMP_NODE, name: 'NoTimeNode', advType: 1 },
    ];
    const testContacts: MeshCoreContact[] = [
      { publicKey: PK_NO_TIMESTAMP_CONTACT, advName: 'NoTimeContact' },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={testContacts} />);
    expect(listedNames()).toEqual([]);
  });

  // #4899: repeaters (advType 2) and room servers (advType 3) get a SEPARATE,
  // usually longer age window (`maxInfraNodeAgeHours`) than companions.
  describe('infrastructure age window (#4899)', () => {
    const PK_INFRA_REPEATER = '7'.repeat(64);
    const PK_INFRA_ROOM = '8'.repeat(64);
    const PK_COMPANION = '9'.repeat(64);

    it('keeps a repeater that is past the companion cutoff but within the infra cutoff', () => {
      // companion=24h, infra=720h (defaults). A 72h-old repeater would be aged
      // off the companion window but survives on the infra window — the exact
      // "repeaters vanish from the map" bug this fixes.
      mockUseNodeDisplaySettings.mockReturnValue({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 });
      const testNodes: MeshCoreNode[] = [
        { publicKey: PK_INFRA_REPEATER, name: 'Repeater', advType: 2, lastHeard: NOW - 72 * HOUR_MS },
        { publicKey: PK_INFRA_ROOM, name: 'RoomServer', advType: 3, lastHeard: NOW - 72 * HOUR_MS },
      ];
      render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
      expect(listedNames().sort()).toEqual(['Repeater', 'RoomServer']);
    });

    it('still hides a repeater older than the infra cutoff', () => {
      mockUseNodeDisplaySettings.mockReturnValue({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 });
      const testNodes: MeshCoreNode[] = [
        { publicKey: PK_INFRA_REPEATER, name: 'DeadRepeater', advType: 2, lastHeard: NOW - 800 * HOUR_MS },
      ];
      render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
      expect(listedNames()).toEqual([]);
    });

    it('never hides infrastructure when the infra window is 0 (never expire)', () => {
      mockUseNodeDisplaySettings.mockReturnValue({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 0 });
      const testNodes: MeshCoreNode[] = [
        { publicKey: PK_INFRA_REPEATER, name: 'AncientRepeater', advType: 2, lastHeard: NOW - 5000 * HOUR_MS },
      ];
      render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
      expect(listedNames()).toEqual(['AncientRepeater']);
    });

    it('applies the companion (not infra) window to a companion node', () => {
      // A companion 72h old with companion=24h/infra=720h must still be hidden —
      // the infra window must not leak onto advType 1.
      mockUseNodeDisplaySettings.mockReturnValue({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 });
      const testNodes: MeshCoreNode[] = [
        { publicKey: PK_COMPANION, name: 'OldCompanion', advType: 1, lastHeard: NOW - 72 * HOUR_MS },
      ];
      render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
      expect(listedNames()).toEqual([]);
    });
  });

  it('falls through a `lastHeard: 0` DB row to the contact\'s lastSeen (merge gap regression, #4433 review)', () => {
    // A node row persisted with `lastHeard: 0` must NOT be treated as "known
    // and stale" by the merge — `0` means "unknown" (matching
    // meshcoreLastHeardMs), so it should fall through to the contact's own
    // lastSeen, which here is recent enough to survive the cutoff.
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_ZERO_LAST_HEARD, name: 'ZeroLastHeard', advType: 1, lastHeard: 0 },
    ];
    const testContacts: MeshCoreContact[] = [
      { publicKey: PK_ZERO_LAST_HEARD, lastSeen: NOW - 2 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={testContacts} />);
    expect(listedNames()).toEqual(['ZeroLastHeard']);
  });

  it('resolves a lastAdvert-only contact (seconds) and applies the cutoff correctly', () => {
    const testContacts: MeshCoreContact[] = [
      {
        publicKey: PK_ADVERT_ONLY,
        advName: 'AdvertOnly',
        lastAdvert: Math.floor((NOW - 2 * HOUR_MS) / 1000),
      },
    ];
    render(<MeshCoreNodesView nodes={[]} contacts={testContacts} />);
    expect(listedNames()).toEqual(['AdvertOnly']);
  });

  it('does not misinterpret a millisecond lastHeard as seconds (unit regression guard)', () => {
    // If this value were ever divided/treated as seconds it would resolve to
    // a date in 1970 and be excluded by the 24h cutoff below.
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_RECENT, name: 'Recent', advType: 1, lastHeard: NOW - 2 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
    expect(listedNames()).toEqual(['Recent']);
  });

  it('passes the same age-filtered set down to the map', () => {
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_RECENT, name: 'Recent', advType: 1, lastHeard: NOW - 2 * HOUR_MS },
      {
        publicKey: PK_FAVORITE_OLD,
        name: 'FavoriteOld',
        advType: 1,
        lastHeard: NOW - 72 * HOUR_MS,
        isFavorite: true,
      },
      { publicKey: PK_OLD, name: 'Old', advType: 1, lastHeard: NOW - 72 * HOUR_MS },
    ];
    const testContacts: MeshCoreContact[] = [
      { publicKey: PK_RECENT, lastSeen: NOW - 2 * HOUR_MS },
      { publicKey: PK_FAVORITE_OLD, lastSeen: NOW - 72 * HOUR_MS },
      { publicKey: PK_OLD, lastSeen: NOW - 72 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={testContacts} />);
    expect(meshCoreMapProps).toHaveBeenCalled();
    const lastCall = meshCoreMapProps.mock.calls[meshCoreMapProps.mock.calls.length - 1][0] as {
      contacts: MeshCoreContact[];
    };
    const mapKeys = lastCall.contacts.map((c) => c.publicKey);
    expect(mapKeys).toContain(PK_RECENT);
    expect(mapKeys).toContain(PK_FAVORITE_OLD);
    expect(mapKeys).not.toContain(PK_OLD);
  });

  it('re-lists a previously aged-out node when maxNodeAgeHours grows from 24 to 168', () => {
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_OLD, name: 'Old', advType: 1, lastHeard: NOW - 72 * HOUR_MS },
    ];
    mockUseNodeDisplaySettings.mockReturnValue({ maxNodeAgeHours: 24 });
    const { rerender } = render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
    expect(listedNames()).toEqual([]);

    mockUseNodeDisplaySettings.mockReturnValue({ maxNodeAgeHours: 168 });
    rerender(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
    expect(listedNames()).toEqual(['Old']);
  });

  it('search narrows within the age-filtered set (age -> sort -> search order)', () => {
    const testNodes: MeshCoreNode[] = [
      { publicKey: PK_RECENT, name: 'Recent', advType: 1, lastHeard: NOW - 2 * HOUR_MS },
      // Matches the same search text but was already aged out — proves the
      // filter runs before search, not after.
      { publicKey: PK_OLD, name: 'RecentButOld', advType: 1, lastHeard: NOW - 72 * HOUR_MS },
    ];
    render(<MeshCoreNodesView nodes={testNodes} contacts={[]} />);
    fireEvent.change(screen.getByPlaceholderText('Search nodes…'), { target: { value: 'Recent' } });
    expect(listedNames()).toEqual(['Recent']);
  });
});
