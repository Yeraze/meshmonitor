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
        'dashboard.widget.distance_distribution.title': 'Distance Distribution',
        'dashboard.widget.distance_distribution.km': 'km',
        'dashboard.widget.distance_distribution.miles': 'mi',
        'dashboard.widget.distance_distribution.no_home_position': 'No home position set — add GPS to your node',
        'dashboard.widget.distance_distribution.no_position_data': 'No other nodes have position data',
        'dashboard.widget.distance_distribution.with_position': 'With Position',
        'dashboard.widget.distance_distribution.avg_distance': `Avg Distance (${opts?.unit || 'km'})`,
        'dashboard.widget.distance_distribution.max_distance': `Max Distance (${opts?.unit || 'km'})`,
        'dashboard.widget.distance_distribution.no_gps': 'No GPS',
        'dashboard.widget.distance_distribution.settings': 'Settings',
        'dashboard.widget.distance_distribution.bucket_size': 'Bucket Size',
        'dashboard.remove_widget': 'Remove',
      };
      return translations[key] || key;
    },
  }),
}));

import DistanceDistributionWidget from './DistanceDistributionWidget';

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

describe('DistanceDistributionWidget', () => {
  const defaultProps = {
    id: 'dist-dist-1',
    bucketSize: 10,
    nodes: new Map<string, NodeInfo>(),
    currentNodeId: 'home-node',
    distanceUnit: 'km' as const,
    onRemove: vi.fn(),
    onBucketSizeChange: vi.fn(),
    canEdit: true,
  };

  it('renders with title "Distance Distribution"', () => {
    render(<DistanceDistributionWidget {...defaultProps} />);
    expect(screen.getByText('Distance Distribution')).toBeInTheDocument();
  });

  it('shows "no home position" message when home node lacks GPS', () => {
    // Home node exists but has no position
    const nodes = makeNodes(
      { user: { id: 'home-node', longName: 'Home' } },
      { user: { id: 'other', longName: 'Other' }, position: { latitude: 40.0, longitude: -74.0 } },
    );

    render(<DistanceDistributionWidget {...defaultProps} nodes={nodes} />);
    expect(screen.getByText('No home position set — add GPS to your node')).toBeInTheDocument();
  });

  it('shows "no position data" when no other nodes have GPS', () => {
    // Home node has position, but other nodes do not
    const nodes = makeNodes(
      { user: { id: 'home-node', longName: 'Home' }, position: { latitude: 40.7128, longitude: -74.006 } },
      { user: { id: 'other1', longName: 'Other 1' } },
      { user: { id: 'other2', longName: 'Other 2' } },
    );

    render(<DistanceDistributionWidget {...defaultProps} nodes={nodes} />);
    expect(screen.getByText('No other nodes have position data')).toBeInTheDocument();
  });

  it('shows bars when nodes have position data', () => {
    // Home node at NYC, other nodes at varying distances
    const nodes = makeNodes(
      { user: { id: 'home-node', longName: 'Home' }, position: { latitude: 40.7128, longitude: -74.006 } },
      { user: { id: 'near', longName: 'Near' }, position: { latitude: 40.7200, longitude: -74.010 } },
      { user: { id: 'far', longName: 'Far' }, position: { latitude: 40.8000, longitude: -74.100 } },
    );

    const { container } = render(<DistanceDistributionWidget {...defaultProps} nodes={nodes} />);

    // Should render bar rows
    const barRows = container.querySelectorAll('.hop-bar-row');
    expect(barRows.length).toBeGreaterThan(0);

    // Should show "With Position" stat
    expect(screen.getByText('With Position')).toBeInTheDocument();
  });
});
