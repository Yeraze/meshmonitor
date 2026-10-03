import { describe, it, expect } from 'vitest';
import { crossSourceLinksTo3DLines } from './useCrossSourceLinks';
import type { CrossSourceLinkDto } from '../types/crossSourceLinks';

const NOW = 1_000_000_000;
const link = (o: Partial<CrossSourceLinkDto> = {}): CrossSourceLinkDto => ({
  key: 'k', protocol: 'meshtastic', kind: 'origin', inferred: false, transportClass: 'rf',
  txSourceId: 'a', txSourceName: 'A', txNodeId: '!a', txName: null,
  rxSourceId: 'b', rxSourceName: 'B', rxNodeId: '!b', rxName: null,
  count: 1, snrMin: null, snrAvg: null, snrMax: null, rssiAvg: null, lastHeardAt: NOW,
  from: [1, 2], to: [3, 4],
  ...o,
});

describe('crossSourceLinksTo3DLines (#5561)', () => {
  it('maps edges to 3D lines with tx -> rx direction and prefixed keys', () => {
    const [line] = crossSourceLinksTo3DLines([link()], NOW, 3_600_000);
    expect(line).toMatchObject({ key: 'xs:k', from: [1, 2], to: [3, 4], width: 2 });
    expect(line.dash).toBeUndefined();
  });

  it('relay and gateway edges carry dash patterns', () => {
    const [relay, gw] = crossSourceLinksTo3DLines(
      [link({ key: 'r', kind: 'relay', inferred: true }), link({ key: 'g', transportClass: 'mqtt_gateway' })],
      NOW, 3_600_000,
    );
    expect(relay.dash).toEqual([0.6, 2]);
    expect(gw.dash).toEqual([3, 2]);
  });
});
