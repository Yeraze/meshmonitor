/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import LinkProfileHoverLayer from './LinkProfileHoverLayer';

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ center }: { center: [number, number] }) => (
    <div data-testid="hover-marker" data-lat={center[0]} data-lng={center[1]} />
  ),
}));

let mockHoverPoint: { lat: number; lng: number } | null = null;
vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => ({ hoverPoint: mockHoverPoint }),
}));

describe('LinkProfileHoverLayer', () => {
  it('renders nothing when there is no hover point', () => {
    mockHoverPoint = null;
    const { queryByTestId } = render(<LinkProfileHoverLayer />);
    expect(queryByTestId('hover-marker')).toBeNull();
  });

  it('renders a marker at the current hover point', () => {
    mockHoverPoint = { lat: 0.15, lng: -1.2 };
    const { getByTestId } = render(<LinkProfileHoverLayer />);
    const marker = getByTestId('hover-marker');
    expect(marker.getAttribute('data-lat')).toBe('0.15');
    expect(marker.getAttribute('data-lng')).toBe('-1.2');
  });
});
