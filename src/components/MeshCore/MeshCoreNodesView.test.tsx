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

vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: () => <div data-testid="mc-map" />,
}));

const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';
import type { MeshCoreNode } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

const nodes: MeshCoreNode[] = [
  { publicKey: PK_A, name: 'Charlie', advType: 1, lastHeard: 1000 },
  { publicKey: PK_B, name: 'alpha', advType: 1, lastHeard: 3000 },
  { publicKey: PK_C, name: 'Bravo', advType: 1, lastHeard: 2000 },
];

const contacts: MeshCoreContact[] = [];

function listedNames(): string[] {
  // The display name carries the stable `.mc-node-row-display-name` class; a
  // role icon (#3647) and other indicators may precede it in the row.
  const rows = Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-name'));
  return rows.map((el) => el.querySelector('.mc-node-row-display-name')?.textContent || '');
}

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
