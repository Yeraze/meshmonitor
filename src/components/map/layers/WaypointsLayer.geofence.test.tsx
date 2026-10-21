/**
 * Waypoint geofence region and popup line (#5922).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-leaflet', () => ({
  Marker: ({ children }: any) => <div>{children}</div>,
  Popup: ({ children }: any) => <div>{children}</div>,
  Circle: ({ center, radius, interactive }: any) => (
    <div data-testid="geofence-circle" data-center={JSON.stringify(center)} data-radius={radius} data-interactive={String(interactive)} />
  ),
  Rectangle: ({ bounds }: any) => <div data-testid="geofence-rect" data-bounds={JSON.stringify(bounds)} />,
}));
vi.mock('leaflet', () => ({ default: { divIcon: vi.fn((o: any) => o) } }));
vi.mock('../../../hooks/useDashboardData', () => ({ useDashboardSources: () => ({ data: [] }) }));

import { WaypointGeofenceRegion } from './WaypointsLayer';
import { geofenceSummary } from './waypointGeofenceSummary';
import type { Waypoint } from '../../../types/waypoint';

const wp: Waypoint = {
  sourceId: 's', waypointId: 1, ownerNodeNum: null, latitude: 30, longitude: -90, expireAt: null,
  lockedTo: null, name: 'Camp', description: '', iconCodepoint: null, iconEmoji: null, isVirtual: false,
  channel: 0, rebroadcastIntervalS: null, lastBroadcastAt: null, firstSeenAt: 0, lastUpdatedAt: 0,
};

describe('WaypointGeofenceRegion', () => {
  it('draws nothing for a waypoint without a geofence', () => {
    const { container } = render(<WaypointGeofenceRegion wp={wp} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws a non-interactive circle around the waypoint', () => {
    const { getByTestId } = render(<WaypointGeofenceRegion wp={{ ...wp, geofenceRadiusM: 500 }} />);
    const c = getByTestId('geofence-circle');
    expect(c.dataset.center).toBe('[30,-90]');
    expect(c.dataset.radius).toBe('500');
    expect(c.dataset.interactive).toBe('false');
  });

  it('draws the box, and skips a box that wraps the wrong way', () => {
    const { getByTestId } = render(
      <WaypointGeofenceRegion wp={{ ...wp, boundingBox: { west: -90.1, south: 29.9, east: -89.9, north: 30.1 } }} />,
    );
    expect(getByTestId('geofence-rect').dataset.bounds).toBe('[[29.9,-90.1],[30.1,-89.9]]');

    const wrapped = render(
      <WaypointGeofenceRegion wp={{ ...wp, boundingBox: { west: 10, south: 29.9, east: -10, north: 30.1 } }} />,
    );
    expect(wrapped.container.querySelector('[data-testid="geofence-rect"]')).toBeNull();
  });
});

describe('geofenceSummary', () => {
  it('describes the shape and the alerts', () => {
    expect(geofenceSummary(wp)).toBeNull();
    expect(geofenceSummary({ ...wp, geofenceRadiusM: 500 })).toBe('Geofence: 500 m radius');
    expect(geofenceSummary({
      ...wp, geofenceRadiusM: 2500, boundingBox: { west: 1, south: 2, east: 3, north: 4 },
      notifyOnEnter: true, notifyOnExit: true, notifyFavoritesOnly: true,
    })).toBe('Geofence: 2.5 km radius + bounding box, alerts on enter and exit (favourites only)');
  });
});
