// @vitest-environment jsdom
/**
 * Circle-field behaviour in GeofenceMapEditor.
 *
 * - An out-of-range latitude (e.g. 123) used to stay in the input with no
 *   message while the map silently kept the old centre. It now shows an
 *   inline error.
 * - The radius clamps to GEOFENCE_RADIUS_KM_MAX.
 * - The fields are a text draft: they used to be reformatted from the shape on
 *   every valid keystroke ("1" → "1.000000", then "2" → "1.0000002"), so a
 *   person could not type a multi-digit value.
 * - Typing lat/lng with no circle yet creates one (radius defaults to 10 km).
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeofenceMapEditor from './GeofenceMapEditor';
import type { GeofenceShape } from './auto-responder/types';
import { GEOFENCE_RADIUS_KM_MAX } from './automationInputLimits';

// The map itself is out of scope; skip it (and the drawing layer's useMap()).
vi.mock('./map/BaseMap', () => ({ BaseMap: () => <div data-testid="map" /> }));

const initial: GeofenceShape = { type: 'circle', center: { lat: 26, lng: -80 }, radiusKm: 10 };

function Harness({ onChange, start = initial }: { onChange: (s: GeofenceShape | null) => void; start?: GeofenceShape | null }) {
  const [shape, setShape] = useState<GeofenceShape | null>(start);
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

  // React never rewrites a number input's text to a numerically equal string,
  // so after blur the assertions check the number, not the formatting.
  it('keeps typed text while typing "45.5" character by character', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(lat());
    await user.type(lat(), '45.5');

    expect(lat().value).toBe('45.5');
    // jsdom normalises a number input's .value ("45.500000" reads back as
    // "45.5"), which hides the old reformat bug. React also mirrors the
    // controlled value into the value attribute, and that keeps the raw
    // string, so it shows what the component tried to display: the old code
    // wrote "45.500000" here after the last keystroke.
    expect(lat().getAttribute('value')).toBe('45.5');
    expect(lat().getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ center: { lat: 45.5, lng: -80 } }));

    await user.tab();
    expect(Number(lat().value)).toBe(45.5);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps "123" typed character by character, flags it, and never sends it to the shape', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(lat());
    await user.type(lat(), '123');

    expect(lat().value).toBe('123');
    expect(lat().getAttribute('aria-invalid')).toBe('true');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('automation.geofence_triggers.lat_out_of_range');
    expect(lat().getAttribute('aria-describedby')).toBe(alert.id);
    // "1" and "12" are valid on the way; "123" is not, so the last centre is 12.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ center: { lat: 12, lng: -80 } }));

    // Blur keeps the invalid text and its error.
    await user.tab();
    expect(lat().value).toBe('123');
    expect(screen.getByRole('alert')).toBeTruthy();
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

  it('clamps a radius above the max, in the shape at once and in the field on blur', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(radius());
    await user.type(radius(), '99999');
    expect(radius().value).toBe('99999');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ radiusKm: GEOFENCE_RADIUS_KM_MAX }));

    await user.tab();
    expect(Number(radius().value)).toBe(GEOFENCE_RADIUS_KM_MAX);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('creates a circle from typed lat/lng when none exists, defaulting the radius to 10 km', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} start={null} />);

    await user.type(lat(), '40');
    expect(onChange).not.toHaveBeenCalled(); // no longitude yet

    await user.type(lng(), '-74');
    expect(onChange).toHaveBeenLastCalledWith({ type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 10 });
    expect(radius().value).toBe('10.00');
    // Typed text is left alone.
    expect(lat().value).toBe('40');
    expect(lng().value).toBe('-74');
  });

  it('uses a typed radius when creating the circle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} start={null} />);

    await user.type(radius(), '3');
    await user.type(lat(), '40');
    await user.type(lng(), '-74');
    expect(onChange).toHaveBeenLastCalledWith({ type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 3 });
  });

  it('rewrites the fields when the shape changes from elsewhere (e.g. a map drag)', () => {
    const { rerender } = render(
      <GeofenceMapEditor shape={initial} shapeType="circle" onShapeChange={vi.fn()} />,
    );
    rerender(
      <GeofenceMapEditor
        shape={{ type: 'circle', center: { lat: 10.5, lng: 20.25 }, radiusKm: 7 }}
        shapeType="circle"
        onShapeChange={vi.fn()}
      />,
    );
    expect(lat().value).toBe('10.500000');
    expect(lng().value).toBe('20.250000');
    expect(radius().value).toBe('7.00');
  });
});
