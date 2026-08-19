import { describe, it, expect } from 'vitest';
import {
  buildMeshBeaconConfigPayload,
  parseMeshBeaconConfig,
  MESH_BEACON_MIN_INTERVAL_SECS,
  type MeshBeaconConfigState,
} from './useAdminCommandsState';

/**
 * The MeshBeacon payload/parse helpers centralise the wire omit-logic (issue
 * #4802) so both the local config and remote-admin surfaces round-trip the same
 * way. These assert the proto-driven edge cases: `optional` presets vs 0,
 * whole-submessage channels vs blank names, UNSET(0) regions surviving, and the
 * repeated broadcast_targets normalisation.
 */
const baseState: MeshBeaconConfigState = {
  listenEnabled: false,
  broadcastEnabled: true,
  legacySplit: false,
  broadcastMessage: 'hi',
  broadcastSendAsNode: 0,
  broadcastOfferChannelName: '',
  broadcastOfferChannelPsk: '',
  broadcastOfferRegion: 0,
  broadcastOfferPreset: null,
  broadcastIntervalSecs: MESH_BEACON_MIN_INTERVAL_SECS,
  broadcastOnChannelName: '',
  broadcastOnChannelPsk: '',
  broadcastOnRegion: 0,
  broadcastOnPreset: null,
  broadcastTargets: [],
};

describe('buildMeshBeaconConfigPayload', () => {
  it('always includes interval and both regions (0 is a real value)', () => {
    const payload = buildMeshBeaconConfigPayload(baseState);
    expect(payload.broadcastIntervalSecs).toBe(3600);
    expect(payload.broadcastOfferRegion).toBe(0);
    expect(payload.broadcastOnRegion).toBe(0);
  });

  it('omits optional presets when null, includes them when 0 (LONG_FAST)', () => {
    expect(buildMeshBeaconConfigPayload(baseState)).not.toHaveProperty('broadcastOnPreset');
    expect(buildMeshBeaconConfigPayload(baseState)).not.toHaveProperty('broadcastOfferPreset');

    const withPresets = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastOnPreset: 0,
      broadcastOfferPreset: 0,
    });
    expect(withPresets.broadcastOnPreset).toBe(0);
    expect(withPresets.broadcastOfferPreset).toBe(0);
  });

  it('omits broadcast_on_channel when name blank, sends name+psk when present', () => {
    expect(buildMeshBeaconConfigPayload(baseState)).not.toHaveProperty('broadcastOnChannel');

    const withChannel = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastOnChannelName: 'gauntlet',
      broadcastOnChannelPsk: 'AQ==',
    });
    expect(withChannel.broadcastOnChannel).toEqual({ name: 'gauntlet', psk: 'AQ==' });
  });

  it('sends broadcast_on_channel name without psk when psk blank', () => {
    const withChannel = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastOnChannelName: 'gauntlet',
      broadcastOnChannelPsk: '',
    });
    expect(withChannel.broadcastOnChannel).toEqual({ name: 'gauntlet' });
  });

  it('always emits broadcast_targets (empty array clears the device list)', () => {
    expect(buildMeshBeaconConfigPayload(baseState).broadcastTargets).toEqual([]);
  });

  it('normalises targets: drops null preset/channelIndex, keeps region', () => {
    const payload = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastTargets: [
        { preset: 6, region: 1, channelIndex: 2 },
        { preset: null, region: 0, channelIndex: null },
        { preset: 0, region: 3, channelIndex: null },
      ],
    });
    expect(payload.broadcastTargets).toEqual([
      { region: 1, preset: 6, channelIndex: 2 },
      { region: 0 },
      { region: 3, preset: 0 },
    ]);
  });
});

describe('parseMeshBeaconConfig', () => {
  it('returns empty object for missing config', () => {
    expect(parseMeshBeaconConfig(null)).toEqual({});
    expect(parseMeshBeaconConfig(undefined)).toEqual({});
  });

  it('defaults an absent interval to the firmware minimum, not 0', () => {
    expect(parseMeshBeaconConfig({}).broadcastIntervalSecs).toBe(3600);
    expect(parseMeshBeaconConfig({ broadcastIntervalSecs: 7200 }).broadcastIntervalSecs).toBe(7200);
  });

  it('keeps a real UNSET(0) region and null optional preset', () => {
    const parsed = parseMeshBeaconConfig({ broadcastOnRegion: 0 });
    expect(parsed.broadcastOnRegion).toBe(0);
    expect(parsed.broadcastOnPreset).toBeNull();
  });

  it('distinguishes preset 0 (present) from absent (null)', () => {
    expect(parseMeshBeaconConfig({ broadcastOnPreset: 0 }).broadcastOnPreset).toBe(0);
    expect(parseMeshBeaconConfig({}).broadcastOnPreset).toBeNull();
  });

  it('maps repeated targets, filling nulls for absent optional fields', () => {
    const parsed = parseMeshBeaconConfig({
      broadcastTargets: [
        { preset: 6, region: 1, channelIndex: 2 },
        { region: 3 },
      ],
    });
    expect(parsed.broadcastTargets).toEqual([
      { preset: 6, region: 1, channelIndex: 2 },
      { preset: null, region: 3, channelIndex: null },
    ]);
  });

  it('round-trips build → parse for a populated state', () => {
    const populated: MeshBeaconConfigState = {
      ...baseState,
      broadcastOnChannelName: 'gauntlet',
      broadcastOnChannelPsk: 'AQ==',
      broadcastOnRegion: 1,
      broadcastOnPreset: 6,
      broadcastIntervalSecs: 7200,
      broadcastTargets: [{ preset: 6, region: 1, channelIndex: 2 }],
    };
    const parsed = parseMeshBeaconConfig(buildMeshBeaconConfigPayload(populated));
    expect(parsed.broadcastOnChannelName).toBe('gauntlet');
    expect(parsed.broadcastOnChannelPsk).toBe('AQ==');
    expect(parsed.broadcastOnRegion).toBe(1);
    expect(parsed.broadcastOnPreset).toBe(6);
    expect(parsed.broadcastIntervalSecs).toBe(7200);
    expect(parsed.broadcastTargets).toEqual([{ preset: 6, region: 1, channelIndex: 2 }]);
  });
});
