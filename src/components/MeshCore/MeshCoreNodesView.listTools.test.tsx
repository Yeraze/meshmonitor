/**
 * @vitest-environment jsdom
 *
 * MeshCore Nodes list tools (#6259): shared sort fields, persisted sort,
 * battery/hops chips, advanced filter, group by role, export.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const meshCoreMapProps = vi.fn();
vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: (props: Record<string, unknown>) => {
    meshCoreMapProps(props);
    return <div data-testid="mc-map" />;
  },
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test', sourceType: 'meshcore' }),
}));
vi.mock('../../hooks/useNodeDisplaySettings', () => ({
  useNodeDisplaySettings: () => ({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 }),
}));
const exportNodeList = vi.fn();
vi.mock('../../utils/nodeExport', async (orig) => ({
  ...(await orig<typeof import('../../utils/nodeExport')>()),
  exportNodeList: (...a: unknown[]) => exportNodeList(...a),
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';
import type { MeshCoreNode } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const NOW = Date.now();
const H = 3600_000;
const pk = (c: string) => c.repeat(64);

const nodes: MeshCoreNode[] = [
  { publicKey: pk('a'), name: 'Alpha', advType: 1, lastHeard: NOW - 1 * H, batteryMv: 3700, uptimeSecs: 100, snr: 2 },
  { publicKey: pk('b'), name: 'Bravo', advType: 2, lastHeard: NOW - 2 * H, batteryMv: 4100, uptimeSecs: 900, snr: 8, isFavorite: true },
  { publicKey: pk('c'), name: 'Charlie', advType: 1, lastHeard: NOW - 3 * H },
];
const contacts: MeshCoreContact[] = [
  { publicKey: pk('a'), advName: 'Alpha', pathLen: 3, latitude: 1, longitude: 2 },
  { publicKey: pk('b'), advName: 'Bravo', pathLen: 0 },
];

function names(): string[] {
  return Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-display-name')).map((e) => e.textContent || '');
}
const sortBy = (v: string) => fireEvent.change(screen.getByTitle('Sort by'), { target: { value: v } });

beforeEach(() => {
  localStorage.clear();
  meshCoreMapProps.mockClear();
  exportNodeList.mockClear();
});

describe('MeshCoreNodesView list tools (#6259)', () => {
  it('sorts by battery with missing values last when descending, favorites first', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    sortBy('battery');
    // Bravo is a favorite so pins first; then Alpha (3700) before Charlie (none).
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('sorts by uptime, snr and hops', () => {
    render(<MeshCoreNodesView nodes={nodes.map((n) => ({ ...n, isFavorite: false }))} contacts={contacts} />);
    sortBy('uptime');
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    sortBy('snr');
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    sortBy('hops');
    // desc: unknown (999) first, then 3, then 0
    expect(names()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('keeps the sort after a remount', () => {
    const { unmount } = render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    sortBy('battery');
    unmount();
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect((screen.getByTitle('Sort by') as HTMLSelectElement).value).toBe('battery');
    expect(localStorage.getItem('meshcoreNodesSort')).toContain('battery');
  });

  it('shows voltage and hops chips', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect(screen.getByText(/4\.10V/)).toBeTruthy();
    expect(screen.getByText(/3\.70V/)).toBeTruthy();
    const chips = screen.getAllByTitle('nodes.hops_away').map((e) => e.textContent?.trim());
    expect(chips.some((c) => c?.startsWith('3'))).toBe(true);
    expect(chips.some((c) => c?.startsWith('0'))).toBe(true);
  });

  it('filters by role through the advanced popup, and the map follows the list', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    fireEvent.click(screen.getByTitle('Filter nodes'));
    const dialogScope = document.body;
    const box = within(dialogScope).getAllByLabelText('Repeater').find((e) => e.tagName === 'INPUT')!;
    fireEvent.click(box);
    // All roles start checked; unchecking Repeater leaves the other four.
    expect(names()).toEqual(['Alpha', 'Charlie']);
    const last = meshCoreMapProps.mock.calls.at(-1)![0] as { contacts: Array<{ publicKey: string }> };
    expect(last.contacts.map((c) => c.publicKey)).toEqual([pk('a')]); // c has no contact record
    expect(localStorage.getItem('meshcoreNodeFilters')).toContain('"deviceRoles":[0,1,3,4]');
  });

  it('hides ignored nodes until show ignored is on', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} ignoredKeys={new Set([pk('c')])} />);
    expect(names()).toEqual(['Alpha', 'Bravo'].sort((x, y) => names().indexOf(x) - names().indexOf(y)));
    expect(names()).not.toContain('Charlie');
    fireEvent.click(screen.getByTitle('Filter nodes'));
    fireEvent.click(within(document.body).getByLabelText(/ignored/i));
    expect(names()).toContain('Charlie');
  });

  it('groups by role with collapsible headers', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    fireEvent.click(screen.getByTitle('Group nodes by role'));
    const headers = screen.getAllByRole('button', { expanded: true });
    expect(headers.length).toBeGreaterThanOrEqual(2);
    expect(localStorage.getItem('groupNodesByRole')).toBe('true');
    expect(names().sort()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('exports the displayed rows with the MeshCore columns', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    fireEvent.click(screen.getByTitle('Export node list'));
    fireEvent.click(screen.getByText('CSV'));
    const [format, cols, rows, opts] = exportNodeList.mock.calls[0] as [string, Array<{ label: string }>, unknown[], { filenamePrefix: string }];
    expect(format).toBe('csv');
    expect(cols.map((c) => c.label)).toEqual([
      'Name', 'Public Key', 'Type', 'Hops', 'SNR', 'RSSI', 'Battery (V)', 'Uptime (s)',
      'Latitude', 'Longitude', 'Last Heard', 'First Heard',
    ]);
    expect(rows).toHaveLength(3);
    expect(opts.filenamePrefix).toBe('meshcore-nodes');
  });
});
