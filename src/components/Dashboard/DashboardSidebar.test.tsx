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

  it('shows kebab menu button for admin users', () => {
    renderSidebar({ isAdmin: true });
    const kebabBtns = screen.getAllByRole('button', { name: 'source.options' });
    expect(kebabBtns).toHaveLength(3);
  });

  it('does NOT show kebab menu for non-admin users', () => {
    renderSidebar({ isAdmin: false });
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
});
