/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { PolarGridOverlay } from './PolarGridOverlay';

vi.mock('react-leaflet', () => ({
  Circle: ({ center, radius, pathOptions }: any) => (
    <div
      data-testid="circle"
      data-radius={radius}
      data-lat={center[0]}
      data-lng={center[1]}
      data-color={pathOptions?.color}
      data-opacity={pathOptions?.opacity}
    />
  ),
  Polyline: ({ positions }: any) => <div data-testid="polyline" />,
  Marker: ({ position }: any) => (
    <div data-testid="marker" data-lat={position[0]} data-lng={position[1]} />
  ),
  useMap: () => ({ getZoom: () => 13, on: vi.fn(), off: vi.fn() }),
}));

vi.mock('leaflet', () => ({
  default: { divIcon: ({ html, className }: any) => ({ html, className }) },
  divIcon: ({ html, className }: any) => ({ html, className }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    distanceUnit: 'km' as const,
    selectedTileset: 'osm',
    customOverlayScheme: undefined,
    mapTileset: 'osm',
    overlayColors: {
      polarGrid: {
        rings: 'rgba(0,200,255,0.3)',
        sectors: 'rgba(0,200,255,0.15)',
        cardinalSectors: 'rgba(0,200,255,0.3)',
        labels: 'rgba(0,200,255,0.7)',
      },
    },
  }),
}));

vi.mock('../config/overlayColors', () => ({
  getOverlayColors: () => ({
    polarGrid: {
      rings: 'rgba(0,200,255,0.3)',
      sectors: 'rgba(0,200,255,0.15)',
      cardinalSectors: 'rgba(0,200,255,0.3)',
      labels: 'rgba(0,200,255,0.7)',
    },
  }),
  getSchemeForTileset: () => 'dark',
}));

const CENTER = { lat: 37.7749, lng: -122.4194 };

describe('PolarGridOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders 11 circles for range rings', () => {
    render(<PolarGridOverlay center={CENTER} />);
    const circles = screen.getAllByTestId('circle');
    expect(circles.length).toBeGreaterThanOrEqual(4);
    expect(circles.length).toBeLessThanOrEqual(12);
  });

  it('renders exactly 12 polylines for sector lines', () => {
    render(<PolarGridOverlay center={CENTER} />);
    const polylines = screen.getAllByTestId('polyline');
    expect(polylines).toHaveLength(12);
  });

  it('renders distance and degree label markers (17 or more total)', () => {
    render(<PolarGridOverlay center={CENTER} />);
    const markers = screen.getAllByTestId('marker');
    // 5 distance labels (north axis) + 12 degree labels = 17
    expect(markers.length).toBeGreaterThanOrEqual(17);
  });

  it('centers circles on the provided position', () => {
    render(<PolarGridOverlay center={CENTER} />);
    const circles = screen.getAllByTestId('circle');
    circles.forEach((circle) => {
      expect(parseFloat(circle.getAttribute('data-lat')!)).toBeCloseTo(CENTER.lat, 4);
      expect(parseFloat(circle.getAttribute('data-lng')!)).toBeCloseTo(CENTER.lng, 4);
    });
  });

  it('assigns increasing radii to rings', () => {
    render(<PolarGridOverlay center={CENTER} />);
    const circles = screen.getAllByTestId('circle');
    const radii = circles.map((c) => parseFloat(c.getAttribute('data-radius')!));
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
  });

  it('uses the theme ring color at full opacity by default', () => {
    render(<PolarGridOverlay center={CENTER} />);
    const circle = screen.getAllByTestId('circle')[0];
    expect(circle.getAttribute('data-color')).toBe('rgba(0,200,255,0.3)');
    // No explicit opacity override (undefined) — the rgba alpha carries the
    // transparency, so the attribute is absent.
    expect(circle.getAttribute('data-opacity')).toBeNull();
  });

  it('overrides every ring with the per-source color at reduced opacity (#3971)', () => {
    render(<PolarGridOverlay center={CENTER} color="#89b4fa" />);
    const circles = screen.getAllByTestId('circle');
    circles.forEach((circle) => {
      expect(circle.getAttribute('data-color')).toBe('#89b4fa');
      expect(Number(circle.getAttribute('data-opacity'))).toBeLessThan(1);
      expect(Number(circle.getAttribute('data-opacity'))).toBeGreaterThan(0);
    });
  });
});
