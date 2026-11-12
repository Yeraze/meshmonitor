/**
 * Fixed position map pin: with Fixed Position on, the section shows a map
 * where a click or drag sets the latitude and longitude fields (like "Set
 * fixed position" in the Meshtastic iOS app). With it off, there is no map.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import PositionConfigSection from './PositionConfigSection';
import { SaveBarProvider } from '../../contexts/SaveBarContext';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

// Capture the picker's onChange so the test can stand in for a map click.
let pickerProps: { lat: number | null; lon: number | null; onChange: (lat: number, lon: number) => void; disabled?: boolean; decimals?: number } | null = null;
vi.mock('../map/LocationPinPicker', () => ({
  LocationPinPicker: (props: any) => {
    pickerProps = props;
    return <div data-testid={props.testId} />;
  },
}));

function Harness({ fixedPosition, canWrite = true, onLatLon }: {
  fixedPosition: boolean;
  canWrite?: boolean;
  onLatLon?: (lat: number, lon: number) => void;
}) {
  const [lat, setLat] = useState(26.1);
  const [lon, setLon] = useState(-80.1);
  const noop = () => {};
  return (
    <SaveBarProvider>
      <PositionConfigSection
        canWrite={canWrite}
        positionBroadcastSecs={900}
        positionSmartEnabled={false}
        fixedPosition={fixedPosition}
        fixedLatitude={lat}
        fixedLongitude={lon}
        fixedAltitude={0}
        gpsUpdateInterval={0}
        gpsMode={1}
        broadcastSmartMinimumDistance={0}
        broadcastSmartMinimumIntervalSecs={0}
        positionFlags={0}
        rxGpio={0}
        txGpio={0}
        gpsEnGpio={0}
        setPositionBroadcastSecs={noop}
        setPositionSmartEnabled={noop}
        setFixedPosition={noop}
        setFixedLatitude={(v: number) => { setLat(v); onLatLon?.(v, NaN); }}
        setFixedLongitude={(v: number) => { setLon(v); onLatLon?.(NaN, v); }}
        setFixedAltitude={noop}
        setGpsUpdateInterval={noop}
        setGpsMode={noop}
        setBroadcastSmartMinimumDistance={noop}
        setBroadcastSmartMinimumIntervalSecs={noop}
        setPositionFlags={noop}
        setRxGpio={noop}
        setTxGpio={noop}
        setGpsEnGpio={noop}
        isSaving={false}
        onSave={async () => {}}
      />
    </SaveBarProvider>
  );
}

describe('PositionConfigSection fixed position map pin', () => {
  it('shows no map while Fixed Position is off', () => {
    pickerProps = null;
    render(<Harness fixedPosition={false} />);
    expect(screen.queryByTestId('fixed-position-map')).toBeNull();
  });

  it('shows the map at the current fixed coordinates when Fixed Position is on', () => {
    render(<Harness fixedPosition />);
    expect(screen.getByTestId('fixed-position-map')).toBeTruthy();
    expect(pickerProps?.lat).toBe(26.1);
    expect(pickerProps?.lon).toBe(-80.1);
    expect(pickerProps?.disabled).toBe(false);
  });

  it('a dropped pin fills the latitude and longitude fields', async () => {
    const seen: Array<[number, number]> = [];
    render(<Harness fixedPosition onLatLon={(la, lo) => seen.push([la, lo])} />);
    React.act(() => pickerProps!.onChange(35.0844, -106.6504));
    expect(seen).toEqual([[35.0844, NaN], [NaN, -106.6504]]);
    expect((screen.getByLabelText(/position_config.latitude/, { selector: 'input' }) as HTMLInputElement).value).toBe('35.0844');
    expect((screen.getByLabelText(/position_config.longitude/, { selector: 'input' }) as HTMLInputElement).value).toBe('-106.6504');
  });

  it('steps the coordinate inputs at the precision the pin writes (#4173 review L32)', () => {
    render(<Harness fixedPosition />);
    const decimals = pickerProps!.decimals ?? NaN;
    for (const label of [/position_config.latitude/, /position_config.longitude/]) {
      const input = screen.getByLabelText(label, { selector: 'input' }) as HTMLInputElement;
      expect(Number(input.getAttribute('step'))).toBeCloseTo(10 ** -decimals, 12);
    }
  });

  it('locks the map without configuration write access', () => {
    render(<Harness fixedPosition canWrite={false} />);
    expect(pickerProps?.disabled).toBe(true);
  });
});
