import { describe, it, expect } from 'vitest';
import { getHardwareModelName } from './hardwareModel';

describe('getHardwareModelName — protobufs v2.7.26 models', () => {
  it('resolves the newly-added hardware models (132–140)', () => {
    expect(getHardwareModelName(132)).toBe('HELTEC_V4_R8');
    expect(getHardwareModelName(133)).toBe('HELTEC_MESH_NODE_T1');
    expect(getHardwareModelName(134)).toBe('STATION_G3');
    expect(getHardwareModelName(137)).toBe('SEEED_WIO_TRACKER_L2');
    expect(getHardwareModelName(139)).toBe('HELTEC_MESH_TOWER_V2');
    expect(getHardwareModelName(140)).toBe('MESHNOLOGY_W10');
  });

  it('still falls back for unknown ids and handles undefined', () => {
    expect(getHardwareModelName(200)).toBe('Unknown (200)');
    expect(getHardwareModelName(undefined)).toBe('N/A');
  });
});
