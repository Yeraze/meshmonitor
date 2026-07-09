/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AccuracyRegionsLayer from './AccuracyRegionsLayer';
import type { AnalysisNode } from '../useAnalysisNodes';

vi.mock('react-leaflet', () => ({
  Rectangle: ({ bounds }: { bounds: [[number, number], [number, number]] }) => (
    <div data-testid="accuracy-rect" data-bounds={JSON.stringify(bounds)} />
  ),
}));

const mockNodes = vi.fn<() => AnalysisNode[]>();
vi.mock('../useAnalysisNodes', () => ({
  useAnalysisNodes: () => mockNodes(),
}));

function node(partial: Partial<AnalysisNode['node']> & { nodeNum: number }): AnalysisNode {
  return {
    node: { latitude: 30, longitude: -90, ...partial },
    // latLng is the (possibly offset) marker position; the layer must ignore it
    // and recompute the rectangle center from the node's own coordinates.
    latLng: [99, 99],
    key: `mt:${partial.nodeNum}`,
  };
}

describe('AccuracyRegionsLayer', () => {
  it('draws a rectangle only for obscured (1..31 bits, non-override) nodes', () => {
    mockNodes.mockReturnValue([
      node({ nodeNum: 1, positionPrecisionBits: 16 }),           // obscured -> rect
      node({ nodeNum: 2, positionPrecisionBits: 32 }),           // full precision -> none
      node({ nodeNum: 3 }),                                      // missing bits -> none
      node({ nodeNum: 4, positionPrecisionBits: 0 }),            // zero -> none
      node({ nodeNum: 5, positionPrecisionBits: 16, positionIsOverride: true }), // override -> none
    ]);
    render(<AccuracyRegionsLayer />);
    expect(screen.getAllByTestId('accuracy-rect')).toHaveLength(1);
  });

  it('centers the rectangle on the node position, not the offset marker latLng', () => {
    mockNodes.mockReturnValue([node({ nodeNum: 1, latitude: 30, longitude: -90, positionPrecisionBits: 16 })]);
    render(<AccuracyRegionsLayer />);
    const bounds = JSON.parse(screen.getByTestId('accuracy-rect').getAttribute('data-bounds')!);
    const centerLat = (bounds[0][0] + bounds[1][0]) / 2;
    const centerLng = (bounds[0][1] + bounds[1][1]) / 2;
    expect(centerLat).toBeCloseTo(30, 6);   // NOT 99 (the latLng)
    expect(centerLng).toBeCloseTo(-90, 6);
  });

  it('renders nothing when there are no obscured nodes', () => {
    mockNodes.mockReturnValue([node({ nodeNum: 1, positionPrecisionBits: 32 })]);
    render(<AccuracyRegionsLayer />);
    expect(screen.queryByTestId('accuracy-rect')).toBeNull();
  });
});
