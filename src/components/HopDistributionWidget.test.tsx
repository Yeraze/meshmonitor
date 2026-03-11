/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => null } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.count !== undefined) return `${opts.count} hops`;
      const translations: Record<string, string> = {
        'dashboard.widget.hop_distribution.title': 'Hop Distribution',
        'dashboard.widget.hop_distribution.direct': 'Direct',
        'dashboard.widget.hop_distribution.total_nodes': 'Total Nodes',
        'dashboard.widget.hop_distribution.direct_neighbors': 'Direct Neighbors',
        'dashboard.widget.hop_distribution.longest_path': 'Longest Path',
        'dashboard.widget.hop_distribution.unknown': 'Unknown',
        'dashboard.remove_widget': 'Remove',
      };
      return translations[key] || key;
    },
  }),
}));

import HopDistributionWidget from './HopDistributionWidget';

type NodeInfo = {
  nodeNum: number;
  user?: { id: string; longName?: string; shortName?: string };
  lastHeard?: number;
  hopsAway?: number;
  snr?: number;
  rssi?: number;
  position?: { latitude?: number; longitude?: number; altitude?: number };
};

function makeNodes(...entries: Partial<NodeInfo>[]): Map<string, NodeInfo> {
  const map = new Map<string, NodeInfo>();
  entries.forEach((entry, i) => {
    const node: NodeInfo = { nodeNum: i + 1, ...entry };
    map.set(`node-${i}`, node);
  });
  return map;
}

describe('HopDistributionWidget', () => {
  const defaultProps = {
    id: 'hop-dist-1',
    nodes: new Map<string, NodeInfo>(),
    onRemove: vi.fn(),
    canEdit: true,
  };

  it('renders with title "Hop Distribution"', () => {
    render(<HopDistributionWidget {...defaultProps} />);
    expect(screen.getByText('Hop Distribution')).toBeInTheDocument();
  });

  it('shows correct hop buckets for mock node data', () => {
    const nodes = makeNodes(
      { hopsAway: 0 },
      { hopsAway: 0 },
      { hopsAway: 1 },
      { hopsAway: 2 },
      { hopsAway: 2 },
      { hopsAway: 2 },
    );

    render(<HopDistributionWidget {...defaultProps} nodes={nodes} />);

    // Direct row should show count 2
    expect(screen.getByText('Direct')).toBeInTheDocument();

    // The bar chart renders counts as text
    const counts = screen.getAllByText('2');
    expect(counts.length).toBeGreaterThanOrEqual(1);

    // 1 hop bucket should show count 1
    expect(screen.getByText('1 hops')).toBeInTheDocument();

    // 2 hops bucket should show count 3
    expect(screen.getByText('2 hops')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows "Unknown" row when nodes have no hopsAway', () => {
    const nodes = makeNodes(
      { hopsAway: 0 },
      { hopsAway: undefined },
      { hopsAway: undefined },
    );

    render(<HopDistributionWidget {...defaultProps} nodes={nodes} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    // Unknown count should be 2
    const unknownRow = screen.getByText('Unknown').closest('.hop-bar-row');
    expect(unknownRow).toBeInTheDocument();
    expect(unknownRow!.querySelector('.hop-bar-count')!.textContent).toBe('2');
  });

  it('shows summary stats (total nodes, direct count, max hops)', () => {
    const nodes = makeNodes(
      { hopsAway: 0 },
      { hopsAway: 1 },
      { hopsAway: 3 },
      { hopsAway: undefined },
    );

    render(<HopDistributionWidget {...defaultProps} nodes={nodes} />);

    // Total nodes = 4
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Total Nodes')).toBeInTheDocument();

    // Direct neighbors = 1
    expect(screen.getByText('Direct Neighbors')).toBeInTheDocument();

    // Longest path = 3
    expect(screen.getByText('Longest Path')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
