// @vitest-environment jsdom
/**
 * Circle-field validation in GeofenceMapEditor.
 *
 * An out-of-range latitude (e.g. 123) used to stay in the input with no
 * message while the map silently kept the old centre, and the radius took any
 * positive value (99999 km could be saved). The coordinates now show an inline
 * error and the radius clamps to GEOFENCE_RADIUS_KM_MAX.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GeofenceMapEditor from './GeofenceMapEditor';
import type { GeofenceShape } from './auto-responder/types';
import { GEOFENCE_RADIUS_KM_MAX } from './automationInputLimits';

// The map itself is out of scope; skip it (and the drawing layer's useMap()).
vi.mock('./map/BaseMap', () => ({ BaseMap: () => <div data-testid="map" /> }));

const initial: GeofenceShape = { type: 'circle', center: { lat: 26, lng: -80 }, radiusKm: 10 };

function Harness({ onChange }: { onChange: (s: GeofenceShape | null) => void }) {
  const [shape, setShape] = useState<GeofenceShape | null>(initial);
  return (
    <GeofenceMapEditor
      shape={shape}
      shapeType="circle"
      onShapeChange={(s) => {
        onChange(s);
        setShape(s);
      }}
    />
  );
}

const lat = () => screen.getByLabelText('automation.geofence_triggers.center_lat') as HTMLInputElement;
const lng = () => screen.getByLabelText('automation.geofence_triggers.center_lng') as HTMLInputElement;
const radius = () => screen.getByLabelText('automation.geofence_triggers.radius_km') as HTMLInputElement;

describe('GeofenceMapEditor circle fields', () => {
  it('labels all three inputs', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(lat().type).toBe('number');
    expect(lng().type).toBe('number');
    expect(radius().type).toBe('number');
  });

  it('flags an out-of-range latitude inline and keeps the last valid centre', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(lat(), { target: { value: '123' } });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('automation.geofence_triggers.lat_out_of_range');
    expect(lat().getAttribute('aria-invalid')).toBe('true');
    expect(lat().getAttribute('aria-describedby')).toBe(alert.id);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(lat(), { target: { value: '45' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lat().getAttribute('aria-invalid')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ center: { lat: 45, lng: -80 } }));
  });

  it('flags an out-of-range longitude inline', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(lng(), { target: { value: '-200' } });
    expect(screen.getByRole('alert').textContent).toContain('automation.geofence_triggers.lng_out_of_range');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('flags a non-positive radius inline', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(radius(), { target: { value: '0' } });
    expect(screen.getByRole('alert').textContent).toContain('automation.geofence_triggers.radius_invalid');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps a radius above the max, in the shape at once and in the field on blur', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(radius(), { target: { value: '99999' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ radiusKm: GEOFENCE_RADIUS_KM_MAX }));

    fireEvent.blur(radius());
    expect(radius().value).toBe(GEOFENCE_RADIUS_KM_MAX.toFixed(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
