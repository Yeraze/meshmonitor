/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { toNodeCardModel, useRecentTraceroute } from './nodeCardModel';
import type { DbTraceroute } from '../../../services/database';

describe('toNodeCardModel — meshtastic', () => {
  it('maps a flat unified node (DashboardNodePopup shape)', () => {
    const model = toNodeCardModel(
      {
        nodeNum: 42,
        nodeId: '!0000002a',
        longName: 'Tower Node',
        shortName: 'TWR',
        role: 2,
        hwModel: 9,
        hopsAway: 3,
        snr: 5.5,
        batteryLevel: 80,
        lastHeard: 1000,
      },
      'meshtastic',
    );

    expect(model.longName).toBe('Tower Node');
    expect(model.shortName).toBe('TWR');
    expect(model.nodeId).toBe('!0000002a');
    expect(model.nodeNum).toBe(42);
    expect(model.hops).toBe(3);
    expect(model.snr).toBe(5.5);
    expect(model.battery).toBe(80);
    expect(model.lastHeard).toBe(1000);
  });

  it('falls back to nested user/position/deviceMetrics fields (DeviceInfo shape)', () => {
    const model = toNodeCardModel(
      {
        nodeNum: 7,
        user: { id: '!00000007', longName: 'Nested Node', shortName: 'NST', role: 1, hwModel: 4 },
        position: { latitude: 1, longitude: 2, altitude: 120 },
        deviceMetrics: { batteryLevel: 55 },
        hopsAway: 0,
      },
      'meshtastic',
    );

    expect(model.longName).toBe('Nested Node');
    expect(model.shortName).toBe('NST');
    expect(model.nodeId).toBe('!00000007');
    expect(model.hops).toBe(0);
    expect(model.altitude).toBe(120);
    expect(model.battery).toBe(55);
    expect(model.roleName).not.toBeNull();
    expect(model.hwModelName).not.toBeNull();
  });

  it('prefers the flat field over the nested one when both are present', () => {
    const model = toNodeCardModel(
      {
        nodeNum: 1,
        longName: 'Flat Name',
        user: { id: '!x', longName: 'Nested Name' },
      },
      'meshtastic',
    );
    expect(model.longName).toBe('Flat Name');
  });

  it('falls back to a plain "Node {nodeNum}" longName when unnamed', () => {
    const model = toNodeCardModel({ nodeNum: 99 }, 'meshtastic');
    expect(model.longName).toBe('Node 99');
  });

  it('uses opts.nodeFallbackLabel over the plain fallback when supplied', () => {
    const model = toNodeCardModel({ nodeNum: 99 }, 'meshtastic', {
      nodeFallbackLabel: 'Knoten 99',
    });
    expect(model.longName).toBe('Knoten 99');
  });

  it('falls back to "Unknown" when there is no name and no nodeNum', () => {
    const model = toNodeCardModel({}, 'meshtastic');
    expect(model.longName).toBe('Unknown');
  });

  it('prefers opts.effectiveHops over the raw hopsAway', () => {
    const model = toNodeCardModel({ nodeNum: 1, hopsAway: 5 }, 'meshtastic', { effectiveHops: 2 });
    expect(model.hops).toBe(2);
  });

  it('carries opts.pos through as model.position', () => {
    const model = toNodeCardModel({ nodeNum: 1 }, 'meshtastic', { pos: { lat: 1.5, lng: -2.5 } });
    expect(model.position).toEqual({ lat: 1.5, lng: -2.5 });
  });

  it('passes through the sources array untouched', () => {
    const sources = [{ sourceId: 'a', sourceName: 'Alpha', protocol: 'Meshtastic' as const }];
    const model = toNodeCardModel({ nodeNum: 1, sources }, 'meshtastic');
    expect(model.sources).toBe(sources);
  });

  it('leaves hops/snr/battery/altitude/lastHeard null when absent (missing-data behavior)', () => {
    const model = toNodeCardModel({ nodeNum: 1, longName: 'Bare' }, 'meshtastic');
    expect(model.hops).toBeNull();
    expect(model.snr).toBeNull();
    expect(model.battery).toBeNull();
    expect(model.altitude).toBeNull();
    expect(model.lastHeard).toBeNull();
    expect(model.roleName).toBeNull();
    expect(model.hwModelName).toBeNull();
    expect(model.sources).toBeUndefined();
    expect(model.position).toBeUndefined();
    // #4176: precision + location source default to null when absent
    expect(model.positionPrecisionBits).toBeNull();
    expect(model.positionLocationSource).toBeNull();
  });

  it('maps position accuracy + location source when present (#4176)', () => {
    const model = toNodeCardModel(
      {
        nodeNum: 5,
        longName: 'GPS Node',
        positionPrecisionBits: 18,
        positionLocationSource: 2,
      },
      'meshtastic',
    );
    expect(model.positionPrecisionBits).toBe(18);
    expect(model.positionLocationSource).toBe(2);
  });

  it('leaves precision/location-source null when the fields are non-numeric (#4176)', () => {
    // toNodeCardModel accepts `unknown`, so malformed input needs no cast.
    const model = toNodeCardModel(
      { nodeNum: 5, positionPrecisionBits: 'x', positionLocationSource: null },
      'meshtastic',
    );
    expect(model.positionPrecisionBits).toBeNull();
    expect(model.positionLocationSource).toBeNull();
  });

  it('tolerates non-object raw input', () => {
    expect(() => toNodeCardModel(null, 'meshtastic')).not.toThrow();
    expect(() => toNodeCardModel(undefined, 'meshtastic')).not.toThrow();
    expect(toNodeCardModel(null, 'meshtastic').longName).toBe('Unknown');
  });
});

