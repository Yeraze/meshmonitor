/**
 * Tests for `mapDbNodeToDeviceInfo` (the MQTT-bridge / /api/poll copy in
 * `dbNodeMapper.ts` — kept in lock-step with the twin in
 * `nodeDbMaintenanceService.ts`, which has the fuller pre-existing test
 * suite). Focused here on the likely-aircraft classification fields
 * (#5364/#5365 Phase 1 WP1).
 */
import { describe, it, expect } from 'vitest';
import { mapDbNodeToDeviceInfo } from './dbNodeMapper.js';

describe('mapDbNodeToDeviceInfo (dbNodeMapper.ts)', () => {
  it('maps the likely-aircraft classification fields (SQLite 1 -> true)', () => {
    const node = {
      nodeNum: 1,
      nodeId: '!00000001',
      longName: '',
      shortName: '',
      likelyAircraft: 1,
      aircraftBasis: 'agl',
      groundElevation: 200,
      heightAboveGround: 3000,
    };
    const result: any = mapDbNodeToDeviceInfo(node);
    expect(result.likelyAircraft).toBe(true);
    expect(result.aircraftBasis).toBe('agl');
    expect(result.groundElevation).toBe(200);
    expect(result.heightAboveGround).toBe(3000);
  });

  it('maps likelyAircraft=0 to false, not omitted', () => {
    const node = { nodeNum: 1, nodeId: '!00000001', longName: '', shortName: '', likelyAircraft: 0, aircraftBasis: 'msl' };
    const result: any = mapDbNodeToDeviceInfo(node);
    expect(result.likelyAircraft).toBe(false);
    expect(result.aircraftBasis).toBe('msl');
  });

  it('omits the aircraft fields the row does not carry (never classified)', () => {
    const node = { nodeNum: 1, nodeId: '!00000001', longName: '', shortName: '' };
    const result: any = mapDbNodeToDeviceInfo(node);
    expect(result.likelyAircraft).toBeUndefined();
    expect(result.aircraftBasis).toBeUndefined();
    expect(result.groundElevation).toBeUndefined();
    expect(result.heightAboveGround).toBeUndefined();
  });

  it('maps core user/device fields (sanity check against the sibling mapper)', () => {
    const node = {
      nodeNum: 42,
      nodeId: '!0000002a',
      longName: 'Alpha',
      shortName: 'A1',
      hwModel: 9,
      batteryLevel: 87,
      lastHeard: 1000,
    };
    const result: any = mapDbNodeToDeviceInfo(node);
    expect(result.user?.longName).toBe('Alpha');
    expect(result.deviceMetrics?.batteryLevel).toBe(87);
    expect(result.lastHeard).toBe(1000);
  });
});
