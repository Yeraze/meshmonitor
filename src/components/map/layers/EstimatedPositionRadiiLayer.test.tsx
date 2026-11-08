/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PathOptions } from 'leaflet';
import { EstimatedPositionRadiiLayer } from './EstimatedPositionRadiiLayer';

vi.mock('react-leaflet', () => ({
  Circle: ({ center, radius, pathOptions }: { center: [number, number]; radius: number; pathOptions: PathOptions }) => (
    <div data-testid="circle" data-center={JSON.stringify(center)} data-radius={radius} data-path={JSON.stringify(pathOptions)} />
  ),
}));

describe('EstimatedPositionRadiiLayer', () => {
  it('renders nothing for no radii', () => {
    render(<EstimatedPositionRadiiLayer radii={[]} />);
    expect(screen.queryByTestId('circle')).toBeNull();
  });

  it('draws one dashed circle per radius in the adapter colour', () => {
    render(<EstimatedPositionRadiiLayer radii={[{ key: 'a', center: [1, 2], radiusMeters: 750, color: 'red' }]} />);
    const c = screen.getByTestId('circle');
    expect(c.dataset.center).toBe('[1,2]');
    expect(c.dataset.radius).toBe('750');
    expect(JSON.parse(c.dataset.path as string)).toEqual({
      color: 'red', fillColor: 'red', fillOpacity: 0.1, opacity: 0.4, weight: 2, dashArray: '5, 5',
    });
  });
});
