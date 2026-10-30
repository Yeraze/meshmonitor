/**
 * @vitest-environment jsdom
 *
 * GeoJsonOverlay — per-overlay click-popup opt-out (issue #4344).
 *
 * The point of these tests: when a layer sets `disablePopup`, the feature must
 * NOT get a click popup bound, while the hover tooltip binding stays exactly as
 * it was. (The tooltip is deliberately out of scope here — issue #4342 tracks
 * the separate tooltip/Waypoint interaction bug.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';
import GeoJsonOverlay from './GeoJsonOverlay';

/** Stub leaflet layer handed to `onEachFeature`. */
interface LayerStub {
  bindPopup: ReturnType<typeof vi.fn>;
  bindTooltip: ReturnType<typeof vi.fn>;
}
type OnEachFeature = (
  feature: { properties: Record<string, unknown> },
  leafletLayer: LayerStub
) => void;

// `vi.mock` factories are hoisted above the imports, so anything they close over
// must come from `vi.hoisted` — a plain module-level const is still in its
// temporal dead zone when the factory runs.
const mocks = vi.hoisted(() => ({
  // Captures the props react-leaflet's <GeoJSON> would have received, so a test
  // can drive `onEachFeature` directly with a stub leaflet layer.
  capturedGeoJsonProps: [] as Array<{ onEachFeature: unknown }>,
  featureCollection: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
        properties: { name: 'Sector 7', note: 'restricted' },
      },
    ],
  },
}));

vi.mock('react-leaflet', () => ({
  GeoJSON: (props: { onEachFeature: unknown }) => {
    mocks.capturedGeoJsonProps.push(props);
    return <div data-testid="geojson-layer" />;
  },
}));

vi.mock('leaflet', () => ({
  default: { circleMarker: vi.fn() },
}));

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue(mocks.featureCollection),
    getBaseUrl: vi.fn().mockResolvedValue(''),
  },
}));

function makeLayer(overrides: Partial<GeoJsonLayer> = {}): GeoJsonLayer {
  return {
    id: 'layer-1',
    name: 'Test Layer',
    filename: 'layer-1.geojson',
    visible: true,
    publiclyVisible: false,
    disablePopup: false,
    style: { color: '#e74c3c', opacity: 0.7, weight: 2, fillOpacity: 0.3 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Renders the overlay and runs its `onEachFeature` against a stub leaflet layer. */
async function bindFirstFeature(
  layer: GeoJsonLayer,
  properties: Record<string, unknown> = { name: 'Sector 7', note: 'restricted' }
): Promise<LayerStub> {
  render(<GeoJsonOverlay layers={[layer]} />);
  await waitFor(() => expect(mocks.capturedGeoJsonProps.length).toBeGreaterThan(0));

  const stub: LayerStub = { bindPopup: vi.fn(), bindTooltip: vi.fn() };
  const last = mocks.capturedGeoJsonProps[mocks.capturedGeoJsonProps.length - 1];
  (last.onEachFeature as OnEachFeature)(
    { properties },
    stub
  );
  return stub;
}

describe('GeoJsonOverlay — disablePopup (#4344)', () => {
  beforeEach(() => {
    mocks.capturedGeoJsonProps.length = 0;
  });

  it('binds both popup and tooltip by default', async () => {
    const stub = await bindFirstFeature(makeLayer());

    expect(stub.bindPopup).toHaveBeenCalledTimes(1);
    expect(String(stub.bindPopup.mock.calls[0][0])).toContain('Sector 7');
    expect(stub.bindTooltip).toHaveBeenCalledTimes(1);
  });

  it('does not bind the click popup when disablePopup is set', async () => {
    const stub = await bindFirstFeature(makeLayer({ disablePopup: true }));

    expect(stub.bindPopup).not.toHaveBeenCalled();
  });

  it('still binds the hover tooltip when disablePopup is set', async () => {
    const stub = await bindFirstFeature(makeLayer({ disablePopup: true }));

    expect(stub.bindTooltip).toHaveBeenCalledTimes(1);
    expect(stub.bindTooltip).toHaveBeenCalledWith('Sector 7', {
      permanent: false,
      sticky: true,
    });
  });

  it('treats a legacy layer without the field as popup-enabled', async () => {
    const legacy = makeLayer();
    delete (legacy as Partial<GeoJsonLayer>).disablePopup;

    const stub = await bindFirstFeature(legacy);

    expect(stub.bindPopup).toHaveBeenCalledTimes(1);
    expect(stub.bindTooltip).toHaveBeenCalledTimes(1);
  });
});

describe('GeoJsonOverlay — stored XSS escaping (#6065 / #6066)', () => {
  const IMG_PAYLOAD =
    '<img src=x onerror="document.title=\'XSS\'">';

  beforeEach(() => {
    mocks.capturedGeoJsonProps.length = 0;
  });

  it('escapes a popup property value so injected markup is inert (#6065)', async () => {
    const stub = await bindFirstFeature(makeLayer(), {
      name: 'Null Island',
      info: IMG_PAYLOAD,
    });

    const popupHtml = String(stub.bindPopup.mock.calls[0][0]);
    // The raw executable tag must NOT survive into the innerHTML string.
    expect(popupHtml).not.toContain('<img');
    expect(popupHtml).not.toContain('onerror="');
    // It is present only in escaped, inert form.
    expect(popupHtml).toContain('&lt;img');
    expect(popupHtml).toContain('&quot;');
  });

  it('escapes a popup property KEY as well as the value (#6065)', async () => {
    const stub = await bindFirstFeature(makeLayer(), {
      // malicious key, benign-looking value
      '<img src=x onerror=alert(1)>': 'ok',
      name: 'Null Island',
    });

    const popupHtml = String(stub.bindPopup.mock.calls[0][0]);
    expect(popupHtml).not.toContain('<img');
    expect(popupHtml).toContain('&lt;img');
  });

  it('escapes the tooltip label so injected markup is inert (#6066)', async () => {
    const stub = await bindFirstFeature(makeLayer(), {
      name: IMG_PAYLOAD,
    });

    const tooltipLabel = String(stub.bindTooltip.mock.calls[0][0]);
    expect(tooltipLabel).not.toContain('<img');
    expect(tooltipLabel).not.toContain('onerror="');
    expect(tooltipLabel).toContain('&lt;img');
  });
});
