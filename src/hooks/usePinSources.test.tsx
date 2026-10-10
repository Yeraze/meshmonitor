/**
 * @vitest-environment jsdom
 *
 * #5685: which sources the Map Analysis pin picker offers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { canSourceSendWaypoints } from '../utils/waypointSources';

type Src = { id: string; name: string; type: string; enabled: boolean };
let sources: Src[] = [];
let writable = new Set<string>();
let isAdmin = false;

vi.mock('./useDashboardData', () => ({
  useDashboardSources: () => ({ data: sources }),
}));

// Stable identity, as the real `useAuth()` gives.
const hasPermission = (resource: string, action: string, opts?: { sourceId?: string | null }) =>
  isAdmin || (resource === 'waypoints' && action === 'write' && writable.has(opts?.sourceId ?? ''));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission }),
}));

import { usePinSources } from './usePinSources';

const ALL: Src[] = [
  { id: 'radio-a', name: 'Radio A', type: 'meshtastic_tcp', enabled: true },
  { id: 'radio-b', name: 'Radio B', type: 'meshtastic_tcp', enabled: true },
  { id: 'radio-off', name: 'Radio Off', type: 'meshtastic_tcp', enabled: false },
  { id: 'broker', name: 'Broker', type: 'mqtt_broker', enabled: true },
  { id: 'bridge', name: 'Bridge', type: 'mqtt_bridge', enabled: true },
  { id: 'mc', name: 'MeshCore', type: 'meshcore', enabled: true },
  { id: 'mc-mqtt', name: 'MC Observer', type: 'meshcore_mqtt', enabled: true },
  { id: 'ret', name: 'Reticulum', type: 'reticulum', enabled: true },
];

const ids = (list: Array<{ id: string }>) => list.map((s) => s.id);

describe('canSourceSendWaypoints', () => {
  it('is true only for an enabled Meshtastic radio source', () => {
    expect(ALL.filter(canSourceSendWaypoints).map((s) => s.id)).toEqual(['radio-a', 'radio-b']);
  });

  it('treats a missing enabled flag as enabled, and a missing type as unable to send', () => {
    expect(canSourceSendWaypoints({ type: 'meshtastic_tcp' })).toBe(true);
    expect(canSourceSendWaypoints({})).toBe(false);
  });
});

describe('usePinSources', () => {
  beforeEach(() => {
    sources = ALL;
    writable = new Set();
    isAdmin = false;
  });

  it('offers nothing to a user with no waypoints:write grant', () => {
    const { result } = renderHook(() => usePinSources());
    expect(result.current.waypointSources).toEqual([]);
    expect(result.current.markerSources).toEqual([]);
  });

  it('offers only the radio sources the user can write to', () => {
    writable = new Set(['radio-b', 'broker', 'mc']);
    const { result } = renderHook(() => usePinSources());
    expect(ids(result.current.waypointSources)).toEqual(['radio-b']);
    // A local marker is stored only, so any writable source will do.
    expect(ids(result.current.markerSources)).toEqual(['radio-b', 'broker', 'mc']);
  });

  it('leaves MQTT, MeshCore and Reticulum sources out of the waypoint list even for an admin', () => {
    isAdmin = true;
    const { result } = renderHook(() => usePinSources());
    expect(ids(result.current.waypointSources)).toEqual(['radio-a', 'radio-b']);
    expect(ids(result.current.markerSources)).toEqual(
      ['radio-a', 'radio-b', 'broker', 'bridge', 'mc', 'mc-mqtt', 'ret'],
    );
  });

  it('has no waypoint source when write is held only on sources with no radio', () => {
    writable = new Set(['broker', 'mc']);
    const { result } = renderHook(() => usePinSources());
    expect(result.current.waypointSources).toEqual([]);
    expect(ids(result.current.markerSources)).toEqual(['broker', 'mc']);
  });

  it('skips a disabled radio source: it has no manager to send with', () => {
    writable = new Set(['radio-off']);
    const { result } = renderHook(() => usePinSources());
    expect(result.current.waypointSources).toEqual([]);
    expect(result.current.markerSources).toEqual([]);
  });

  it('falls back to the id when a source has no name', () => {
    sources = [{ id: 'radio-x', name: '', type: 'meshtastic_tcp', enabled: true }];
    writable = new Set(['radio-x']);
    const { result } = renderHook(() => usePinSources());
    expect(result.current.waypointSources).toEqual([{ id: 'radio-x', name: 'radio-x' }]);
  });
});
