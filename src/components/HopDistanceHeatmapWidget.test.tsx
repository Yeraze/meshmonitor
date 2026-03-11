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
      const translations: Record<string, string> = {
        'dashboard.widget.hop_distance_heatmap.title': 'Hop/Distance Heatmap',
        'dashboard.widget.hop_distance_heatmap.no_data': 'No nodes with both hops and position data',
        'dashboard.widget.hop_distance_heatmap.skipped': `${opts?.count || 0} nodes skipped (missing hops or GPS)`,
        'dashboard.widget.hop_distance_heatmap.fewer': 'Fewer',
        'dashboard.widget.hop_distance_heatmap.more': 'More',
        'dashboard.widget.hop_distance_heatmap.distance_axis': `Distance (${opts?.unit || 'km'})`,
        'dashboard.widget.hop_distance_heatmap.hops_axis': 'Hops',
        'dashboard.widget.hop_distribution.direct': 'Direct',
        'dashboard.widget.distance_distribution.title': 'Distance Distribution',
        'dashboard.widget.distance_distribution.km': 'km',
        'dashboard.widget.distance_distribution.miles': 'mi',
        'dashboard.widget.distance_distribution.no_home_position': 'No home position set — add GPS to your node',
        'dashboard.widget.distance_distribution.settings': 'Settings',
        'dashboard.widget.distance_distribution.bucket_size': 'Bucket Size',
        'dashboard.remove_widget': 'Remove',
      };
      return translations[key] || key;
    },
  }),
}));

import HopDistanceHeatmapWidget from './HopDistanceHeatmapWidget';

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

describe('HopDistanceHeatmapWidget', () => {
  const defaultProps = {
    id: 'heatmap-1',
    bucketSize: 10,
    nodes: new Map<string, NodeInfo>(),
    currentNodeId: 'home-node',
    distanceUnit: 'km' as const,
    onRemove: vi.fn(),
    onBucketSizeChange: vi.fn(),
    canEdit: true,
  };

  it('renders with title "Hop/Distance Heatmap"', () => {
    render(<HopDistanceHeatmapWidget {...defaultProps} />);
    expect(screen.getByText('Hop/Distance Heatmap')).toBeInTheDocument();
  });

  it('shows "no home position" when home node lacks GPS', () => {
    const nodes = makeNodes(
      { user: { id: 'home-node', longName: 'Home' } },
      { user: { id: 'other', longName: 'Other' }, hopsAway: 1, position: { latitude: 40.0, longitude: -74.0 } },
    );

    render(<HopDistanceHeatmapWidget {...defaultProps} nodes={nodes} />);
    expect(screen.getByText('No home position set — add GPS to your node')).toBeInTheDocument();
  });

  it('shows heatmap grid when data is available', () => {
    const nodes = makeNodes(
      { user: { id: 'home-node', longName: 'Home' }, position: { latitude: 40.7128, longitude: -74.006 } },
      { user: { id: 'n1', longName: 'Node 1' }, hopsAway: 0, position: { latitude: 40.7200, longitude: -74.010 } },
      { user: { id: 'n2', longName: 'Node 2' }, hopsAway: 1, position: { latitude: 40.7500, longitude: -74.050 } },
      { user: { id: 'n3', longName: 'Node 3' }, hopsAway: 2, position: { latitude: 40.8000, longitude: -74.100 } },
    );

    const { container } = render(<HopDistanceHeatmapWidget {...defaultProps} nodes={nodes} />);

    // Should render the heatmap table
    const table = container.querySelector('.heatmap-table');
    expect(table).toBeInTheDocument();

    // Should have cells in the grid
    const cells = container.querySelectorAll('.heatmap-cell');
    expect(cells.length).toBeGreaterThan(0);

    // Should show "Direct" label for hop 0
    expect(screen.getByText('Direct')).toBeInTheDocument();

    // Should show legend
    expect(screen.getByText('Fewer')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('shows skipped count for nodes missing hops or GPS', () => {
    const nodes = makeNodes(
      { user: { id: 'home-node', longName: 'Home' }, position: { latitude: 40.7128, longitude: -74.006 } },
      { user: { id: 'n1', longName: 'Node 1' }, hopsAway: 0, position: { latitude: 40.7200, longitude: -74.010 } },
      // These nodes are missing hops or position, so they will be skipped
      { user: { id: 'no-hops', longName: 'No Hops' }, position: { latitude: 40.73, longitude: -74.02 } },
      { user: { id: 'no-gps', longName: 'No GPS' }, hopsAway: 1 },
      { user: { id: 'no-both', longName: 'Neither' } },
    );

    render(<HopDistanceHeatmapWidget {...defaultProps} nodes={nodes} />);

    // 3 nodes should be skipped (no-hops, no-gps, no-both)
    expect(screen.getByText('3 nodes skipped (missing hops or GPS)')).toBeInTheDocument();
  });
});