describe('toNodeCardModel — meshcore', () => {
  it('maps a MeshCore contact', () => {
    const model = toNodeCardModel(
      {
        publicKey: 'abcdef0123456789abcdef0123456789',
        advName: 'Repeater One',
        rssi: -80,
        snr: 4.5,
        pathLen: 2,
        outPath: 'a3,7f',
        lastSeen: 1_700_000_000_000,
      },
      'meshcore',
    );

    expect(model.longName).toBe('Repeater One');
    expect(model.nodeId).toBe('abcdef0123456789abcdef0123456789');
    expect(model.meshcore?.publicKey).toBe('abcdef0123456789abcdef0123456789');
    expect(model.meshcore?.rssi).toBe(-80);
    expect(model.meshcore?.snr).toBe(4.5);
    expect(model.meshcore?.pathLen).toBe(2);
    expect(model.meshcore?.outPath).toBe('a3,7f');
    // lastHeard is unit-normalized to epoch SECONDS.
    expect(model.lastHeard).toBe(1_700_000_000);
    // meshcore.lastSeen keeps the raw epoch-ms value.
    expect(model.meshcore?.lastSeen).toBe(1_700_000_000_000);
  });

  it('falls back to `name` when `advName` is absent, and "MeshCore" when both are', () => {
    expect(toNodeCardModel({ publicKey: 'k', name: 'Bob' }, 'meshcore').longName).toBe('Bob');
    expect(toNodeCardModel({ publicKey: 'k' }, 'meshcore').longName).toBe('MeshCore');
  });

  it('leaves meshcore sub-fields undefined and lastHeard null when absent (missing-data behavior)', () => {
    const model = toNodeCardModel({ publicKey: 'k' }, 'meshcore');
    expect(model.lastHeard).toBeNull();
    expect(model.meshcore?.rssi).toBeUndefined();
    expect(model.meshcore?.snr).toBeUndefined();
    expect(model.meshcore?.pathLen).toBeNull();
    expect(model.meshcore?.outPath).toBeUndefined();
  });

  it('has no meshtastic-only fields set', () => {
    const model = toNodeCardModel({ publicKey: 'k', advName: 'Bob' }, 'meshcore');
    expect(model.hops).toBeUndefined();
    expect(model.roleName).toBeUndefined();
    expect(model.hwModelName).toBeUndefined();
  });
});

describe('useRecentTraceroute', () => {
  const makeTr = (overrides: Partial<DbTraceroute>): DbTraceroute => ({
    fromNodeNum: 1,
    toNodeNum: 2,
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    route: '[]',
    routeBack: '[]',
    snrTowards: '[]',
    snrBack: '[]',
    timestamp: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  });

  it('returns null when any of traceroutes/currentNodeId/targetNodeId is missing', () => {
    expect(renderHook(() => useRecentTraceroute(undefined, '!00000001', '!00000002')).result.current).toBeNull();
    expect(renderHook(() => useRecentTraceroute([], null, '!00000002')).result.current).toBeNull();
    expect(renderHook(() => useRecentTraceroute([], '!00000001', null)).result.current).toBeNull();
  });

  it('returns null when current and target are the same node (self-traceroute guard)', () => {
    const { result } = renderHook(() =>
      useRecentTraceroute([makeTr({})], '!00000001', '!00000001'),
    );
    expect(result.current).toBeNull();
  });

  it('picks the most recent traceroute in either direction, within the display window', () => {
    const now = Date.now();
    const older = makeTr({ fromNodeNum: 1, toNodeNum: 2, timestamp: now - 60_000 });
    const newer = makeTr({ fromNodeNum: 2, toNodeNum: 1, timestamp: now - 1_000 });
    const { result } = renderHook(() =>
      useRecentTraceroute([older, newer], '!00000001', '!00000002'),
    );
    expect(result.current).toBe(newer);
  });

  it('excludes traceroutes outside the TRACEROUTE_DISPLAY_HOURS window', () => {
    const stale = makeTr({
      fromNodeNum: 1,
      toNodeNum: 2,
      timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days, window is 7
    });
    const { result } = renderHook(() =>
      useRecentTraceroute([stale], '!00000001', '!00000002'),
    );
    expect(result.current).toBeNull();
  });

  it('excludes traceroutes between unrelated nodes', () => {
    const unrelated = makeTr({ fromNodeNum: 5, toNodeNum: 6, timestamp: Date.now() });
    const { result } = renderHook(() =>
      useRecentTraceroute([unrelated], '!00000001', '!00000002'),
    );
    expect(result.current).toBeNull();
  });

  it('includes failed traceroutes (route === "null")', () => {
    const failed = makeTr({ fromNodeNum: 1, toNodeNum: 2, route: 'null', timestamp: Date.now() });
    const { result } = renderHook(() =>
      useRecentTraceroute([failed], '!00000001', '!00000002'),
    );
    expect(result.current).toBe(failed);
  });

  it('returns null when the node ids do not parse to numbers', () => {
    const { result } = renderHook(() =>
      useRecentTraceroute([makeTr({})], 'not-a-node-id', '!00000002'),
    );
    expect(result.current).toBeNull();
  });
});
