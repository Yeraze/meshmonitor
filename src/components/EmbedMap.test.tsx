/**
 * @vitest-environment jsdom
 *
 * EmbedMap traceroute + BaseMap/NeighborLinksLayer adoption (#4047 P6 WP2,
 * P7 WP9/§3.4). The embed bundle has no SettingsProvider, so this suite
 * pins the palette-from-tileset contract (§3.1), the wire→
 * TracerouteRenderSegment mapping including old-shape (pre-WP1) resilience
 * (§3.2), that the popup capability survives the fixed-mauve→shared-layer
 * swap (§3.3), that EmbedMap's tile/shell wiring goes through `BaseMap`
 * with the exact shell props (§3.4), and that neighbor-info lines are
 * emitted as `NeighborLinksLayer` descriptors preserving the amber/w3/o.7/
 * dash '5, 5' look byte-for-byte (§4.1). `TraceroutePathsLayer`,
 * `NeighborLinksLayer`, and `BaseMap` are all mocked so assertions target
 * the exact props EmbedMap computes and passes to them, rather than
 * re-deriving colors/geometry/tiles through the real components (those
 * components' own behavior is covered by their own test files).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { EmbedMap } from './EmbedMap';
import type { TraceroutePathsLayerProps } from './map/layers/TraceroutePathsLayer';
import type { NeighborLinksLayerProps } from './map/layers/NeighborLinksLayer';
import type { BaseMapProps } from './map/BaseMap';
import { getOverlayColors, getSchemeForTileset } from '../config/overlayColors';

// ---------------------------------------------------------------------------
// react-leaflet mock (mirrors TraceroutePathsLayer.test.tsx / NodeMarkersLayer.test.tsx)
// ---------------------------------------------------------------------------

interface MockChildProps {
  children?: ReactNode;
}

vi.mock('react-leaflet', () => ({
  Marker: (props: MockChildProps) => <div data-testid="marker">{props.children}</div>,
  Tooltip: (props: MockChildProps) => <div data-testid="tooltip">{props.children}</div>,
  Popup: (props: MockChildProps) => <div data-testid="popup">{props.children}</div>,
  GeoJSON: () => <div data-testid="geojson" />,
}));

// ---------------------------------------------------------------------------
// BaseMap mock — passthrough for children (its own tile/shell behavior is
// covered by BaseMap.test.tsx) with a spy on the exact shell props EmbedMap
// passes, mirroring the DefaultMapCenterPicker.test.tsx / BBoxMapEditor.test.tsx
// pattern. Keeps the `map-container` testid the rest of this suite already
// waits on.
// ---------------------------------------------------------------------------

const baseMapSpy = vi.fn();

vi.mock('./map/BaseMap', () => ({
  BaseMap: (props: BaseMapProps) => {
    baseMapSpy(props);
    return <div data-testid="map-container">{props.children}</div>;
  },
}));

// ---------------------------------------------------------------------------
// TraceroutePathsLayer mock — spy on the exact props EmbedMap passes.
// ---------------------------------------------------------------------------

const tracerouteLayerSpy = vi.fn();

vi.mock('./map/layers/TraceroutePathsLayer', () => ({
  TraceroutePathsLayer: (props: TraceroutePathsLayerProps) => {
    tracerouteLayerSpy(props);
    return <div data-testid="traceroute-paths-layer" />;
  },
}));

// ---------------------------------------------------------------------------
// NeighborLinksLayer mock — spy on the exact descriptors EmbedMap emits.
// ---------------------------------------------------------------------------

const neighborLinksSpy = vi.fn();

vi.mock('./map/layers/NeighborLinksLayer', () => ({
  NeighborLinksLayer: (props: NeighborLinksLayerProps) => {
    neighborLinksSpy(props);
    return <div data-testid="neighbor-links-layer" />;
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface WireSegmentFixture {
  fromNum: number;
  toNum: number;
  fromLat: number;
  fromLng: number;
  fromName: string;
  toLat: number;
  toLng: number;
  toName: string;
  snr: number | null;
  timestamp: number;
  leg?: 'forward' | 'return';
  avgSnr?: number | null;
  isMqtt?: boolean;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    channels: [0],
    tileset: 'cartoDark',
    defaultLat: 40,
    defaultLng: -105,
    defaultZoom: 10,
    showTooltips: true,
    showPopups: true,
    showLegend: true,
    showPaths: true,
    showNeighborInfo: false,
    showMqttNodes: true,
    pollIntervalSeconds: 300,
    ...overrides,
  };
}

const forwardSegment: WireSegmentFixture = {
  fromNum: 111,
  toNum: 222,
  fromLat: 40.0,
  fromLng: -105.0,
  fromName: 'Alpha',
  toLat: 40.1,
  toLng: -105.1,
  toName: 'Bravo',
  snr: 6,
  timestamp: 1_700_000_000,
  leg: 'forward',
  avgSnr: 6,
  isMqtt: false,
};

const returnSegment: WireSegmentFixture = {
  fromNum: 222,
  toNum: 111,
  fromLat: 40.1,
  fromLng: -105.1,
  fromName: 'Bravo',
  toLat: 40.0,
  toLng: -105.0,
  toName: 'Alpha',
  snr: -8,
  timestamp: 1_700_000_100,
  leg: 'return',
  avgSnr: -8,
  isMqtt: false,
};

/** Pre-WP1 legacy wire shape — no leg/avgSnr/isMqtt at all. */
const legacyOnlySegment: WireSegmentFixture = {
  fromNum: 333,
  toNum: 444,
  fromLat: 41.0,
  fromLng: -106.0,
  fromName: 'Charlie',
  toLat: 41.1,
  toLng: -106.1,
  toName: 'Delta',
  snr: 3,
  timestamp: 1_700_000_200,
};

