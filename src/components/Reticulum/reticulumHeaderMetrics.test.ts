/**
 * Unit tests for `reticulumHeaderMetrics` (issue #6120) — the source-header
 * gauge derivation: FIRST Up RNode interface, and nothing when none report.
 */
import { describe, it, expect } from 'vitest';
import { reticulumHeaderMetrics } from './reticulumHeaderMetrics';
import type { ReticulumInterfaceRow } from '../../types/reticulum';

function makeIface(overrides: Partial<ReticulumInterfaceRow> = {}): ReticulumInterfaceRow {
  return {
    sourceId: 'src-1',
    interfaceName: 'iface',
    interfaceType: 'TCPClientInterface',
    interfaceHash: null,
    mode: 'full',
    status: 'up',
    online: true,
    bitrate: null,
    txBytes: 0,
    rxBytes: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    frequency: null,
    bandwidth: null,
    spreadingFactor: null,
    codingRate: null,
    txPower: null,
    stAlock: null,
    ltAlock: null,
    radioState: null,
    deviceInfoJson: null,
    airtimeShort: null,
    airtimeLong: null,
    channelLoadShort: null,
    channelLoadLong: null,
    noiseFloor: null,
    interference: null,
    interferenceLastTs: null,
    interferenceLastDbm: null,
    cpuLoad: null,
    batteryState: null,
    batteryPercent: null,
    ...overrides,
  };
}

describe('reticulumHeaderMetrics', () => {
  it('returns undefined for an empty interface list (header hides values)', () => {
    expect(reticulumHeaderMetrics([])).toBeUndefined();
  });

  it('returns undefined when the only RNode interface is down', () => {
    const iface = makeIface({
      interfaceType: 'RNodeInterface',
      online: false,
      batteryPercent: 100,
      airtimeLong: 0.12,
    });
    expect(reticulumHeaderMetrics([iface])).toBeUndefined();
  });

  it('returns undefined when no RNode interface reports any gauge', () => {
    const rnode = makeIface({ interfaceType: 'RNodeInterface', online: true });
    expect(reticulumHeaderMetrics([rnode])).toBeUndefined();
  });

  it('ignores non-RNode interfaces even when they are up', () => {
    const auto = makeIface({ interfaceType: 'AutoInterface', online: true, batteryPercent: 50 });
    expect(reticulumHeaderMetrics([auto])).toBeUndefined();
  });

  it('maps the first Up RNode interface onto battery / channel / air (prefers 1h window)', () => {
    const rnode = makeIface({
      interfaceName: 'RNode LoRa Interface',
      interfaceType: 'RNodeInterface',
      online: true,
      batteryPercent: 100,
      channelLoadShort: 2.44,
      channelLoadLong: 1.15,
      airtimeShort: 0,
      airtimeLong: 0.12,
    });
    expect(reticulumHeaderMetrics([rnode])).toEqual({
      batteryLevel: 100,
      channelUtilization: 1.15,
      airUtilTx: 0.12,
    });
  });

  it('falls back to the 15s window when the 1h window is absent', () => {
    const rnode = makeIface({
      interfaceType: 'RNodeInterface',
      online: true,
      channelLoadShort: 2.44,
      airtimeShort: 0.5,
    });
    expect(reticulumHeaderMetrics([rnode])).toEqual({
      channelUtilization: 2.44,
      airUtilTx: 0.5,
    });
  });

  it('picks the FIRST Up RNode interface when several are present', () => {
    const first = makeIface({ interfaceName: 'rnode-1', interfaceType: 'RNodeInterface', online: true, batteryPercent: 80 });
    const second = makeIface({ interfaceName: 'rnode-2', interfaceType: 'RNodeInterface', online: true, batteryPercent: 20 });
    expect(reticulumHeaderMetrics([first, second])?.batteryLevel).toBe(80);
  });
});
