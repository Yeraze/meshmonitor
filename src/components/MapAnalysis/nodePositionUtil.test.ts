import { describe, it, expect, afterEach } from 'vitest';
import { resolveNodeLatLng } from './nodePositionUtil';
import { setDiscardInvalidPositionsDisplay } from '../../utils/positionDisplayConfig';

describe('resolveNodeLatLng — Null Island display toggle (#4157)', () => {
  // The module flag is process-global; restore the default (discard) after each.
  afterEach(() => setDiscardInvalidPositionsDisplay(true));

  it('drops Null Island (0,0) by default (discard setting on)', () => {
    setDiscardInvalidPositionsDisplay(true);
    expect(resolveNodeLatLng({ latitude: 0, longitude: 0 })).toBeNull();
  });

  it('RENDERS Null Island (0,0) when the discard setting is off', () => {
    setDiscardInvalidPositionsDisplay(false);
    expect(resolveNodeLatLng({ latitude: 0, longitude: 0 })).toEqual([0, 0]);
  });

  it('always drops out-of-range junk, even with the setting off', () => {
    setDiscardInvalidPositionsDisplay(false);
    expect(resolveNodeLatLng({ latitude: 1853.4, longitude: -1598.7 })).toBeNull();
  });

  it('always returns a real position regardless of the toggle', () => {
    setDiscardInvalidPositionsDisplay(false);
    expect(resolveNodeLatLng({ latitude: 26.33, longitude: -80.27 })).toEqual([26.33, -80.27]);
    setDiscardInvalidPositionsDisplay(true);
    expect(resolveNodeLatLng({ latitude: 26.33, longitude: -80.27 })).toEqual([26.33, -80.27]);
  });

  it('still returns null for missing coordinates', () => {
    setDiscardInvalidPositionsDisplay(false);
    expect(resolveNodeLatLng({ latitude: null, longitude: 0 })).toBeNull();
    expect(resolveNodeLatLng({ position: { latitude: 0 } })).toBeNull();
  });
});
