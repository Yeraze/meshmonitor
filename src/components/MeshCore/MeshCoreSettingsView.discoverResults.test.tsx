/**
 * The discovery-results list (#4516).
 *
 * A sweep used to report only "N returned (M new)" in a toast, so a user had
 * no idea *which* nodes answered. These tests cover the table that replaced
 * that: both SNR directions, the new-node marker, and the reset-per-run rule.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreSettingsView } from './MeshCoreSettingsView';
import type { DiscoveredNode } from './hooks/useMeshCore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const base = typeof fallback === 'string' ? fallback : key;
      const vars = (typeof fallback === 'object' ? fallback : opts) ?? {};
      return base.replace(/\{\{(\w+)\}\}/g, (_m, k) => String((vars as Record<string, unknown>)[k] ?? ''));
    },
  }),
}));

vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
// Not under test; it fetches on mount.
vi.mock('./MeshCoreNodeDisplaySection', () => ({
  MeshCoreNodeDisplaySection: () => null,
}));

const NEARBY = 'Discover Nearby Nodes';

/**
 * Every action the view destructures or calls. Stubbed in one place so a new
 * dependency fails loudly here rather than as a cryptic
 * "x is not a function" inside a render.
 */
function makeActions(discoverNodes: ReturnType<typeof vi.fn>) {
  return {
    discoverNodes,
    getDiscoverable: vi.fn().mockResolvedValue(false),
    setDiscoverable: vi.fn().mockResolvedValue(true),
    getDefaultScope: vi.fn().mockResolvedValue(''),
    setDefaultScope: vi.fn().mockResolvedValue(true),
    discoverRegions: vi.fn().mockResolvedValue(null),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
    addSavedRegion: vi.fn().mockResolvedValue(true),
    deleteSavedRegion: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    purgeAllMessages: vi.fn().mockResolvedValue(true),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(true),
  } as never;
}

function renderView(nodes: DiscoveredNode[], opts: { returned?: number; newCount?: number } = {}) {
  const discoverNodes = vi.fn().mockResolvedValue({
    returned: opts.returned ?? nodes.length,
    newCount: opts.newCount ?? nodes.filter((n) => n.isNew).length,
    nodes,
  });
  render(
    <MeshCoreSettingsView
      status={{ connected: true, deviceType: 1 } as never}
      loading={false}
      actions={makeActions(discoverNodes)}
      baseUrl=""
      sourceId="src-a"
    />,
  );
  return { discoverNodes };
}

const node = (over: Partial<DiscoveredNode> = {}): DiscoveredNode => ({
  publicKey: 'a'.repeat(64),
  name: 'Yeraze Repeater',
  advType: 2,
  snr: 6.25,
  snrToNode: 4,
  rssi: -42,
  isNew: false,
  ...over,
});

describe('MeshCoreSettingsView — discovery results (#4516)', () => {
  it('lists each responder with a key snippet and both SNR directions', async () => {
    const user = userEvent.setup();
    renderView([node()]);

    await user.click(screen.getByRole('button', { name: NEARBY }));

    await waitFor(() => expect(screen.getByText('Yeraze Repeater')).toBeInTheDocument());
    // Key is abbreviated — the full 64 chars would swamp the row.
    expect(screen.getByText(/^aaaaaaaaaaaa…$/)).toBeInTheDocument();
    expect(screen.getByText('6.25 dB')).toBeInTheDocument();  // SNR here
    expect(screen.getByText('4.00 dB')).toBeInTheDocument();  // SNR at node
  });

  it('marks a newly-discovered node and leaves a known one unmarked', async () => {
    const user = userEvent.setup();
    renderView([
      node({ publicKey: 'a'.repeat(64), name: 'Known One', isNew: false }),
      node({ publicKey: 'b'.repeat(64), name: 'Fresh One', isNew: true }),
    ]);

    await user.click(screen.getByRole('button', { name: NEARBY }));

    await waitFor(() => expect(screen.getByText('Fresh One')).toBeInTheDocument());
    expect(screen.getAllByText('NEW')).toHaveLength(1);
  });

  it('shows a placeholder for a responder with no name', async () => {
    // A repeater that has never advertised has no name anywhere; the row must
    // still appear, since its key and signal are the useful part.
    const user = userEvent.setup();
    renderView([node({ name: null })]);

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
  });

  it('renders a dash rather than NaN when a signal reading is missing', async () => {
    const user = userEvent.setup();
    renderView([node({ snr: null, snrToNode: null })]);

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('Yeraze Repeater')).toBeInTheDocument());
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('replaces the previous run rather than accumulating across runs', async () => {
    // The issue asks for the list to reset each time; otherwise a node that has
    // since gone out of range would linger and read as still reachable.
    const user = userEvent.setup();
    const discoverNodes = vi.fn()
      .mockResolvedValueOnce({ returned: 1, newCount: 0, nodes: [node({ name: 'First Run' })] })
      .mockResolvedValueOnce({ returned: 1, newCount: 0, nodes: [node({ name: 'Second Run' })] });
    render(
      <MeshCoreSettingsView
        status={{ connected: true, deviceType: 1 } as never}
        loading={false} actions={makeActions(discoverNodes)} baseUrl="" sourceId="src-a"
      />,
    );

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('First Run')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('Second Run')).toBeInTheDocument());
    expect(screen.queryByText('First Run')).toBeNull();
  });

  it('shows no table before the first sweep', () => {
    renderView([node()]);
    expect(screen.queryByText('Yeraze Repeater')).toBeNull();
  });
});
