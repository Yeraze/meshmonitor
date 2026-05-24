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

  /**
   * Regression coverage for the fix where MQTT row-click was auto-
   * navigating to the per-source detail page (introduced in #3169),
   * hiding the explicit Open affordance. The expected UX is identical
   * across source types: row-click selects in-pane, the Open button
   * navigates. Both broker and bridge must surface that Open button.
   */
  describe('MQTT source behavior parity', () => {
    const makeMqttSources = (): DashboardSource[] => [
      { id: 'src-broker', name: 'Local Broker', type: 'mqtt_broker', enabled: true },
      { id: 'src-bridge', name: 'Upstream Bridge', type: 'mqtt_bridge', enabled: true },
    ];

    it('row-click on an mqtt_broker calls onSelectSource (does NOT auto-navigate)', () => {
      const onSelectSource = vi.fn();
      const navigate = vi.fn();
      vi.mocked(useNavigate).mockReturnValue(navigate);
      renderSidebar({ sources: makeMqttSources(), onSelectSource });
      fireEvent.click(screen.getByText('Local Broker').closest('.dashboard-source-card')!);
      expect(onSelectSource).toHaveBeenCalledWith('src-broker');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('row-click on an mqtt_bridge calls onSelectSource (does NOT auto-navigate)', () => {
      const onSelectSource = vi.fn();
      const navigate = vi.fn();
      vi.mocked(useNavigate).mockReturnValue(navigate);
      renderSidebar({ sources: makeMqttSources(), onSelectSource });
      fireEvent.click(screen.getByText('Upstream Bridge').closest('.dashboard-source-card')!);
      expect(onSelectSource).toHaveBeenCalledWith('src-bridge');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('renders an Open button on the mqtt_broker card', () => {
      renderSidebar({ sources: makeMqttSources() });
      // Two MQTT sources should produce two Open buttons. Pre-fix, the
      // broker exclusion meant only one rendered.
      const openButtons = screen.getAllByRole('button', { name: 'source.open' });
      expect(openButtons).toHaveLength(2);
    });

    it('Open button on mqtt_broker navigates to /source/:id', () => {
      const navigate = vi.fn();
      vi.mocked(useNavigate).mockReturnValue(navigate);
      renderSidebar({ sources: makeMqttSources() });
      const brokerCard = screen.getByText('Local Broker').closest('.dashboard-source-card')!;
      const openBtn = brokerCard.querySelector('.dashboard-open-btn') as HTMLButtonElement;
      fireEvent.click(openBtn);
      expect(navigate).toHaveBeenCalledWith('/source/src-broker');
    });
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
});
