// @vitest-environment jsdom
/**
 * Circle-field behaviour in GeofenceMapEditor.
 *
 * - An out-of-range latitude (e.g. 123) used to stay in the input with no
 *   message while the map silently kept the old centre. It now shows an
 *   inline error, as soon as it is typed.
 * - The radius clamps to GEOFENCE_RADIUS_KM_MAX.
 * - The fields are a text draft: they used to be reformatted from the shape on
 *   every valid keystroke ("1" → "1.000000", then "2" → "1.0000002"), so a
 *   person could not type a multi-digit value.
 * - Typed values reach the circle on blur, on Enter, or after
 *   GEOFENCE_FIELD_COMMIT_DELAY_MS without a keystroke. Each valid prefix used
 *   to be applied at once, so typing "123" moved the circle to lat 12 first.
 * - Blur reformats a valid field whether or not a circle existed. A value typed
 *   before the circle existed used to keep its raw text until a second blur.
 * - Typing lat/lng with no circle yet creates one (radius defaults to 10 km).
 *
 * jsdom normalises a number input's .value ("45.500000" reads back as "45.5").
 * React mirrors the controlled value into the value attribute, which keeps the
 * raw string, so formatting is asserted on getAttribute('value').
 */
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeofenceMapEditor from './GeofenceMapEditor';
import type { GeofenceShape } from './auto-responder/types';
import { GEOFENCE_RADIUS_KM_MAX } from './automationInputLimits';
import { GEOFENCE_FIELD_COMMIT_DELAY_MS } from './geofenceEditorGeometry';

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
const shown = (el: HTMLInputElement) => el.getAttribute('value');

/** Every latitude the editor ever sent to the parent. */
const sentLats = (onChange: ReturnType<typeof vi.fn>) =>
  onChange.mock.calls
    .map(([s]) => s as GeofenceShape | null)
    .filter((s): s is Extract<GeofenceShape, { type: 'circle' }> => s?.type === 'circle')
    .map(s => s.center.lat);

afterEach(() => {
  vi.useRealTimers();
});

describe('GeofenceMapEditor circle fields', () => {
  it('labels all three inputs', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(lat().type).toBe('number');
    expect(lng().type).toBe('number');
    expect(radius().type).toBe('number');
  });

  it('keeps typed text while typing "45.5" and applies it on blur', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(lat());
    await user.type(lat(), '45.5');

    expect(lat().value).toBe('45.5');
    // The old code wrote "45.500000" here after the last keystroke.
    expect(shown(lat())).toBe('45.5');
    expect(lat().getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Typing alone does not move the circle.
    expect(onChange).not.toHaveBeenCalled();

    await user.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ center: { lat: 45.5, lng: -80 } }));
    expect(shown(lat())).toBe('45.500000');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('typing "123" never moves the circle to 1 or 12, and flags 123 at once', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(lat());
    await user.type(lat(), '123');

    expect(lat().value).toBe('123');
    // Validation does not wait for the commit.
    expect(lat().getAttribute('aria-invalid')).toBe('true');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('automation.geofence_triggers.lat_out_of_range');
    expect(lat().getAttribute('aria-describedby')).toBe(alert.id);

    // Blur keeps the invalid text and its error, and still sends nothing.
    await user.tab();
    expect(lat().value).toBe('123');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(sentLats(onChange)).not.toContain(1);
    expect(sentLats(onChange)).not.toContain(12);
    expect(onChange).not.toHaveBeenCalled();
  });

  // userEvent's own delays hang under fake timers, so these type one
  // character at a time with change events and step the clock between them.
  const typeSlowly = (el: HTMLInputElement, text: string, pauseMs: number) => {
    for (let i = 1; i <= text.length; i++) {
      fireEvent.change(el, { target: { value: text.slice(0, i) } });
      act(() => {
        vi.advanceTimersByTime(pauseMs);
      });
    }
  };

  it('typing "123" with pauses shorter than the delay never moves the circle to 12', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(lat(), { target: { value: '' } });
    typeSlowly(lat(), '123', GEOFENCE_FIELD_COMMIT_DELAY_MS - 50);
    act(() => {
      vi.advanceTimersByTime(GEOFENCE_FIELD_COMMIT_DELAY_MS * 3);
    });

    expect(sentLats(onChange)).not.toContain(12);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('applies a typed value after the idle delay, without reformatting it', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    typeSlowly(lat(), '45.5', 50);
    act(() => {
      vi.advanceTimersByTime(GEOFENCE_FIELD_COMMIT_DELAY_MS - 51);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ center: { lat: 45.5, lng: -80 } }));
    // The text stays as typed until the user leaves the field.
    expect(shown(lat())).toBe('45.5');
  });

  it('Enter applies and reformats the value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(lng());
    await user.type(lng(), '-81.25{Enter}');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ center: { lat: 26, lng: -81.25 } }));
    expect(shown(lng())).toBe('-81.250000');
  });

  it('flags an out-of-range longitude inline', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(lng(), { target: { value: '-200' } });
    expect(screen.getByRole('alert').textContent).toContain('automation.geofence_triggers.lng_out_of_range');
    fireEvent.blur(lng());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('flags a non-positive radius inline', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(radius(), { target: { value: '0' } });
    expect(screen.getByRole('alert').textContent).toContain('automation.geofence_triggers.radius_invalid');
    fireEvent.blur(radius());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps a radius above the max, in the shape and the field on blur', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.clear(radius());
    await user.type(radius(), '99999');
    expect(radius().value).toBe('99999');

    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ radiusKm: GEOFENCE_RADIUS_KM_MAX }));
    expect(Number(radius().value)).toBe(GEOFENCE_RADIUS_KM_MAX);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('creates a circle from typed lat/lng when none exists, defaulting the radius to 10 km', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} start={null} />);

    await user.type(lat(), '40');
    await user.tab();
    expect(onChange).not.toHaveBeenCalled(); // no longitude yet

    await user.type(lng(), '-74');
    await user.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 10 });
    expect(shown(radius())).toBe('10.00');
  });

  it('blur reformats a value typed before the circle existed, and the one that created it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} start={null} />);

    // No circle yet: the first blur still formats the field.
    await user.type(lat(), '40');
    await user.tab();
    expect(shown(lat())).toBe('40.000000');

    // This blur creates the circle; its own field is formatted on the same blur.
    await user.type(lng(), '-74');
    await user.tab();
    expect(shown(lng())).toBe('-74.000000');
    expect(shown(lat())).toBe('40.000000');
    expect(shown(radius())).toBe('10.00');
  });

  it('uses a typed radius when creating the circle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} start={null} />);

    await user.type(radius(), '3');
    await user.type(lat(), '40');
    await user.type(lng(), '-74');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith({ type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 3 });
    expect(shown(radius())).toBe('3.00');
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

  it('a shape change from elsewhere cancels a pending typed commit', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <GeofenceMapEditor shape={initial} shapeType="circle" onShapeChange={onChange} />,
    );
    fireEvent.change(lat(), { target: { value: '45' } });
    rerender(
      <GeofenceMapEditor
        shape={{ type: 'circle', center: { lat: 10.5, lng: 20.25 }, radiusKm: 7 }}
        shapeType="circle"
        onShapeChange={onChange}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(GEOFENCE_FIELD_COMMIT_DELAY_MS * 2);
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(shown(lat())).toBe('10.500000');
  });

  it('a pending commit does not fire after unmount', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { unmount } = render(<Harness onChange={onChange} />);
    fireEvent.change(lat(), { target: { value: '45' } });
    unmount();
    vi.advanceTimersByTime(GEOFENCE_FIELD_COMMIT_DELAY_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });
});
