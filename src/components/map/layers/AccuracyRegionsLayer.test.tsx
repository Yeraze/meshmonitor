/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PathOptions } from 'leaflet';
import { AccuracyRegionsLayer, type AccuracyRegionDescriptor } from './AccuracyRegionsLayer';

// Mirrors the module-private default in AccuracyRegionsLayer.tsx (not exported
// so the file stays component-only for react-refresh/only-export-components).
const CANONICAL_GRAY: PathOptions = {
  color: '#888',
  fillColor: '#888',
  fillOpacity: 0.08,
  opacity: 0.5,
  weight: 1,
};

vi.mock('react-leaflet', () => ({
  Rectangle: ({ bounds, pathOptions }: { bounds: [[number, number], [number, number]]; pathOptions?: PathOptions }) => (
    <div
      data-testid="accuracy-rect"
      data-bounds={JSON.stringify(bounds)}
      data-path-options={JSON.stringify(pathOptions)}
    />
  ),
}));

function region(partial: Partial<AccuracyRegionDescriptor> & { key: string }): AccuracyRegionDescriptor {
  return {
    bounds: [
      [29.9, -90.1],
      [30.1, -89.9],
    ],
    ...partial,
  };
}

describe('AccuracyRegionsLayer', () => {
  it('renders one Rectangle per descriptor', () => {
    render(
      <AccuracyRegionsLayer
        regions={[region({ key: 'a' }), region({ key: 'b' }), region({ key: 'c' })]}
      />,
    );
    expect(screen.getAllByTestId('accuracy-rect')).toHaveLength(3);
  });

  it('renders nothing for an empty regions array', () => {
    render(<AccuracyRegionsLayer regions={[]} />);
    expect(screen.queryByTestId('accuracy-rect')).toBeNull();
  });

  it('passes bounds through unchanged', () => {
    render(
      <AccuracyRegionsLayer
        regions={[
          region({
            key: 'a',
            bounds: [
              [1, 2],
              [3, 4],
            ],
          }),
        ]}
      />,
    );
    const bounds = JSON.parse(screen.getByTestId('accuracy-rect').getAttribute('data-bounds')!);
    expect(bounds).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('defaults to the canonical gray pathOptions when none is supplied', () => {
    render(<AccuracyRegionsLayer regions={[region({ key: 'a' })]} />);
    const pathOptions = JSON.parse(screen.getByTestId('accuracy-rect').getAttribute('data-path-options')!);
    expect(pathOptions).toEqual(CANONICAL_GRAY);
  });

  it('uses the supplied pathOptions override (e.g. NodesTab hop-coloring) instead of the default', () => {
    const hopColored: PathOptions = { color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1, opacity: 0.4, weight: 2 };
    render(<AccuracyRegionsLayer regions={[region({ key: 'a', pathOptions: hopColored })]} />);
    const pathOptions = JSON.parse(screen.getByTestId('accuracy-rect').getAttribute('data-path-options')!);
    expect(pathOptions).toEqual(hopColored);
  });
});
