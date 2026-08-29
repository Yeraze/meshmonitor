/**
 * @vitest-environment jsdom
 *
 * RouterClusterMap (#4974) — the embedded map on Router Cluster (B1) cards.
 * Leaflet cannot render in JSDOM, so BaseMap and react-leaflet are stubbed;
 * these tests cover the gating (positioned members required), the toggle,
 * marker selection, and the unpositioned-members note.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: React.ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children, center }: { children?: React.ReactNode; center: [number, number] }) => (
    <div data-testid="cluster-marker" data-center={center.join(',')}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
}));

import RouterClusterMap from './RouterClusterMap';
import type { EvidenceNodeRef } from './meshIssueTypes';

const positioned: EvidenceNodeRef[] = [
  { nodeNum: 1, name: 'R1', latitude: 26.1, longitude: -80.2 },
  { nodeNum: 2, name: 'R2', latitude: 26.2, longitude: -80.3 },
];

describe('RouterClusterMap', () => {
  it('renders nothing when no member has a position', () => {
    const { container } = render(
      <RouterClusterMap
        members={[
          { nodeNum: 1, name: 'R1', latitude: null, longitude: null },
          { nodeNum: 2, name: 'R2' }, // pre-#4974 row: fields absent
        ]}
        bestSitedNodeNum={1}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('excludes null-island coordinates from the positioned set', () => {
    const { container } = render(
      <RouterClusterMap members={[{ nodeNum: 1, name: 'R1', latitude: 0, longitude: 0 }]} bestSitedNodeNum={1} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the map behind a toggle and renders one marker per positioned member', () => {
    render(<RouterClusterMap members={positioned} bestSitedNodeNum={1} />);

    expect(screen.queryByTestId('router-cluster-map')).toBeNull();
    fireEvent.click(screen.getByText('Show map'));

    expect(screen.getByTestId('router-cluster-map')).toBeTruthy();
    const markers = screen.getAllByTestId('cluster-marker');
    expect(markers).toHaveLength(2);
    expect(markers[0].getAttribute('data-center')).toBe('26.1,-80.2');
    expect(screen.getByText('R1')).toBeTruthy();
    expect(screen.getByText('R2')).toBeTruthy();

    fireEvent.click(screen.getByText('Hide map'));
    expect(screen.queryByTestId('router-cluster-map')).toBeNull();
  });

  it('notes members without a stored position', () => {
    render(
      <RouterClusterMap
        members={[...positioned, { nodeNum: 3, name: 'R3', latitude: null, longitude: null }]}
        bestSitedNodeNum={1}
      />,
    );
    fireEvent.click(screen.getByText('Show map'));
    expect(screen.getByText('1 member(s) have no stored position and are not shown.')).toBeTruthy();
  });
});
