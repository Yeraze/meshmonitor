/**
 * Tests for useAutoRadioDefaults (Terrain Link Profile epic #4111, Phase 3,
 * WP-2). Mocks `useDashboardSources` directly (rather than fetch) so this
 * stays a pure unit test of the resolution logic: candidate selection
 * (A-preferred), radio -> freq/RX/provenance mapping, and graceful nulls.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoRadioDefaults } from './useAutoRadioDefaults';
import type { LinkEndpoint } from '../utils/linkProfile';
import type { DashboardSource } from './useDashboardData';

const useDashboardSourcesMock = vi.fn();
vi.mock('./useDashboardData', () => ({
  useDashboardSources: (...args: unknown[]) => useDashboardSourcesMock(...args),
}));

function mockSources(sources: DashboardSource[]) {
  useDashboardSourcesMock.mockReturnValue({ data: sources });
}

const nodeA: LinkEndpoint = { id: 'node-a', lat: 1, lng: 2, isNode: true, sourceId: 'src-a' };
const nodeB: LinkEndpoint = { id: 'node-b', lat: 3, lng: 4, isNode: true, sourceId: 'src-b' };
const arbitraryPoint: LinkEndpoint = { id: 'pt-1', lat: 5, lng: 6, isNode: false };

const SRC_A: DashboardSource = {
  id: 'src-a',
  name: 'Home Base',
  type: 'meshtastic_tcp',
  enabled: true,
  radio: { frequencyMhz: 906.875, regionName: 'US', modemPreset: 0 },
};

const SRC_B: DashboardSource = {
  id: 'src-b',
  name: 'Repeater Hill',
  type: 'meshcore',
  enabled: true,
  radio: { frequencyMhz: 869.525 },
};

// #4111 P3 WP-2 follow-up fixtures: a unified-merged node whose primary
// `sourceId` (newest reporter) is a radio-less MQTT bridge, but whose full
// `sourceIds` membership also includes a real meshtastic source with a radio.
const SRC_MQTT: DashboardSource = {
  id: 'src-mqtt',
  name: 'Florida MQTT',
  type: 'mqtt',
  enabled: true,
  radio: null,
};

const SRC_SANDBOX: DashboardSource = {
  id: 'src-sandbox',
  name: 'Sandbox',
  type: 'meshtastic_tcp',
  enabled: true,
  radio: { frequencyMhz: 913.125, regionName: 'US', modemPreset: 0 },
};

const multiSourceNode: LinkEndpoint = {
  id: 'node-multi',
  lat: 7,
  lng: 8,
  isNode: true,
  sourceId: 'src-mqtt', // newest reporter — radio-less MQTT bridge
  sourceIds: ['src-mqtt', 'src-sandbox'],
};

describe('useAutoRadioDefaults', () => {
  it('returns freq/RX/provenance for a node endpoint with a matching radio source', () => {
    mockSources([SRC_A, SRC_B]);
    const { result } = renderHook(() => useAutoRadioDefaults(nodeA, undefined));
    expect(result.current.freqMhz).toBe(906.875);
    expect(result.current.rxSensitivityDbm).not.toBeNull();
    expect(result.current.provenance).toBe('from Home Base (US)');
  });

  it('prefers endpoint A over B when both resolve to a radio-reporting source', () => {
    mockSources([SRC_A, SRC_B]);
    const { result } = renderHook(() => useAutoRadioDefaults(nodeA, nodeB));
    expect(result.current.freqMhz).toBe(906.875);
    expect(result.current.provenance).toBe('from Home Base (US)');
  });

  it('falls back to endpoint B when A has no sourceId', () => {
    mockSources([SRC_A, SRC_B]);
    const { result } = renderHook(() => useAutoRadioDefaults(arbitraryPoint, nodeB));
    expect(result.current.freqMhz).toBe(869.525);
    expect(result.current.provenance).toBe('from Repeater Hill');
  });

  it('returns all null for two arbitrary (non-node) endpoints', () => {
    mockSources([SRC_A, SRC_B]);
    const { result } = renderHook(() =>
      useAutoRadioDefaults(arbitraryPoint, { ...arbitraryPoint, id: 'pt-2' })
    );
    expect(result.current).toEqual({ freqMhz: null, rxSensitivityDbm: null, provenance: null });
  });

  it('returns all null when the source list has no matching source (deleted/unknown source)', () => {
    mockSources([SRC_B]);
    const { result } = renderHook(() => useAutoRadioDefaults(nodeA, undefined));
    expect(result.current).toEqual({ freqMhz: null, rxSensitivityDbm: null, provenance: null });
  });

  it('returns all null when the matched source has no radio summary', () => {
    mockSources([{ ...SRC_A, radio: null }]);
    const { result } = renderHook(() => useAutoRadioDefaults(nodeA, undefined));
    expect(result.current).toEqual({ freqMhz: null, rxSensitivityDbm: null, provenance: null });
  });

  it('sets rxSensitivityDbm null but still returns freqMhz when modemPreset is absent (e.g. MeshCore)', () => {
    mockSources([SRC_B]);
    const { result } = renderHook(() => useAutoRadioDefaults(nodeB, undefined));
    expect(result.current.freqMhz).toBe(869.525);
    expect(result.current.rxSensitivityDbm).toBeNull();
    expect(result.current.provenance).toBe('from Repeater Hill');
  });

  it('returns all null while sources are still loading (data undefined)', () => {
    useDashboardSourcesMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useAutoRadioDefaults(nodeA, undefined));
    expect(result.current).toEqual({ freqMhz: null, rxSensitivityDbm: null, provenance: null });
  });

  it('returns all null when no endpoints are picked', () => {
    mockSources([SRC_A]);
    const { result } = renderHook(() => useAutoRadioDefaults(undefined, undefined));
    expect(result.current).toEqual({ freqMhz: null, rxSensitivityDbm: null, provenance: null });
  });

  describe('multi-source nodes (#4111 P3 WP-2 follow-up)', () => {
    it('skips a radio-less primary sourceId and seeds from a secondary source in sourceIds', () => {
      mockSources([SRC_MQTT, SRC_SANDBOX]);
      const { result } = renderHook(() => useAutoRadioDefaults(multiSourceNode, undefined));
      expect(result.current.freqMhz).toBe(913.125);
      expect(result.current.rxSensitivityDbm).not.toBeNull();
      expect(result.current.provenance).toBe('from Sandbox (US)');
    });

    it('returns all null when every source in sourceIds is radio-less', () => {
      mockSources([SRC_MQTT, { ...SRC_SANDBOX, id: 'src-mqtt-2', radio: null }]);
      const radioLessNode: LinkEndpoint = {
        id: 'node-radioless',
        lat: 9,
        lng: 10,
        isNode: true,
        sourceId: 'src-mqtt',
        sourceIds: ['src-mqtt', 'src-mqtt-2'],
      };
      const { result } = renderHook(() => useAutoRadioDefaults(radioLessNode, undefined));
      expect(result.current).toEqual({ freqMhz: null, rxSensitivityDbm: null, provenance: null });
    });

    it('exhausts endpoint A\'s full sourceIds list before falling back to endpoint B', () => {
      mockSources([SRC_MQTT, SRC_SANDBOX, SRC_B]);
      const { result } = renderHook(() => useAutoRadioDefaults(multiSourceNode, nodeB));
      // A's list (src-mqtt radio-less, src-sandbox has radio) resolves before B is consulted.
      expect(result.current.freqMhz).toBe(913.125);
      expect(result.current.provenance).toBe('from Sandbox (US)');
    });
  });
});
