import { describe, it, expect } from 'vitest';
import { getHardwareModelName } from './hardwareModel';

describe('getHardwareModelName — protobufs v2.7.26 models', () => {
  it('resolves the newly-added hardware models (132–140)', () => {
    expect(getHardwareModelName(132)).toBe('HELTEC_V4_R8');
    expect(getHardwareModelName(133)).toBe('HELTEC_MESH_NODE_T1');
    expect(getHardwareModelName(134)).toBe('STATION_G3');
    expect(getHardwareModelName(135)).toBe('T_IMPULSE_PLUS');
    expect(getHardwareModelName(136)).toBe('T_ECHO_CARD');
    expect(getHardwareModelName(137)).toBe('SEEED_WIO_TRACKER_L2');
    expect(getHardwareModelName(138)).toBe('CROWPANEL_P4');
    expect(getHardwareModelName(139)).toBe('HELTEC_MESH_TOWER_V2');
    expect(getHardwareModelName(140)).toBe('MESHNOLOGY_W10');
  });

  it('maps 128 to MESH_TRACKER_X1 (upstream renamed from TRACKER_T1000_E_PRO, firmware#10854)', () => {
    // Value 128 was renumbered in place: TRACKER_T1000_E_PRO -> MESH_TRACKER_X1.
    expect(getHardwareModelName(128)).toBe('MESH_TRACKER_X1');
  });

  it('still falls back for unknown ids and handles undefined', () => {
    expect(getHardwareModelName(200)).toBe('Unknown (200)');
    expect(getHardwareModelName(undefined)).toBe('N/A');
  });
});
