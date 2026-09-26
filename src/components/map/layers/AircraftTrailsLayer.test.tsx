/**
 * @vitest-environment jsdom
 *
 * AircraftTrailsLayer (#5364/#5365 Phase 3): outline + coloured line per
 * trail, direction arrows, and a tooltip naming the node and the time of the
 * fix nearest the cursor.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AircraftTrailsLayer from './AircraftTrailsLayer';
import type { AircraftTrailDescriptor } from '../aircraftTrails';

interface MockPolylineProps {
  positions: [number, number][];
  pathOptions?: { color?: string; weight?: number };
  interactive?: boolean;
  eventHandlers?: { mousemove?: (e: { latlng: { lat: number; lng: number } }) => void };
  children?: ReactNode;
}

vi.mock('react-leaflet', () => ({
  Polyline: (props: MockPolylineProps) => (
    <div
      data-testid="polyline"
      data-color={props.pathOptions?.color}
      data-weight={props.pathOptions?.weight}
      data-interactive={props.interactive === false ? 'false' : 'true'}
      data-point-count={props.positions.length}
      onMouseMove={(e) => {
        const lat = Number((e.target as HTMLElement).getAttribute('data-lat') ?? 0);
        const lng = Number((e.target as HTMLElement).getAttribute('data-lng') ?? 0);
        props.eventHandlers?.mousemove?.({ latlng: { lat, lng } });
      }}
    >
      {props.children}
    </div>
  ),
  Marker: () => <div data-testid="arrow-marker" />,
  Tooltip: (props: { children?: ReactNode }) => <div data-testid="tooltip">{props.children}</div>,
  Popup: (props: { children?: ReactNode }) => <div data-testid="popup">{props.children}</div>,
  CircleMarker: (props: { children?: ReactNode }) => <div data-testid="circle-marker">{props.children}</div>,
}));

const trail = (key: string, n: number): AircraftTrailDescriptor => ({
  key,
  label: `Plane ${key}`,
  color: 'hsl(10, 70%, 55%)',
  positions: Array.from({ length: n }, (_, i) => [30 + i, -80 - i] as [number, number]),
  times: Array.from({ length: n }, (_, i) => 1_000 * (i + 1)),
});

describe('AircraftTrailsLayer', () => {
  it('renders nothing for no trails', () => {
    const { container } = render(<AircraftTrailsLayer trails={[]} />);
    expect(container.querySelectorAll('[data-testid="polyline"]')).toHaveLength(0);
  });

  it('draws an outline and a coloured line per trail', () => {
    render(<AircraftTrailsLayer trails={[trail('a', 3), trail('b', 4)]} />);
    const lines = screen.getAllByTestId('polyline');
    expect(lines).toHaveLength(4);
    const outlines = lines.filter((l) => l.getAttribute('data-interactive') === 'false');
    const coloured = lines.filter((l) => l.getAttribute('data-interactive') === 'true');
    expect(outlines).toHaveLength(2);
    expect(coloured).toHaveLength(2);
    expect(coloured[0].getAttribute('data-color')).toBe('hsl(10, 70%, 55%)');
    expect(Number(outlines[0].getAttribute('data-weight'))).toBeGreaterThan(
      Number(coloured[0].getAttribute('data-weight')),
    );
  });

  it('adds direction arrows, capped per trail', () => {
    render(<AircraftTrailsLayer trails={[trail('a', 100)]} />);
    const arrows = screen.getAllByTestId('arrow-marker');
    expect(arrows.length).toBeGreaterThan(0);
    expect(arrows.length).toBeLessThanOrEqual(12);
  });

  it('tooltip shows the label and the newest fix time by default', () => {
    const fmt = vi.fn((label: string, ts: number) => `${label}@${ts}`);
    render(<AircraftTrailsLayer trails={[trail('a', 3)]} formatTooltip={fmt} />);
    expect(screen.getAllByTestId('tooltip').some((t) => t.textContent === 'Plane a@3000')).toBe(true);
  });

  it('tooltip follows the fix nearest the cursor', () => {
    const fmt = (label: string, ts: number) => `${label}@${ts}`;
    render(<AircraftTrailsLayer trails={[trail('a', 3)]} formatTooltip={fmt} />);
    const line = screen.getAllByTestId('polyline').find((l) => l.getAttribute('data-interactive') === 'true')!;
    line.setAttribute('data-lat', '30.1');
    line.setAttribute('data-lng', '-80.1');
    fireEvent.mouseMove(line);
    expect(screen.getAllByTestId('tooltip').some((t) => t.textContent === 'Plane a@1000')).toBe(true);
  });
});
