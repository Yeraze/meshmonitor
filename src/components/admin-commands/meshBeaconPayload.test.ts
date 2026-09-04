import { describe, it, expect } from 'vitest';
import {
  buildMeshBeaconConfigPayload,
  parseMeshBeaconConfig,
  MESH_BEACON_MIN_INTERVAL_SECS,
  MESH_BEACON_MAX_TARGETS,
  MESH_BEACON_MESSAGE_MAX_BYTES,
  type MeshBeaconConfigState,
} from './useAdminCommandsState';

/**
 * The MeshBeacon payload/parse helpers centralise the wire omit-logic (issue
 * #4802) so both the local config and remote-admin surfaces round-trip the same
 * way. These assert the proto-driven edge cases: `optional` presets vs 0,
 * whole-submessage channels vs blank names, UNSET(0) regions surviving, and the
 * repeated broadcast_targets normalisation.
 *
 * The single-destination fields (`broadcast_on_channel` / `_region` / `_preset`,
 * tags 8/9/10) and `broadcast_send_as_node` (tag 3) were deleted from the proto
 * and their tags reserved (protobufs #1048 / firmware #11646). The payload must
 * no longer contain them — a reserved tag is skipped by nanopb without an error,
 * so the only way to catch a regression is to assert their absence (#5062).
 */
const baseState: MeshBeaconConfigState = {
  listenEnabled: false,
  broadcastEnabled: true,
  legacySplit: false,
  broadcastMessage: 'hi',
  broadcastOfferChannelName: '',
  broadcastOfferChannelPsk: '',
  broadcastOfferRegion: 0,
  broadcastOfferPreset: null,
  broadcastIntervalSecs: MESH_BEACON_MIN_INTERVAL_SECS,
  broadcastTargets: [],
};

describe('buildMeshBeaconConfigPayload', () => {
  it('always includes interval and the offer region (0 is a real value)', () => {
    const payload = buildMeshBeaconConfigPayload(baseState);
    expect(payload.broadcastIntervalSecs).toBe(3600);
    expect(payload.broadcastOfferRegion).toBe(0);
  });

  it('never emits the removed reserved fields', () => {
    const payload = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastOfferPreset: 3,
      broadcastTargets: [{ preset: 3, region: 1, channelIndex: 1 }],
    });
    expect(payload).not.toHaveProperty('broadcastSendAsNode');
    expect(payload).not.toHaveProperty('broadcastOnChannel');
    expect(payload).not.toHaveProperty('broadcastOnRegion');
    expect(payload).not.toHaveProperty('broadcastOnPreset');
  });

  it('omits the optional offer preset when null, includes it when 0 (LONG_FAST)', () => {
    expect(buildMeshBeaconConfigPayload(baseState)).not.toHaveProperty('broadcastOfferPreset');

    const withPreset = buildMeshBeaconConfigPayload({ ...baseState, broadcastOfferPreset: 0 });
    expect(withPreset.broadcastOfferPreset).toBe(0);
  });

  it('omits broadcast_offer_channel when name blank, sends name+psk when present', () => {
    expect(buildMeshBeaconConfigPayload(baseState)).not.toHaveProperty('broadcastOfferChannel');

    const withChannel = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastOfferChannelName: 'gauntlet',
      broadcastOfferChannelPsk: 'AQ==',
    });
    expect(withChannel.broadcastOfferChannel).toEqual({ name: 'gauntlet', psk: 'AQ==' });
  });

  it('sends broadcast_offer_channel name without psk when psk blank', () => {
    const withChannel = buildMeshBeaconConfigPayload({
      ...baseState,
      broadcastOfferChannelName: 'gauntlet',
      broadcastOfferChannelPsk: '',
    });
    expect(withChannel.broadcastOfferChannel).toEqual({ name: 'gauntlet' });
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

  it('carries a full four-target list — the nanopb max_count — unchanged', () => {
    const targets = Array.from({ length: MESH_BEACON_MAX_TARGETS }, (_, i) => ({
      preset: i,
      region: 1,
      channelIndex: i,
    }));
    const payload = buildMeshBeaconConfigPayload({ ...baseState, broadcastTargets: targets });
    expect(payload.broadcastTargets).toHaveLength(MESH_BEACON_MAX_TARGETS);
  });
});

describe('MeshBeacon nanopb limits', () => {
  it('exposes the two limits that fail silently on the device', () => {
    // nanopb: broadcast_targets max_count:4, broadcast_message max_size:101
    // (100 bytes + NUL). Both drop the whole ModuleConfig when exceeded.
    expect(MESH_BEACON_MAX_TARGETS).toBe(4);
    expect(MESH_BEACON_MESSAGE_MAX_BYTES).toBe(100);
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

  it('keeps a real UNSET(0) offer region and null optional offer preset', () => {
    const parsed = parseMeshBeaconConfig({ broadcastOfferRegion: 0 });
    expect(parsed.broadcastOfferRegion).toBe(0);
    expect(parsed.broadcastOfferPreset).toBeNull();
  });

  it('distinguishes offer preset 0 (present) from absent (null)', () => {
    expect(parseMeshBeaconConfig({ broadcastOfferPreset: 0 }).broadcastOfferPreset).toBe(0);
    expect(parseMeshBeaconConfig({}).broadcastOfferPreset).toBeNull();
  });

  it('ignores the removed fields if an old device still sends them', () => {
    const parsed = parseMeshBeaconConfig({
      broadcastSendAsNode: 42,
      broadcastOnRegion: 1,
      broadcastOnPreset: 3,
      broadcastOnChannel: { name: 'gauntlet' },
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('broadcastSendAsNode');
    expect(parsed).not.toHaveProperty('broadcastOnRegion');
    expect(parsed).not.toHaveProperty('broadcastOnPreset');
    expect(parsed).not.toHaveProperty('broadcastOnChannelName');
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
      broadcastOfferChannelName: 'gauntlet',
      broadcastOfferChannelPsk: 'AQ==',
      broadcastOfferRegion: 1,
      broadcastOfferPreset: 6,
      broadcastIntervalSecs: 7200,
      broadcastTargets: [{ preset: 6, region: 1, channelIndex: 2 }],
    };
    const parsed = parseMeshBeaconConfig(buildMeshBeaconConfigPayload(populated));
    expect(parsed.broadcastOfferChannelName).toBe('gauntlet');
    expect(parsed.broadcastOfferChannelPsk).toBe('AQ==');
    expect(parsed.broadcastOfferRegion).toBe(1);
    expect(parsed.broadcastOfferPreset).toBe(6);
    expect(parsed.broadcastIntervalSecs).toBe(7200);
    expect(parsed.broadcastTargets).toEqual([{ preset: 6, region: 1, channelIndex: 2 }]);
  });
});
