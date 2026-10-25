/**
 * #4835 wiring guard: the live packet traffic toggle and rate slider sit in
 * BOTH Map Features panels (NodesTab and DashboardMap) and on the MeshCore
 * map, and each map mounts the layer only while the toggle is on (mounting is
 * what subscribes the socket). Same source-level approach as
 * ducting.wiring.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MAPS = ['src/components/NodesTab.tsx', 'src/components/Dashboard/DashboardMap.tsx', 'src/components/MeshCore/MeshCoreMap.tsx'];
const CONTEXT_MAPS = ['src/components/NodesTab.tsx', 'src/components/Dashboard/DashboardMap.tsx'];
const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('live packet traffic wiring (#4835)', () => {
  it.each(CONTEXT_MAPS)('%s reads the toggle and the rate from MapContext', (rel) => {
    const src = read(rel);
    const destructure = src.slice(src.indexOf('useMapContext()') - 2000, src.indexOf('useMapContext()'));
    for (const name of ['showPacketFlights', 'setShowPacketFlights', 'packetFlightRate', 'setPacketFlightRate']) {
      expect(destructure).toContain(name);
    }
  });

  it.each(MAPS)('%s renders the shared control in its Map Features panel', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/<PacketFlightsControl\s[^>]*onCheckedChange=\{setShowPacketFlights\}/);
    expect(src).toMatch(/<PacketFlightsControl\s[^>]*onRateChange=\{setPacketFlightRate\}/);
    expect(src).toMatch(/<PacketFlightsControl\s[^>]*dropped=\{packetFlightsDropped\}/);
  });

  it.each(MAPS)('%s mounts the layer only while the toggle is on', (rel) => {
    expect(read(rel)).toMatch(/\{showPacketFlights && [^(]*\(\s*<PacketFlightsLayer\s/);
  });

  it('MapContext persists the toggle (default off) and the rate (default all)', () => {
    const src = read('src/contexts/MapContext.tsx');
    expect(src).toContain("localStorage.getItem('showPacketFlights') === 'true'");
    expect(src).toContain("localStorage.getItem('packetFlightRate')");
  });

  it('the locale file has the toggle label', () => {
    const en = JSON.parse(read('public/locales/en.json'));
    expect(en['map.packet_flights.toggle']).toBe('Live packet traffic');
  });
});
