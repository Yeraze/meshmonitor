/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import DashboardSidebar from './DashboardSidebar';
import type { DashboardSource, SourceStatus } from '../../hooks/useDashboardData';
import { UNIFIED_SOURCE_ID } from '../../hooks/useDashboardData';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: vi.fn(actual.useNavigate),
  };
});

// PR-C: kebab/prune gating now consults AuthContext.hasPermission instead
// of the legacy isAdmin prop. Default true so the bulk of pre-existing
// tests (which exercise unrelated behavior) keep passing.
const hasPermissionMock = vi.fn(() => true);
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

const makeSources = (): DashboardSource[] => [
  { id: 'src-1', name: 'Source Alpha', type: 'tcp', enabled: true },
  { id: 'src-2', name: 'Source Beta', type: 'mqtt', enabled: true },
  { id: 'src-3', name: 'Source Gamma', type: 'meshcore', enabled: false },
];

const makeStatusMap = (): Map<string, SourceStatus | null> =>
  new Map([
    ['src-1', { sourceId: 'src-1', connected: true }],
    ['src-2', { sourceId: 'src-2', connected: false }],
    ['src-3', null],
  ]);

const makeNodeCounts = (): Map<string, number> =>
  new Map([
    ['src-1', 5],
    ['src-2', 3],
    ['src-3', 0],
  ]);

const defaultProps = {
  sources: makeSources(),
  statusMap: makeStatusMap(),
  nodeCounts: makeNodeCounts(),
  selectedSourceId: null,
  onSelectSource: vi.fn(),
  isAdmin: false,
  isAuthenticated: true,
  onAddSource: vi.fn(),
  onEditSource: vi.fn(),
  onToggleSource: vi.fn(),
  onDeleteSource: vi.fn(),
};

function renderSidebar(props: Partial<typeof defaultProps> = {}) {
  return render(
    <MemoryRouter>
      <DashboardSidebar {...defaultProps} {...props} />
    </MemoryRouter>,
  );
}

