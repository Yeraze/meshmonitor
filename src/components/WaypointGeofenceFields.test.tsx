/**
 * Waypoint editor geofence section (#5922).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./BBoxMapEditor', () => ({
  default: ({ onChange }: { onChange: (b: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ minLat: 29.9, maxLat: 30.1, minLng: -90.1, maxLng: -89.9 })}>
      draw-box
    </button>
  ),
}));

import WaypointGeofenceFields from './WaypointGeofenceFields';
import {
  EMPTY_GEOFENCE,
  geofenceBody,
  geofenceDraftFrom,
  type GeofenceDraft,
} from './waypointGeofenceDraft';
import WaypointEditorModal from './WaypointEditorModal';

describe('geofence draft helpers', () => {
  it('seeds the shape from the stored fields, keeping a circle and box together', () => {
    expect(geofenceDraftFrom({}).shape).toBe('none');
    expect(geofenceDraftFrom({ geofenceRadiusM: 500 }).shape).toBe('circle');
    expect(geofenceDraftFrom({ boundingBox: { west: 1, south: 2, east: 3, north: 4 } }).shape).toBe('box');
    expect(geofenceDraftFrom({ geofenceRadiusM: 500, boundingBox: { west: 1, south: 2, east: 3, north: 4 } }).shape).toBe('both');
  });

  it('sends nothing but "off" with no shape, whatever the flags say', () => {
    expect(geofenceBody({ ...EMPTY_GEOFENCE, radiusM: 500, notifyOnEnter: true, notifyFavoritesOnly: true })).toEqual({
      geofence_radius_m: null, bounding_box: null, notify_on_enter: false, notify_on_exit: false, notify_favorites_only: false,
    });
  });

  it('rejects a radius outside 160 m to 16 km and a missing box', () => {
    expect(geofenceBody({ ...EMPTY_GEOFENCE, shape: 'circle', radiusM: 100 })).toHaveProperty('error');
    expect(geofenceBody({ ...EMPTY_GEOFENCE, shape: 'circle', radiusM: 16001 })).toHaveProperty('error');
    expect(geofenceBody({ ...EMPTY_GEOFENCE, shape: 'box' })).toHaveProperty('error');
  });

  it('drops favourites-only when no alert is on', () => {
    const body = geofenceBody({ ...EMPTY_GEOFENCE, shape: 'circle', radiusM: 500, notifyFavoritesOnly: true });
    expect(body).toMatchObject({ geofence_radius_m: 500, notify_favorites_only: false });
  });
});

function Harness({ initial = EMPTY_GEOFENCE }: { initial?: GeofenceDraft }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <WaypointGeofenceFields value={value} onChange={setValue} center={{ lat: 30, lon: -90 }} />
      <output data-testid="draft">{JSON.stringify(value)}</output>
    </>
  );
}

const draft = () => JSON.parse(screen.getByTestId('draft').textContent!) as GeofenceDraft;

describe('WaypointGeofenceFields', () => {
  it('keeps the alert boxes off until a shape is chosen, then warns when one is on', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const enter = screen.getByRole('checkbox', { name: 'waypoints.geofence.notify_enter' });
    expect(enter).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'waypoints.geofence.favorites_only' })).toBeDisabled();

    await user.selectOptions(screen.getByRole('combobox', { name: 'waypoints.geofence.shape' }), 'circle');
    expect(draft()).toMatchObject({ shape: 'circle', radiusM: 500 });
    expect(enter).toBeEnabled();
    expect(screen.queryByRole('note')).toBeNull();

    await user.click(enter);
    expect(screen.getByRole('note')).toHaveTextContent('waypoints.geofence.alert_warning');
    expect(screen.getByRole('checkbox', { name: 'waypoints.geofence.favorites_only' })).toBeEnabled();
  });

  it('fills the box from the map editor', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'waypoints.geofence.shape' }), 'box');
    await user.click(screen.getByRole('button', { name: 'draw-box' }));
    expect(draft().box).toEqual({ west: -90.1, south: 29.9, east: -89.9, north: 30.1 });
  });
});

describe('WaypointEditorModal geofence', () => {
  it('saves the geofence with the waypoint', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <WaypointEditorModal isOpen initial={null} onClose={vi.fn()} onSave={onSave} defaultCoords={{ lat: 30, lon: -90 }} />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'waypoints.geofence.shape' }), 'circle');
    await user.click(screen.getByRole('checkbox', { name: 'waypoints.geofence.notify_exit' }));
    await user.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      geofence_radius_m: 500, bounding_box: null, notify_on_enter: false, notify_on_exit: true, notify_favorites_only: false,
    });
  });

  it('opens an existing waypoint with its geofence', () => {
    render(
      <WaypointEditorModal
        isOpen
        onClose={vi.fn()}
        onSave={vi.fn()}
        initial={{
          sourceId: 's', waypointId: 1, ownerNodeNum: null, latitude: 30, longitude: -90, expireAt: null,
          lockedTo: null, name: 'Camp', description: '', iconCodepoint: null, iconEmoji: null, isVirtual: false,
          channel: 0, rebroadcastIntervalS: null, lastBroadcastAt: null, firstSeenAt: 0, lastUpdatedAt: 0,
          geofenceRadiusM: 1200, notifyOnEnter: true,
        }}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'waypoints.geofence.shape' })).toHaveValue('circle');
    expect(screen.getByRole('checkbox', { name: 'waypoints.geofence.notify_enter' })).toBeChecked();
    expect(screen.getByText(/1\.20 km/)).toBeInTheDocument();
  });
});
