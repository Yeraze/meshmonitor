/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import * as L from 'leaflet';
import { HeatLayer } from 'leaflet.heat';

// Guards the real package shape the layer relies on (#6296): leaflet.heat 1.x
// exports a HeatLayer class built on our Leaflet, not an L.heatLayer factory.
describe('leaflet.heat module', () => {
  it('exports a HeatLayer class that is a Leaflet layer', () => {
    const layer = new HeatLayer([[30, -90, 5]], { radius: 35, blur: 25, maxZoom: 17, minOpacity: 0.4 });
    expect(layer).toBeInstanceOf(L.Layer);
    expect(typeof layer.addTo).toBe('function');
  });
});
