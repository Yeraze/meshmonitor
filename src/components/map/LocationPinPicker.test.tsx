// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Handlers the picker registers, so a test can fire a map click or a pin drag.
const mapHandlers: { click?: (e: { latlng: { lat: number; lng: number } }) => void } = {};
let lastMarkerProps: any = null;
const setView = vi.fn();
let boundsContain = true;

vi.mock('react-leaflet', () => ({
  useMapEvents: (handlers: any) => {
    mapHandlers.click = handlers.click;
    return {};
  },
  useMap: () => ({
    getBounds: () => ({ contains: () => boundsContain }),
    getZoom: () => 5,
    setView,
  }),
  Marker: (props: any) => {
    lastMarkerProps = props;
    return <div data-testid="pin" />;
  },
}));

vi.mock('./BaseMap', () => ({
  BaseMap: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

import { LocationPinPicker } from './LocationPinPicker';
import { hasPinPosition, normalizePinPosition } from './locationPin';

describe('hasPinPosition', () => {
  it('treats null, (0,0) and out-of-range values as no position', () => {
    expect(hasPinPosition(null, null)).toBe(false);
    expect(hasPinPosition(0, 0)).toBe(false);
    expect(hasPinPosition(91, 10)).toBe(false);
    expect(hasPinPosition(10, 181)).toBe(false);
    expect(hasPinPosition(Number.NaN, 10)).toBe(false);
  });

  it('accepts a real coordinate, including one on the equator or prime meridian', () => {
    expect(hasPinPosition(26.1, -80.1)).toBe(true);
    expect(hasPinPosition(0, 12)).toBe(true);
    expect(hasPinPosition(51.5, 0)).toBe(true);
  });
});

describe('normalizePinPosition', () => {
  it('rounds to the requested decimals', () => {
    expect(normalizePinPosition(26.123456789, -80.987654321, 7)).toEqual([26.1234568, -80.9876543]);
    expect(normalizePinPosition(26.123456789, -80.987654321, 6)).toEqual([26.123457, -80.987654]);
  });

  it('wraps a longitude panned past the antimeridian', () => {
    const [, lon] = normalizePinPosition(10, 190, 6);
    expect(lon).toBe(-170);
    const [, lon2] = normalizePinPosition(10, -200, 6);
    expect(lon2).toBe(160);
  });
});

describe('LocationPinPicker', () => {
  beforeEach(() => {
    mapHandlers.click = undefined;
    lastMarkerProps = null;
    setView.mockClear();
    boundsContain = true;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows no pin and an unset hint when there is no position', () => {
    render(<LocationPinPicker lat={0} lon={0} onChange={vi.fn()} />);
    expect(screen.queryByTestId('pin')).toBeNull();
    expect(screen.getByText('location_picker.hint_unset')).toBeTruthy();
  });

  it('drops a pin where the map is clicked', () => {
    const onChange = vi.fn();
    render(<LocationPinPicker lat={null} lon={null} onChange={onChange} decimals={6} />);
    mapHandlers.click?.({ latlng: { lat: 26.1234567, lng: -80.7654321 } });
    expect(onChange).toHaveBeenCalledWith(26.123457, -80.765432);
  });

  it('ignores clicks when disabled and makes the pin non-draggable', () => {
    const onChange = vi.fn();
    render(<LocationPinPicker lat={26} lon={-80} onChange={onChange} disabled />);
    mapHandlers.click?.({ latlng: { lat: 1, lng: 2 } });
    expect(onChange).not.toHaveBeenCalled();
    expect(lastMarkerProps.draggable).toBe(false);
  });

  it('reports the new position when the pin is dragged', () => {
    const onChange = vi.fn();
    render(<LocationPinPicker lat={26} lon={-80} onChange={onChange} />);
    expect(screen.getByTestId('pin')).toBeTruthy();
    expect(lastMarkerProps.draggable).toBe(true);
    lastMarkerProps.eventHandlers.dragend({ target: { getLatLng: () => ({ lat: 27.5, lng: -81.25 }) } });
    expect(onChange).toHaveBeenCalledWith(27.5, -81.25);
    expect(screen.getByText('location_picker.hint_set')).toBeTruthy();
  });

  it('pans to the pin when typed coordinates put it off screen', () => {
    boundsContain = false;
    render(<LocationPinPicker lat={40} lon={-74} onChange={vi.fn()} />);
    expect(setView).toHaveBeenCalled();
  });

  it('uses the browser location when asked', () => {
    const onChange = vi.fn();
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: (p: any) => void) => ok({ coords: { latitude: 35.1, longitude: -106.6 } }),
      },
    });
    render(<LocationPinPicker lat={null} lon={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /location_picker.use_my_location/ }));
    expect(onChange).toHaveBeenCalledWith(35.1, -106.6);
  });

  it('shows an error when the browser refuses location', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: { getCurrentPosition: (_ok: unknown, fail: () => void) => fail() },
    });
    render(<LocationPinPicker lat={null} lon={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /location_picker.use_my_location/ }));
    expect(screen.getByRole('alert').textContent).toBe('location_picker.locate_failed');
  });
});
