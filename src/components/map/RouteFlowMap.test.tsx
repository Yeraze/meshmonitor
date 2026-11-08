// @vitest-environment jsdom
/**
 * RouteFlowMap (#6260 WP4): shared route-flow map. BaseMap and the shared
 * traceroute layer are stubbed so the test asserts what RouteFlowMap hands them.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteFlowMap, type RouteFlowPoint } from './RouteFlowMap';
import { darkOverlayColors } from '../../config/overlayColors';
import type { TracerouteRenderSegment } from '../../utils/tracerouteSegments';

vi.mock('./BaseMap', () => ({
  BaseMap: ({ children }: { children: React.ReactNode }) => <div data-testid="basemap">{children}</div>,
}));
vi.mock('./layers/TraceroutePathsLayer', () => ({
  TraceroutePathsLayer: (p: { segments: unknown[]; colorMode: string; legColors?: { forward: string; return: string } }) => (
    <div data-testid="paths" data-count={p.segments.length} data-mode={p.colorMode} data-forward={p.legColors?.forward} data-return={p.legColors?.return} />
  ),
}));
vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children }: { children: React.ReactNode }) => <div data-testid="marker">{children}</div>,
  Polyline: () => <div data-testid="fixed-line" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
}));

const pts: RouteFlowPoint[] = [
  { key: 'a', label: 'You', lat: 1, lon: 1, kind: 'endpoint' },
  { key: 'b', label: '#1 Relay', lat: 2, lon: 2, kind: 'hop' },
];
const seg: TracerouteRenderSegment = {
  key: 's', from: [1, 1], to: [2, 2], fromKey: 'k1', toKey: 'k2', leg: 'forward', avgSnr: 3, isMqtt: false,
};

describe('RouteFlowMap', () => {
  it('colorMode "leg" hands the layer fixed-leg colours', () => {
    render(
      <RouteFlowMap
        points={pts}
        segments={[seg, { ...seg, key: 'r', leg: 'return' }]}
        snrColors={darkOverlayColors.snrColors}
        colorMode="leg"
        legColors={{ forward: '#111111', return: '#222222' }}
      />,
    );
    const layer = screen.getByTestId('paths');
    expect(layer.getAttribute('data-mode')).toBe('fixed-leg');
    expect(layer.getAttribute('data-forward')).toBe('#111111');
    expect(layer.getAttribute('data-return')).toBe('#222222');
  });

  it('colorMode defaults to snr and ignores leg colours', () => {
    render(<RouteFlowMap points={pts} segments={[seg]} snrColors={darkOverlayColors.snrColors} legColors={{ forward: '#1', return: '#2' }} />);
    const layer = screen.getByTestId('paths');
    expect(layer.getAttribute('data-mode')).toBe('snr');
    expect(layer.getAttribute('data-forward')).toBeNull();
  });

  it('draws a fixed dashed line and labeled markers without segments', () => {
    render(<RouteFlowMap points={pts} snrColors={darkOverlayColors.snrColors} />);
    expect(screen.getByTestId('fixed-line')).toBeTruthy();
    expect(screen.queryByTestId('paths')).toBeNull();
    expect(screen.getAllByTestId('marker')).toHaveLength(2);
    expect(screen.getByText('#1 Relay')).toBeTruthy();
  });

  it('uses the shared SNR-colored layer when segments are given', () => {
    render(<RouteFlowMap points={pts} segments={[seg]} snrColors={darkOverlayColors.snrColors} />);
    const layer = screen.getByTestId('paths');
    expect(layer.getAttribute('data-count')).toBe('1');
    expect(layer.getAttribute('data-mode')).toBe('snr');
    expect(screen.queryByTestId('fixed-line')).toBeNull();
  });

  it('renders nothing with no points', () => {
    const { container } = render(<RouteFlowMap points={[]} snrColors={darkOverlayColors.snrColors} />);
    expect(container.firstChild).toBeNull();
  });
});