function mockFetchSequence(opts: {
  config?: Record<string, unknown>;
  nodes?: unknown[];
  neighborInfo?: unknown[];
  traceroutes?: WireSegmentFixture[];
  geojsonLayers?: unknown[];
}) {
  const {
    config = baseConfig(),
    nodes = [],
    neighborInfo = [],
    traceroutes = [],
    geojsonLayers = [],
  } = opts;

  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const respond = (body: unknown) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);

    if (url.endsWith('/config')) return respond(config);
    if (url.endsWith('/nodes')) return respond(nodes);
    if (url.endsWith('/neighborinfo')) return respond(neighborInfo);
    if (url.endsWith('/traceroutes')) return respond(traceroutes);
    if (url.endsWith('/geojson/layers')) return respond(geojsonLayers);
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'not found' }) } as Response);
  }) as unknown as typeof fetch;
}

async function renderEmbedMap() {
  render(<EmbedMap profileId="profile-1" />);
  await waitFor(() => {
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
  });
}

beforeEach(() => {
  tracerouteLayerSpy.mockClear();
  neighborLinksSpy.mockClear();
  baseMapSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbedMap traceroute rendering (#4047 P6 WP2)', () => {
  it('renders TraceroutePathsLayer with the flat consumer preset when showPaths is true', async () => {
    mockFetchSequence({ traceroutes: [forwardSegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;

    expect(props.colorMode).toBe('snr');
    expect(props.curvature).toBe(0);
    expect(props.weight).toBe(2);
    expect(props.opacity).toBe(0.85);
    expect(props.dashMode).toBe('mqtt-unknown');
    expect(props.showArrows).toBeFalsy();
    expect(props.mqttColor).toBe(getOverlayColors(getSchemeForTileset('cartoDark')).mqttSegment);
    expect(props.snrColors).toEqual(getOverlayColors(getSchemeForTileset('cartoDark')).snrColors);
  });

  it('does not render TraceroutePathsLayer when showPaths is false', async () => {
    mockFetchSequence({ config: baseConfig({ showPaths: false }), traceroutes: [forwardSegment] });
    await renderEmbedMap();

    // Give any stray async fetch/render a tick, then assert it never rendered.
    await new Promise((r) => setTimeout(r, 0));
    expect(tracerouteLayerSpy).not.toHaveBeenCalled();
  });

  it('maps a new-shape wire response (forward + return legs) onto render segments', async () => {
    mockFetchSequence({ traceroutes: [forwardSegment, returnSegment] });
    await renderEmbedMap();

    await waitFor(() => {
      const props = tracerouteLayerSpy.mock.calls.at(-1)?.[0] as TraceroutePathsLayerProps | undefined;
      expect(props?.segments.length).toBe(2);
    });
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;

    const forward = props.segments.find((s) => s.leg === 'forward');
    const back = props.segments.find((s) => s.leg === 'return');

    expect(forward).toBeDefined();
    expect(back).toBeDefined();
    expect(forward!.key).toBe('forward:111-222');
    expect(back!.key).toBe('return:222-111');
    expect(forward!.avgSnr).toBe(6);
    expect(back!.avgSnr).toBe(-8);
    expect(forward!.from).toEqual([40.0, -105.0]);
    expect(forward!.to).toEqual([40.1, -105.1]);
  });

  it('marks a segment MQTT via isMqtt and still renders (dashed, not dropped)', async () => {
    const mqttSegment: WireSegmentFixture = { ...forwardSegment, fromNum: 555, toNum: 666, leg: 'forward', avgSnr: null, isMqtt: true, snr: null };
    mockFetchSequence({ traceroutes: [mqttSegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;
    expect(props.segments).toHaveLength(1);
    expect(props.segments[0].isMqtt).toBe(true);
    expect(props.segments[0].avgSnr).toBeNull();
  });

  it('old-shape resilience: a wire segment lacking leg/avgSnr/isMqtt still yields a render segment', async () => {
    mockFetchSequence({ traceroutes: [legacyOnlySegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;
    expect(props.segments).toHaveLength(1);
    const seg = props.segments[0];
    // Defaults: leg -> 'forward', avgSnr falls back to the legacy `snr` field,
    // isMqtt -> false (old server never sent per-hop MQTT sentinels).
    expect(seg.leg).toBe('forward');
    expect(seg.avgSnr).toBe(legacyOnlySegment.snr);
    expect(seg.isMqtt).toBe(false);
    expect(seg.key).toBe('forward:333-444');
    expect(seg.from).toEqual([41.0, -106.0]);
    expect(seg.to).toEqual([41.1, -106.1]);
  });

  it('selects the dark palette for a dark tileset (cartoDark)', async () => {
    mockFetchSequence({ config: baseConfig({ tileset: 'cartoDark' }), traceroutes: [forwardSegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;
    expect(props.snrColors).toEqual(getOverlayColors('dark').snrColors);
  });

  it('selects the light palette for a light tileset (osmHot) — differs from dark', async () => {
    mockFetchSequence({ config: baseConfig({ tileset: 'osmHot' }), traceroutes: [forwardSegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;
    const lightColors = getOverlayColors('light').snrColors;
    const darkColors = getOverlayColors('dark').snrColors;
    expect(props.snrColors).toEqual(lightColors);
    expect(props.snrColors.excellent).not.toBe(darkColors.excellent);
  });

  it('passes a renderPopup callback when showPopups is true, and it preserves fromName/toName + scaled SNR', async () => {
    mockFetchSequence({ traceroutes: [forwardSegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;
    expect(typeof props.renderPopup).toBe('function');

    const seg = props.segments[0];
    const popup = props.renderPopup!(seg);
    render(<>{popup}</>);
    expect(screen.getByText(/Alpha ↔ Bravo/)).toBeInTheDocument();
    expect(screen.getByText('6.0 dB')).toBeInTheDocument();
  });

  it('omits renderPopup when showPopups is false', async () => {
    mockFetchSequence({ config: baseConfig({ showPopups: false }), traceroutes: [forwardSegment] });
    await renderEmbedMap();

    await waitFor(() => expect(tracerouteLayerSpy).toHaveBeenCalled());
    const props = tracerouteLayerSpy.mock.calls.at(-1)![0] as TraceroutePathsLayerProps;
    expect(props.renderPopup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BaseMap shell adoption (#4047 P7 §3.4)
// ---------------------------------------------------------------------------

describe('EmbedMap BaseMap shell adoption (#4047 P7 §3.4)', () => {
  it('passes the context-free shell props: tilesetId from config, no custom tilesets, zoom/attribution controls on', async () => {
    mockFetchSequence({ config: baseConfig({ tileset: 'esriSatellite', defaultLat: 12, defaultLng: 34, defaultZoom: 7 }) });
    await renderEmbedMap();

    await waitFor(() => expect(baseMapSpy).toHaveBeenCalled());
    const props = baseMapSpy.mock.calls.at(-1)![0] as BaseMapProps;
    expect(props.tilesetId).toBe('esriSatellite');
    expect(props.customTilesets).toEqual([]);
    expect(props.zoomControl).toBe(true);
    expect(props.attributionControl).toBe(true);
    expect(props.center).toEqual([12, 34]);
    expect(props.zoom).toBe(7);
    // Embed has no tileset switcher — showTilesetSelector left at its
    // BaseMap default (false/undefined), never explicitly enabled.
    expect(props.showTilesetSelector).toBeFalsy();
  });

  it('honors ?lat=&lon=&zoom= URL overrides in the center/zoom passed to BaseMap (issue #2668)', async () => {
    window.history.replaceState(null, '', '?lat=51.5&lon=-0.1&zoom=14');
    try {
      mockFetchSequence({ config: baseConfig({ defaultLat: 0, defaultLng: 0, defaultZoom: 3 }) });
      await renderEmbedMap();

      await waitFor(() => expect(baseMapSpy).toHaveBeenCalled());
      const props = baseMapSpy.mock.calls.at(-1)![0] as BaseMapProps;
      expect(props.center).toEqual([51.5, -0.1]);
      expect(props.zoom).toBe(14);
    } finally {
      window.history.replaceState(null, '', window.location.pathname);
    }
  });
});

// ---------------------------------------------------------------------------
// Neighbor-link adapter over the shared NeighborLinksLayer (#4047 P7 §4.1)
// ---------------------------------------------------------------------------

describe('EmbedMap neighbor-link adapter (#4047 P7 §4.1)', () => {
  const neighborSegmentFixture = {
    nodeNum: 111,
    neighborNodeNum: 222,
    snr: 4,
    nodeLatitude: 40.0,
    nodeLongitude: -105.0,
    nodeName: 'Alpha',
    neighborLatitude: 40.2,
    neighborLongitude: -105.2,
    neighborName: 'Bravo',
  };

  it('emits a descriptor reproducing the pre-migration amber/w3/o.7/dash "5, 5" look, with a popup when showPopups is true', async () => {
    mockFetchSequence({
      config: baseConfig({ showNeighborInfo: true, showPopups: true }),
      neighborInfo: [neighborSegmentFixture],
    });
    await renderEmbedMap();

    await waitFor(() => expect(neighborLinksSpy).toHaveBeenCalled());
    const props = neighborLinksSpy.mock.calls.at(-1)![0] as NeighborLinksLayerProps;
    expect(props.links).toHaveLength(1);
    const link = props.links[0];
    expect(link.positions).toEqual([[40.0, -105.0], [40.2, -105.2]]);
    expect(link.pathOptions).toEqual({ color: '#f5a623', weight: 3, opacity: 0.7, dashArray: '5, 5' });
    expect(link.arrows).toBeUndefined();
    expect(link.children).toBeDefined();

    render(<>{link.children}</>);
    expect(screen.getByText(/Alpha ↔ Bravo/)).toBeInTheDocument();
    expect(screen.getByText('4 dB')).toBeInTheDocument();
  });

  it('omits the popup children when showPopups is false', async () => {
    mockFetchSequence({
      config: baseConfig({ showNeighborInfo: true, showPopups: false }),
      neighborInfo: [neighborSegmentFixture],
    });
    await renderEmbedMap();

    await waitFor(() => expect(neighborLinksSpy).toHaveBeenCalled());
    const props = neighborLinksSpy.mock.calls.at(-1)![0] as NeighborLinksLayerProps;
    expect(props.links[0].children).toBeUndefined();
  });

  it('does not render NeighborLinksLayer at all when showNeighborInfo is false', async () => {
    mockFetchSequence({
      config: baseConfig({ showNeighborInfo: false }),
      neighborInfo: [neighborSegmentFixture],
    });
    await renderEmbedMap();

    // Give any stray async fetch/render a tick, then assert it never rendered.
    await new Promise((r) => setTimeout(r, 0));
    expect(neighborLinksSpy).not.toHaveBeenCalled();
  });
});