describe('DashboardSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to "all sources writable" for the bulk of these tests; the
    // PR-C gating block below overrides as needed.
    hasPermissionMock.mockImplementation(() => true);
  });

  it('renders all source names', () => {
    renderSidebar();
    expect(screen.getByText('Source Alpha')).toBeInTheDocument();
    expect(screen.getByText('Source Beta')).toBeInTheDocument();
    expect(screen.getByText('Source Gamma')).toBeInTheDocument();
  });

  it('selected card has .selected class', () => {
    renderSidebar({ selectedSourceId: 'src-2' });
    const cards = document.querySelectorAll('.dashboard-source-card');
    expect(cards[0]).not.toHaveClass('selected');
    expect(cards[1]).toHaveClass('selected');
    expect(cards[2]).not.toHaveClass('selected');
  });

  it('calls onSelectSource when clicking a card', () => {
    const onSelectSource = vi.fn();
    renderSidebar({ onSelectSource });
    fireEvent.click(screen.getByText('Source Alpha').closest('.dashboard-source-card')!);
    expect(onSelectSource).toHaveBeenCalledWith('src-1');
  });

  it('shows node count for authenticated users', () => {
    renderSidebar({ isAuthenticated: true });
    // t() mock returns key with {{count}} interpolation stripped (pluralized key)
    const counts = screen.getAllByText(/source\.node_count/);
    expect(counts.length).toBeGreaterThanOrEqual(2);
  });

  it('shows lock icon and not node count for unauthenticated users', () => {
    renderSidebar({ isAuthenticated: false });
    const locks = screen.getAllByText('🔒');
    expect(locks.length).toBeGreaterThan(0);
    expect(screen.queryByText(/source\.node_count/)).not.toBeInTheDocument();
  });

  it('shows kebab menu button when caller has sources:write on each source', () => {
    // PR-C: kebab visibility is gated by per-source sources:write rather
    // than the legacy isAdmin prop. With the default mock granting all
    // sources, every card renders its kebab.
    renderSidebar({ isAdmin: true });
    const kebabBtns = screen.getAllByRole('button', { name: 'source.options' });
    expect(kebabBtns).toHaveLength(3);
  });

  it('does NOT show kebab menu when caller lacks sources:write on all sources', () => {
    hasPermissionMock.mockImplementation(() => false);
    renderSidebar({ isAdmin: false });
    expect(screen.queryByRole('button', { name: 'source.options' })).not.toBeInTheDocument();
  });

  // PR-C: per-source `sources:write` gating for the Prune Outside ROI
  // kebab. (a) non-admin with sources:write on the specific source still
  // sees the kebab; (b) admin without sources:write does not.
  it('non-admin with sources:write on a source sees the kebab on that source', () => {
    // Only grant src-2; others should be hidden.
    hasPermissionMock.mockImplementation((_resource: string, _action: string, opts?: { sourceId?: string | null }) => {
      return opts?.sourceId === 'src-2';
    });
    renderSidebar({ isAdmin: false });
    const kebabBtns = screen.queryAllByRole('button', { name: 'source.options' });
    expect(kebabBtns).toHaveLength(1);
  });

  it('admin without sources:write on any source does not see the kebab', () => {
    // The hasPermission consumer in DashboardSidebar treats false as no
    // kebab; the admin short-circuit lives inside the real useAuth hook,
    // which is mocked here. Verifying the mock-driven behavior is enough
    // to prove the gate flipped from isAdmin to the permission call.
    hasPermissionMock.mockImplementation(() => false);
    renderSidebar({ isAdmin: true });
    expect(screen.queryByRole('button', { name: 'source.options' })).not.toBeInTheDocument();
  });

  it('renders mesh-activity badge with the live tone when most heard nodes are recent', () => {
    const statusMap = new Map<string, SourceStatus | null>([
      ['src-1', { sourceId: 'src-1', connected: true, activeNodeCount: 4 }],
      ['src-2', { sourceId: 'src-2', connected: false }],
      ['src-3', null],
    ]);
    renderSidebar({ statusMap });
    const live = document.querySelector('.dashboard-activity-live');
    expect(live).toBeInTheDocument();
    // The i18n test mock returns keys verbatim — verify the mesh-activity
    // key wires through (interpolation isn't exercised here).
    expect(live?.textContent).toMatch(/source\.node_activity/);
  });

  it('renders mesh-activity badge with idle tone when zero nodes heard recently', () => {
    const statusMap = new Map<string, SourceStatus | null>([
      ['src-1', { sourceId: 'src-1', connected: true, activeNodeCount: 0 }],
      ['src-2', { sourceId: 'src-2', connected: false }],
      ['src-3', null],
    ]);
    renderSidebar({ statusMap });
    expect(document.querySelector('.dashboard-activity-idle')).toBeInTheDocument();
  });

  it('omits mesh-activity badge when activeNodeCount is missing from server', () => {
    // Older server / pre-migration deployment — graceful fallback
    const statusMap = new Map<string, SourceStatus | null>([
      ['src-1', { sourceId: 'src-1', connected: true }],
      ['src-2', { sourceId: 'src-2', connected: false }],
      ['src-3', null],
    ]);
    renderSidebar({ statusMap });
    expect(document.querySelector('.dashboard-activity-badge')).not.toBeInTheDocument();
  });

  it('shows sidebar navigation links', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /source\.sidebar\.unified_messages/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /source\.sidebar\.unified_telemetry/ })).toBeInTheDocument();
  });

  it('renders Map Analysis link below the unified links and navigates to /analysis on click', async () => {
    const navigate = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigate);

    renderSidebar(); // existing helper from this file

    const link = await screen.findByRole('button', { name: /source\.sidebar\.map_analysis/i });
    expect(link).toBeInTheDocument();

    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('/analysis');
  });

  it('disables Open button for disabled sources', () => {
    renderSidebar();
    const openButtons = screen.getAllByRole('button', { name: 'source.open' });
    // src-1 (enabled) and src-2 (enabled) should NOT be disabled
    expect(openButtons[0]).not.toBeDisabled();
    expect(openButtons[1]).not.toBeDisabled();
    // src-3 (disabled) should be disabled
    expect(openButtons[2]).toBeDisabled();
  });

  describe('Unified pseudo-source', () => {
    const unifiedSource: DashboardSource = {
      id: UNIFIED_SOURCE_ID,
      name: 'Unified',
      type: '__unified__',
      enabled: true,
    };

    const renderWithUnified = (props: Partial<typeof defaultProps> = {}) => {
      const sourcesWithUnified = [unifiedSource, ...makeSources()];
      const nodeCounts = new Map<string, number>([
        [UNIFIED_SOURCE_ID, 7],
        ['src-1', 5],
        ['src-2', 3],
        ['src-3', 0],
      ]);
      return renderSidebar({
        sources: sourcesWithUnified,
        nodeCounts,
        ...props,
      });
    };

    it('renders the Unified card when the synthetic source is in the list', () => {
      renderWithUnified();
      expect(screen.getByText('Unified')).toBeInTheDocument();
    });

    it('does NOT render an Open button for the Unified card', () => {
      renderWithUnified();
      // Three real sources still get Open buttons; the Unified card adds none.
      const openButtons = screen.getAllByRole('button', { name: 'source.open' });
      expect(openButtons).toHaveLength(3);
    });

    it('does NOT render a kebab menu for the Unified card even for admin users', () => {
      renderWithUnified({ isAdmin: true });
      // Three real sources keep their kebabs; Unified gets none.
      const kebabs = screen.getAllByRole('button', { name: 'source.options' });
      expect(kebabs).toHaveLength(3);
    });

    it('does NOT render a type/VN badge for the Unified card', () => {
      renderWithUnified();
      // The synthetic type token must never surface as a visible badge.
      expect(screen.queryByText('__unified__')).not.toBeInTheDocument();
    });

    it('shows connected status when at least one backing source is connected', () => {
      renderWithUnified();
      const unifiedCard = screen.getByText('Unified').closest('.dashboard-source-card')!;
      const dot = unifiedCard.querySelector('.dashboard-status-dot');
      expect(dot).not.toBeNull();
      expect(dot?.classList.contains('connected')).toBe(true);
    });

    it('shows disconnected status when no backing source is connected', () => {
      const allDown: Map<string, SourceStatus | null> = new Map([
        ['src-1', { sourceId: 'src-1', connected: false }],
        ['src-2', { sourceId: 'src-2', connected: false }],
        ['src-3', null],
      ]);
      renderWithUnified({ statusMap: allDown });
      const unifiedCard = screen.getByText('Unified').closest('.dashboard-source-card')!;
      const dot = unifiedCard.querySelector('.dashboard-status-dot');
      expect(dot?.classList.contains('disconnected')).toBe(true);
    });

    it('selects Unified when its card is clicked', () => {
      const onSelectSource = vi.fn();
      renderWithUnified({ onSelectSource });
      fireEvent.click(screen.getByText('Unified').closest('.dashboard-source-card')!);
      expect(onSelectSource).toHaveBeenCalledWith(UNIFIED_SOURCE_ID);
    });
  });

  describe('Per-gateway publisher badge (mqtt_bridge)', () => {
    const bridgeSources: DashboardSource[] = [
      { id: 'bridge-1', name: 'Bridge Up', type: 'mqtt_bridge', enabled: true },
    ];

    function statusWithPublishers(
      publishers: Record<string, { connected: boolean; publishes: number; lastError: string | null }>,
    ): Map<string, SourceStatus | null> {
      return new Map([
        [
          'bridge-1',
          {
            sourceId: 'bridge-1',
            connected: true,
            publishers,
          } as SourceStatus,
        ],
      ]);
    }

    it('renders a "N gateways" badge with the connected style when every pool entry is connected', () => {
      renderSidebar({
        sources: bridgeSources,
        statusMap: statusWithPublishers({
          '!aabbccdd': { connected: true, publishes: 5, lastError: null },
          '!11223344': { connected: true, publishes: 2, lastError: null },
        }),
        nodeCounts: new Map([['bridge-1', 0]]),
      });
      const badge = document.querySelector('.dashboard-publisher-badge')!;
      expect(badge).not.toBeNull();
      // The i18n test mock returns keys verbatim — assert the "all
      // connected" key wired through (interpolation isn't exercised).
      expect(badge.textContent).toMatch(/source\.publishers_all_connected/);
      // No partial modifier when everyone's connected.
      expect(badge.classList.contains('dashboard-publisher-partial')).toBe(false);
      // Tooltip lists each publisher's clientId + state + publish count.
      const title = badge.getAttribute('title') ?? '';
      expect(title).toContain('✓ !aabbccdd');
      expect(title).toContain('(5 pubs)');
      expect(title).toContain('✓ !11223344');
      expect(title).toContain('(2 pubs)');
    });

    it('switches to partial style + alternate key when at least one publisher is down', () => {
      renderSidebar({
        sources: bridgeSources,
        statusMap: statusWithPublishers({
          '!aabbccdd': { connected: true, publishes: 5, lastError: null },
          '!11223344': { connected: false, publishes: 0, lastError: 'CONNACK 5 NOT_AUTHORIZED' },
        }),
        nodeCounts: new Map([['bridge-1', 0]]),
      });
      const badge = document.querySelector('.dashboard-publisher-badge')!;
      expect(badge.textContent).toMatch(/source\.publishers_partial/);
      expect(badge.classList.contains('dashboard-publisher-partial')).toBe(true);
      // Down entry's last error surfaces in the tooltip so the operator
      // can diagnose without opening DevTools.
      expect(badge.getAttribute('title') ?? '').toContain('CONNACK 5 NOT_AUTHORIZED');
    });

    it('renders no badge when the bridge is in single mode (publishers map empty)', () => {
      renderSidebar({
        sources: bridgeSources,
        statusMap: statusWithPublishers({}),
        nodeCounts: new Map([['bridge-1', 0]]),
      });
      expect(document.querySelector('.dashboard-publisher-badge')).toBeNull();
    });

    it('renders no badge for non-mqtt_bridge sources even if publishers field is present', () => {
      const tcpSource: DashboardSource[] = [
        { id: 'src-x', name: 'Some TCP', type: 'meshtastic_tcp', enabled: true },
      ];
      const statusMap: Map<string, SourceStatus | null> = new Map([
        [
          'src-x',
          {
            sourceId: 'src-x',
            connected: true,
            publishers: { '!aabbccdd': { connected: true, publishes: 1, lastError: null } },
          } as SourceStatus,
        ],
      ]);
      renderSidebar({
        sources: tcpSource,
        statusMap,
        nodeCounts: new Map([['src-x', 0]]),
      });
      expect(document.querySelector('.dashboard-publisher-badge')).toBeNull();
    });
  });

  // Issue #3355 — drag handles are hidden until the admin enters Edit mode.
  describe('Edit mode (drag-reorder gating)', () => {
    const queryDragHandles = () =>
      document.querySelectorAll('[title="Drag to reorder"]');

    it('does NOT render the Edit button when reordering is not wired up', () => {
      // No onReorderSources prop → canReorder is false regardless of perms.
      renderSidebar();
      expect(
        screen.queryByRole('button', { name: 'source.edit_mode' }),
      ).not.toBeInTheDocument();
    });

    it('does NOT render the Edit button without sources:write permission', () => {
      hasPermissionMock.mockImplementation(() => false);
      renderSidebar({ onReorderSources: vi.fn() });
      expect(
        screen.queryByRole('button', { name: 'source.edit_mode' }),
      ).not.toBeInTheDocument();
    });

    it('renders the Edit button for a permitted viewer with reorder wired up', () => {
      renderSidebar({ onReorderSources: vi.fn() });
      expect(
        screen.getByRole('button', { name: 'source.edit_mode' }),
      ).toBeInTheDocument();
    });

    it('hides drag handles until Edit mode is toggled on', () => {
      renderSidebar({ onReorderSources: vi.fn() });
      // Default: no handles.
      expect(queryDragHandles().length).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: 'source.edit_mode' }));

      // Edit mode on: one handle per real (non-unified) source.
      expect(queryDragHandles().length).toBe(3);
      // Button label flips to "Done".
      expect(
        screen.getByRole('button', { name: 'source.edit_mode_done' }),
      ).toBeInTheDocument();
    });

    it('hides drag handles again when Edit mode is toggled off', () => {
      renderSidebar({ onReorderSources: vi.fn() });
      const toggle = screen.getByRole('button', { name: 'source.edit_mode' });
      fireEvent.click(toggle);
      expect(queryDragHandles().length).toBe(3);
      fireEvent.click(screen.getByRole('button', { name: 'source.edit_mode_done' }));
      expect(queryDragHandles().length).toBe(0);
    });
  });

  // Issue #3356 — resizable sidebar with persisted width.
  describe('Resizable sidebar', () => {
    const WIDTH_KEY = 'dashboard-sidebar-width';

    beforeEach(() => {
      window.localStorage.clear();
    });

    const getAside = () => document.querySelector('aside.dashboard-sidebar') as HTMLElement;

    it('renders a resize handle', () => {
      renderSidebar();
      expect(
        screen.getByRole('separator', { name: 'source.resize_sidebar' }),
      ).toBeInTheDocument();
    });

    it('applies the default width as a CSS variable when none is persisted', () => {
      renderSidebar();
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('240px');
    });

    it('loads a persisted width from localStorage', () => {
      window.localStorage.setItem(WIDTH_KEY, '320');
      renderSidebar();
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('320px');
    });

    it('clamps an out-of-range persisted width to the max bound', () => {
      window.localStorage.setItem(WIDTH_KEY, '9999');
      renderSidebar();
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('480px');
    });

    it('resizes via arrow keys and persists the new width', () => {
      renderSidebar();
      const handle = screen.getByRole('separator', { name: 'source.resize_sidebar' });
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('256px');
      expect(window.localStorage.getItem(WIDTH_KEY)).toBe('256');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('240px');
      expect(window.localStorage.getItem(WIDTH_KEY)).toBe('240');
    });

    it('does not shrink below the minimum width via keyboard', () => {
      window.localStorage.setItem(WIDTH_KEY, '208'); // 8px above the 200 min
      renderSidebar();
      const handle = screen.getByRole('separator', { name: 'source.resize_sidebar' });
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      // 208 - 16 would be 192, clamped to the 200 minimum.
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('200px');
    });

    it('resizes via pointer drag and persists on pointer up', () => {
      renderSidebar();
      const handle = screen.getByRole('separator', { name: 'source.resize_sidebar' });
      fireEvent.pointerDown(handle, { clientX: 240 });
      fireEvent.pointerMove(window, { clientX: 300 });
      expect(getAside().style.getPropertyValue('--dashboard-sidebar-width')).toBe('300px');
      fireEvent.pointerUp(window, { clientX: 300 });
      expect(window.localStorage.getItem(WIDTH_KEY)).toBe('300');
    });
  });
});
