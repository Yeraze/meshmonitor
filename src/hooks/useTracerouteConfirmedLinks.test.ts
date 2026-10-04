import { describe, it, expect } from 'vitest';
import { tracerouteConfirmedLinksTo3DLines } from './useTracerouteConfirmedLinks';
import type { TracerouteConfirmedLinkDto } from '../types/crossSourceLinks';
import { TRACEROUTE_CONFIRMED_LINK_COLORS } from '../utils/crossSourceLinkStyle';

const NOW = 1_000_000_000;
const link = (o: Partial<TracerouteConfirmedLinkDto> = {}): TracerouteConfirmedLinkDto => ({
  key: 'k', sourceId: 'a', sourceName: 'A',
  localNodeNum: 1, localNodeId: '!00000001', localName: null,
  neighborNodeNum: 2, neighborNodeId: '!00000002', neighborName: null,
  transportClass: 'rf', count: 1, directCount: 1, snrOutAvg: null, snrBackAvg: null,
  lastConfirmedAt: NOW, from: [1, 2], to: [3, 4],
  ...o,
});

describe('tracerouteConfirmedLinksTo3DLines (#5580)', () => {
  it('maps links to dash-dot 3D lines with their own key prefix', () => {
    const [line] = tracerouteConfirmedLinksTo3DLines([link()], NOW, 3_600_000);
    expect(line).toMatchObject({
      key: 'trc:k', from: [1, 2], to: [3, 4], width: 2.5, color: TRACEROUTE_CONFIRMED_LINK_COLORS.rf,
    });
    expect(line.dash).toEqual([4, 1.5, 0.6, 1.5]);
  });

  it('colours by transport class', () => {
    const [mqtt, udp] = tracerouteConfirmedLinksTo3DLines(
      [link({ key: 'm', transportClass: 'mqtt' }), link({ key: 'u', transportClass: 'udp' })], NOW, 3_600_000,
    );
    expect(mqtt.color).toBe(TRACEROUTE_CONFIRMED_LINK_COLORS.mqtt);
    expect(udp.color).toBe(TRACEROUTE_CONFIRMED_LINK_COLORS.udp);
  });
});
