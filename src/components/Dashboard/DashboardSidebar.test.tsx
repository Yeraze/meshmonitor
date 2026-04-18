/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardSidebar from './DashboardSidebar';
import type { DashboardSource, SourceStatus } from '../../hooks/useDashboardData';

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

  it('shows sidebar navigation links', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /source\.sidebar\.unified_messages/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /source\.sidebar\.unified_telemetry/ })).toBeInTheDocument();
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
});
