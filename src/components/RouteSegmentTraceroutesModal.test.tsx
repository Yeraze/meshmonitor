/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RouteSegmentTraceroutesModal from './RouteSegmentTraceroutesModal';
import { DbTraceroute } from '../services/database';
import { DeviceInfo } from '../types/device';

// Mock the SettingsContext
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    timeFormat: '24' as const,
    dateFormat: 'MM/DD/YYYY' as const,
    distanceUnit: 'km' as const,
  }),
}));

// Mock the formatTracerouteRoute utility
vi.mock('../utils/traceroute', () => ({
  formatNodeName: (nodeNum: number, nodes: DeviceInfo[]) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    return node?.user?.longName || node?.user?.shortName || `Node ${nodeNum}`;
  },
  formatTracerouteRoute: () => 'mocked route',
}));

// Mock formatDateTime utility
vi.mock('../utils/datetime', () => ({
  formatDateTime: () => '2025-01-01 12:00',
}));

describe('RouteSegmentTraceroutesModal - Node Direction Display', () => {
  const mockNodes: DeviceInfo[] = [
    {
      nodeNum: 100,
      user: {
        id: '!64',
        longName: 'Local Node',
        shortName: 'LOCAL',
        hwModel: 31,
        role: '1',
      },
      position: { latitude: 40.0, longitude: -75.0, altitude: 100 },
    },
    {
      nodeNum: 200,
      user: {
        id: '!c8',
        longName: 'Remote Node',
        shortName: 'REMOTE',
        hwModel: 31,
        role: '1',
      },
      position: { latitude: 40.1, longitude: -75.1, altitude: 100 },
    },
  ];

  const mockTraceroutes: DbTraceroute[] = [
    {
      id: 1,
      fromNodeId: '!64',
      fromNodeNum: 100,
      toNodeId: '!c8',
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: '[]',
      snrBack: '[]',
      timestamp: Date.now() - 60000,
      createdAt: Date.now() - 60000,
    },
  ];

  const mockOnClose = vi.fn();

  /**
   * CRITICAL TEST: Verify traceroute title displays correct node direction.
   *
   * This test prevents regression of issue where node direction was reversed,
   * showing "Remote Node → Local Node" when it should be "Local Node → Remote Node".
   *
   * Expected behavior:
   * - Title should show: fromNodeName → toNodeName
   * - This represents: traceroute FROM local node TO remote node
   * - NOT: toNodeName → fromNodeName (which was the bug)
   */
  it('should display traceroute title in correct direction: fromNode → toNode', () => {
    render(
      <RouteSegmentTraceroutesModal
        nodeNum1={100}
        nodeNum2={200}
        traceroutes={mockTraceroutes}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // The traceroute title should show the direction correctly
    // fromNodeNum=100 (Local Node), toNodeNum=200 (Remote Node)
    // Title should display: "Local Node → Remote Node"
    const titleText = screen.getByText(/Local Node → Remote Node/);
    expect(titleText).toBeInTheDocument();
  });

  /**
   * CRITICAL TEST: Verify the modal does NOT display reversed direction.
   *
   * This test ensures we don't regress to the bug where nodes were swapped.
   */
  it('should NOT display traceroute title in reversed direction', () => {
    render(
      <RouteSegmentTraceroutesModal
        nodeNum1={100}
        nodeNum2={200}
        traceroutes={mockTraceroutes}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // The WRONG direction should NOT be present in the document
    // This was the bug: showing "Remote Node → Local Node"
    expect(screen.queryByText(/Remote Node → Local Node/)).not.toBeInTheDocument();
  });

  /**
   * Test that the segment label in the modal header is bidirectional (uses ↔)
   */
  it('should display segment label with bidirectional arrow', () => {
    render(
      <RouteSegmentTraceroutesModal
        nodeNum1={100}
        nodeNum2={200}
        traceroutes={mockTraceroutes}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // The segment label shows bidirectional because segments work both ways
    expect(screen.getByText(/Local Node ↔ Remote Node/)).toBeInTheDocument();
  });

  /**
   * Test with swapped node parameters to ensure consistency
   */
  it('should maintain correct direction regardless of nodeNum parameter order', () => {
    const { rerender } = render(
      <RouteSegmentTraceroutesModal
        nodeNum1={100}
        nodeNum2={200}
        traceroutes={mockTraceroutes}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // First render: node1=100, node2=200
    expect(screen.getByText(/Local Node → Remote Node/)).toBeInTheDocument();

    // Rerender with swapped parameters
    rerender(
      <RouteSegmentTraceroutesModal
        nodeNum1={200}
        nodeNum2={100}
        traceroutes={mockTraceroutes}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // The traceroute direction should still be correct (based on traceroute data, not params)
    expect(screen.getByText(/Local Node → Remote Node/)).toBeInTheDocument();
  });

  /**
   * Test modal title header
   */
  it('should display correct modal title', () => {
    render(
      <RouteSegmentTraceroutesModal
        nodeNum1={100}
        nodeNum2={200}
        traceroutes={mockTraceroutes}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    expect(screen.getByText('route_segment.title')).toBeInTheDocument();
  });

  /**
   * Test with no traceroutes
   */
  it('should display message when no traceroutes are found', () => {
    render(
      <RouteSegmentTraceroutesModal
        nodeNum1={100}
        nodeNum2={200}
        traceroutes={[]}
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    expect(screen.getByText('route_segment.no_traceroutes')).toBeInTheDocument();
  });
});
