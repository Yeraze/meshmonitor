/**
 * The `routePositions` snapshot builder (#1862): which nodes go in, which
 * position is stored, and what is left out.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRoutePositionsSnapshot, type SnapshotNode } from './tracerouteSnapshot.js';

const GPS = 1;
const PUBLIC_PIN = 2;
const PRIVATE_PIN = 3;
const NO_POSITION = 4;
const UNKNOWN = 5;
const EQUATOR = 6;

const NODES: Record<number, SnapshotNode> = {
  [GPS]: { latitude: 30.1, longitude: -90.1, altitude: 7 },
  [PUBLIC_PIN]: {
    latitude: 30.2, longitude: -90.2, altitude: 8,
    positionOverrideEnabled: true, latitudeOverride: 31.2, longitudeOverride: -91.2, altitudeOverride: 80,
    positionOverrideIsPrivate: false,
  },
  [PRIVATE_PIN]: {
    latitude: 30.3, longitude: -90.3,
    positionOverrideEnabled: true, latitudeOverride: 31.3, longitudeOverride: -91.3,
    positionOverrideIsPrivate: true,
  },
  [NO_POSITION]: { latitude: null, longitude: null },
  [EQUATOR]: { latitude: 0, longitude: 12.5 },
};
const getNode = async (n: number) => NODES[n] ?? null;

describe('buildRoutePositionsSnapshot', () => {
  it('stores the device GPS, with altitude only when there is one', async () => {
    const snap = JSON.parse(await buildRoutePositionsSnapshot([GPS, EQUATOR], getNode));
    expect(snap).toEqual({
      [GPS]: { lat: 30.1, lng: -90.1, alt: 7 },
      // 0 is a real latitude, not "no position".
      [EQUATOR]: { lat: 0, lng: 12.5 },
    });
  });

  it('stores a PUBLIC position override in place of the GPS (#2847)', async () => {
    const snap = JSON.parse(await buildRoutePositionsSnapshot([PUBLIC_PIN], getNode));
    expect(snap).toEqual({ [PUBLIC_PIN]: { lat: 31.2, lng: -91.2, alt: 80 } });
  });

  it('never stores a PRIVATE position override, nor the GPS under it', async () => {
    const json = await buildRoutePositionsSnapshot([GPS, PRIVATE_PIN], getNode);
    expect(Object.keys(JSON.parse(json))).toEqual([String(GPS)]);
    // Neither the pin nor the device fix it hides is anywhere in the string.
    for (const secret of ['31.3', '-91.3', '30.3', '-90.3']) expect(json).not.toContain(secret);
  });

  it('treats SQLite 1/0 booleans the same as true/false', async () => {
    const sqliteRow: SnapshotNode = {
      ...NODES[PRIVATE_PIN],
      positionOverrideEnabled: 1 as unknown as boolean,
      positionOverrideIsPrivate: 1 as unknown as boolean,
    };
    expect(await buildRoutePositionsSnapshot([PRIVATE_PIN], async () => sqliteRow)).toBe('{}');
  });

  it('leaves out a node with no position and a node with no row', async () => {
    expect(await buildRoutePositionsSnapshot([NO_POSITION, UNKNOWN], getNode)).toBe('{}');
  });

  it('reads each node once, however often it is on the run', async () => {
    const spy = vi.fn(getNode);
    const snap = JSON.parse(await buildRoutePositionsSnapshot([GPS, PUBLIC_PIN, GPS, PUBLIC_PIN, GPS], spy));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(Object.keys(snap).sort()).toEqual([String(GPS), String(PUBLIC_PIN)]);
  });
});
