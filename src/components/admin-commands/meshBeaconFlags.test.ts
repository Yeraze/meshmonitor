import { describe, it, expect } from 'vitest';
import {
  MESH_BEACON_FLAGS,
  packMeshBeaconFlags,
  unpackMeshBeaconFlags,
  pskToBase64,
} from './useAdminCommandsState';

/**
 * MeshBeaconConfig.flags is a bitfield on the wire but three checkboxes in the
 * UI (#3854). These are the conversions at that boundary — a wrong bit silently
 * enables the wrong half of the module on the device.
 */
describe('MeshBeacon flag packing', () => {
  it('matches the Flags enum values from module_config.proto', () => {
    expect(MESH_BEACON_FLAGS.NONE).toBe(0);
    expect(MESH_BEACON_FLAGS.LISTEN_ENABLED).toBe(1);
    expect(MESH_BEACON_FLAGS.BROADCAST_ENABLED).toBe(2);
    expect(MESH_BEACON_FLAGS.LEGACY_SPLIT).toBe(4);
  });

  it('packs each flag to its own bit', () => {
    expect(packMeshBeaconFlags({ listenEnabled: false, broadcastEnabled: false, legacySplit: false })).toBe(0);
    expect(packMeshBeaconFlags({ listenEnabled: true, broadcastEnabled: false, legacySplit: false })).toBe(1);
    expect(packMeshBeaconFlags({ listenEnabled: false, broadcastEnabled: true, legacySplit: false })).toBe(2);
    expect(packMeshBeaconFlags({ listenEnabled: false, broadcastEnabled: false, legacySplit: true })).toBe(4);
    expect(packMeshBeaconFlags({ listenEnabled: true, broadcastEnabled: true, legacySplit: true })).toBe(7);
  });

  it('unpacks a bitfield back into the three booleans', () => {
    expect(unpackMeshBeaconFlags(0)).toEqual({ listenEnabled: false, broadcastEnabled: false, legacySplit: false });
    expect(unpackMeshBeaconFlags(3)).toEqual({ listenEnabled: true, broadcastEnabled: true, legacySplit: false });
    expect(unpackMeshBeaconFlags(7)).toEqual({ listenEnabled: true, broadcastEnabled: true, legacySplit: true });
  });

  it('treats an omitted flags field as all-off', () => {
    // Proto3 omits a zero bitfield entirely, so an all-default beacon module
    // arrives with `flags` undefined rather than 0.
    expect(unpackMeshBeaconFlags(undefined)).toEqual({
      listenEnabled: false,
      broadcastEnabled: false,
      legacySplit: false,
    });
  });

  it('ignores unknown high bits rather than dropping known ones', () => {
    // A future firmware flag must not clear the ones we do understand.
    expect(unpackMeshBeaconFlags(0b1000_0001)).toEqual({
      listenEnabled: true,
      broadcastEnabled: false,
      legacySplit: false,
    });
  });

  it('round-trips every combination', () => {
    for (let flags = 0; flags <= 7; flags++) {
      expect(packMeshBeaconFlags(unpackMeshBeaconFlags(flags))).toBe(flags);
    }
  });
});

describe('pskToBase64', () => {
  it('passes through a string unchanged', () => {
    expect(pskToBase64('AQ==')).toBe('AQ==');
  });

  it('returns empty for absent input', () => {
    expect(pskToBase64(undefined)).toBe('');
    expect(pskToBase64(null)).toBe('');
    expect(pskToBase64('')).toBe('');
  });

  it('encodes a Uint8Array', () => {
    expect(pskToBase64(new Uint8Array([1]))).toBe('AQ==');
  });

  it('encodes a plain byte array', () => {
    expect(pskToBase64([1])).toBe('AQ==');
  });

  it('encodes a JSON-serialised Uint8Array in index order', () => {
    // JSON.stringify(new Uint8Array([1,2,3])) → {"0":1,"1":2,"2":3}
    expect(pskToBase64({ '0': 1, '1': 2, '2': 3 })).toBe(btoa('\x01\x02\x03'));
  });

  it('orders numeric keys numerically, not lexicographically', () => {
    // 10 sorts before 2 as a string; getting this wrong scrambles long PSKs.
    const bytes = Array.from({ length: 12 }, (_, i) => i + 1);
    const obj: Record<string, number> = {};
    bytes.forEach((b, i) => { obj[String(i)] = b; });
    expect(pskToBase64(obj)).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it('encodes a JSON-serialised Buffer', () => {
    expect(pskToBase64({ type: 'Buffer', data: [1, 2, 3] })).toBe(btoa('\x01\x02\x03'));
  });

  it('returns empty rather than throwing on malformed bytes', () => {
    // A bad PSK should render as blank, not break the whole config load.
    expect(pskToBase64({ '0': 999 })).toBe('');
    expect(pskToBase64({ nope: 'x' })).toBe('');
  });
});
