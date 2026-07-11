/**
 * @vitest-environment jsdom
 *
 * EmbedMap traceroute rendering (#4047 P6 WP2). The embed bundle has no
 * SettingsProvider, so this suite pins the palette-from-tileset contract
 * (§3.1), the wire→TracerouteRenderSegment mapping including old-shape
 * (pre-WP1) resilience (§3.2), and that the popup capability survives the
 * fixed-mauve→shared-layer swap (§3.3). `TraceroutePathsLayer` is mocked so
 * assertions target the exact props EmbedMap computes and passes to it,
 * rather than re-deriving colors/geometry through the real layer (that
 * layer's own behavior is covered by TraceroutePathsLayer.test.tsx).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { EmbedMap } from './EmbedMap';
import type { TraceroutePathsLayerProps } from './map/layers/TraceroutePathsLayer';
import { getOverlayColors, getSchemeForTileset } from '../config/overlayColors';

// ---------------------------------------------------------------------------
// react-leaflet mock (mirrors TraceroutePathsLayer.test.tsx / NodeMarkersLayer.test.tsx)
// ---------------------------------------------------------------------------

interface MockChildProps {
  children?: ReactNode;
}

vi.mock('react-leaflet', () => ({
  MapContainer: (props: MockChildProps) => <div data-testid="map-container">{props.children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: (props: MockChildProps) => <div data-testid="marker">{props.children}</div>,
  Tooltip: (props: MockChildProps) => <div data-testid="tooltip">{props.children}</div>,
  Popup: (props: MockChildProps) => <div data-testid="popup">{props.children}</div>,
  Polyline: (props: MockChildProps) => <div data-testid="polyline">{props.children}</div>,
  GeoJSON: () => <div data-testid="geojson" />,
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
