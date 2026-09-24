import { describe, it, expect } from 'vitest';
import { DEVICE_COUNTER_TYPES, isDeviceCounterType } from './deviceCounters';

describe('deviceCounters (#5101 P3 WP2)', () => {
  it('includes every firmware LocalStats traffic counter', () => {
    const expected = [
      'numOnlineNodes',
      'numTotalNodes',
      'numPacketsTx',
      'numPacketsRx',
      'numPacketsRxBad',
      'numRxDupe',
      'numTxRelay',
      'numTxRelayCanceled',
      'numTxDropped',
    ];
    expect(DEVICE_COUNTER_TYPES.size).toBe(expected.length);
    for (const type of expected) {
      expect(isDeviceCounterType(type)).toBe(true);
    }
  });

  it('excludes heap, noise floor and uptime, which are device metrics but not traffic counters', () => {
    for (const type of ['heapTotalBytes', 'heapFreeBytes', 'noiseFloor', 'uptimeSeconds', 'hostUptimeSeconds']) {
      expect(isDeviceCounterType(type)).toBe(false);
    }
  });

  it('excludes MeshMonitor-computed transport series types', () => {
    for (const type of [
      'systemNodesHeardRf',
      'systemNodesHeardUdp',
      'systemNodesHeardMqtt',
      'systemPacketsRxRf',
      'systemPacketsRxUdp',
      'systemPacketsRxMqtt',
      'transportNodesHeard',
      'transportPacketsRx',
      'systemNodeCount',
    ]) {
      expect(isDeviceCounterType(type)).toBe(false);
    }
  });

  it('excludes unrelated telemetry types and the empty string', () => {
    expect(isDeviceCounterType('batteryLevel')).toBe(false);
    expect(isDeviceCounterType('')).toBe(false);
  });
});
